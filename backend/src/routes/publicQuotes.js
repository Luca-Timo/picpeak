/**
 * Public → Quotes Routes
 *
 * Mounted at /api/public/quotes. NO authentication — the link in the
 * customer email is the only secret. The route layer must:
 *   - never leak admin-only fields (internal_notes, etc.)
 *   - rate-limit by IP/token to soften brute-force token guessing
 *   - honour the 15-min re-toggle window enforced at the service layer
 *
 * Surface:
 *   GET  /:token              read-only quote view for the customer
 *   POST /:token/respond      body: { action: 'accept' | 'decline' }
 */

const express = require('express');
const { body, param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const quoteService = require('../services/quoteService');
const { db } = require('../database/db');

const router = express.Router();

// Rate-limit: 30 token previews per IP per minute, 10 responses.
const previewLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
});
const respondLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
});

function publicQuoteView(quote, lineItems, customer, profile, tosRequired, tosText, tosUrl) {
  return {
    quoteNumber: quote.quote_number,
    status: quote.status,
    language: quote.language,
    currency: quote.currency,
    issueDate: quote.issue_date,
    validUntil: quote.valid_until,
    eventName: quote.event_name,
    eventDate: quote.event_date,
    eventTimeStart: quote.event_time_start,
    eventTimeEnd: quote.event_time_end,
    introText: quote.intro_text,
    outroText: quote.outro_text,
    // Money — public surface.
    netAmountMinor: quote.net_amount_minor,
    vatRate: quote.vat_rate == null ? null : Number(quote.vat_rate),
    vatAmountMinor: quote.vat_amount_minor,
    shippingAmountMinor: quote.shipping_amount_minor,
    totalAmountMinor: quote.total_amount_minor,
    // Response state — drives the page UI.
    respondedAt: quote.responded_at,
    responseLockedAt: quote.response_locked_at,
    canRespond: !!(quote.status === 'sent' || (
      quote.responded_at && quote.response_locked_at &&
      new Date(quote.response_locked_at).getTime() > Date.now()
    )),
    lineItems: lineItems.map((li) => ({
      position: li.position,
      quantity: Number(li.quantity),
      description: li.description,
      unitPriceMinor: li.unit_price_minor,
      discountPercent: li.discount_percent == null ? 0 : Number(li.discount_percent),
      lineTotalMinor: li.line_total_minor,
    })),
    recipient: customer ? {
      displayName: customer.display_name || [customer.first_name, customer.last_name].filter(Boolean).join(' '),
      email: customer.email,
      companyName: customer.company_name,
    } : null,
    // Terms of Service surfaced to the customer when the global
    // `crm_quotes_tos_required` flag is on. The text + URL are
    // included unconditionally so admins can opt to display them
    // without blocking acceptance; the frontend gates the checkbox.
    // Snapshot is rendered when the quote has already been accepted
    // so the customer sees exactly what they agreed to, not the
    // current ToS text (which may have changed).
    tos: {
      required: tosRequired === true,
      text: quote.tos_text_snapshot || tosText || '',
      url: tosUrl || '',
      acceptedAt: quote.tos_accepted_at || null,
    },
    issuer: profile ? {
      companyName: profile.company_name,
      email: profile.email,
      website: profile.website,
      footerLine: profile.footer_line,
      // Expose the logo as a public URL — frontend renders it at the
      // top of the response page so the customer sees the same
      // letterhead as the PDF. The branding upload route writes
      // under storage/uploads/, which is served by app.use('/uploads',
      // …) in server.js. We accept either a bare filename or a path
      // and normalise it onto /uploads/.
      logoUrl: profile.logo_path
        ? (profile.logo_path.startsWith('/') || /^https?:\/\//i.test(profile.logo_path)
            ? profile.logo_path
            : `/uploads/${profile.logo_path.replace(/^uploads\//, '')}`)
        : null,
    } : null,
  };
}

router.get(
  '/:token',
  previewLimiter,
  [param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = await db('quote_action_tokens').where({ token: req.params.token }).first();
    if (!tokenRow) return res.status(404).json({ error: 'Quote not found' });
    if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'This link has expired' });
    }
    const data = await quoteService.getQuoteById(tokenRow.quote_id);
    if (!data) return res.status(404).json({ error: 'Quote not found' });

    const customer = await db('customer_accounts').where({ id: data.quote.customer_account_id }).first();
    const businessProfileService = require('../services/businessProfileService');
    const { profile } = await businessProfileService.getProfile();
    // Pull the three ToS keys via the shared helper so it works
    // regardless of how setting_value is encoded (JSON-stringified vs
    // raw). All three are optional.
    const { getAppSetting } = require('../utils/appSettings');
    const tosRequired = await getAppSetting('crm_quotes_tos_required', false);
    const tosText = await getAppSetting('crm_quotes_tos_text', '');
    const tosUrl = await getAppSetting('crm_quotes_tos_url', '');

    return successResponse(res, {
      quote: publicQuoteView(data.quote, data.lineItems, customer, profile, tosRequired, tosText, tosUrl),
    });
  })
);

router.post(
  '/:token/respond',
  respondLimiter,
  [
    param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i),
    body('action').isIn(['accept', 'decline']),
    // ToS box: optional flag, only meaningful when the global
    // `crm_quotes_tos_required` setting is on. Service enforces.
    body('tosAccepted').optional().isBoolean(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    try {
      const ip = req.ip || req.headers['x-forwarded-for'] || null;
      const result = await quoteService.recordResponse({
        token: req.params.token,
        action: req.body.action,
        ip,
        tosAccepted: req.body.tosAccepted === true,
      });
      return successResponse(res, { status: result.status, lockedAt: result.lockedAt });
    } catch (err) {
      if (err.code === 'RESPONSE_LOCKED') {
        return res.status(423).json({
          error: err.message,
          code: 'RESPONSE_LOCKED',
          currentStatus: err.currentStatus,
          lockedAt: err.lockedAt,
        });
      }
      throw err;
    }
  })
);

module.exports = router;
