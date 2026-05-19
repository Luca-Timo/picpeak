/**
 * Admin → Dev tools
 *
 * Internal-use endpoints surfaced via the "Development" sub-tab
 * under Clients. Strictly gated behind:
 *   - admin auth + `settings.edit` permission
 *   - the `crmDevelopment` feature flag (defense-in-depth — the
 *     frontend hides the tab when off, this check stops API
 *     callers from poking endpoints that aren't supposed to fire)
 *
 * Currently exposes:
 *   POST /send-test-email   queue any CRM email template to the
 *                           currently-logged-in admin's mailbox,
 *                           with mock data (real PDF attached when
 *                           the install has at least one matching
 *                           record on file, otherwise just the
 *                           text body)
 */

const express = require('express');
const { body } = require('express-validator');
const path = require('path');
const fs = require('fs');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { db } = require('../database/db');
const emailProcessor = require('../services/emailProcessor');
const quoteService = require('../services/quoteService');
const invoiceService = require('../services/invoiceService');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

const router = express.Router();

router.use(adminAuth);

/**
 * Gate every endpoint below the crmDevelopment feature flag.
 * Mirrors the parent /admin/clients/development route guard.
 */
router.use(handleAsync(async (req, res, next) => {
  const row = await db('feature_flags').where({ key: 'crmDevelopment' }).first();
  const enabled = row && (row.value === true || row.value === 1 || row.value === '1');
  if (!enabled) {
    return res.status(403).json({
      error: 'CRM development tools are disabled',
      code: 'CRM_DEV_DISABLED',
    });
  }
  next();
}));

const TEMPLATES_KEYS = [
  'quote_sent',
  'quote_accepted_customer',
  'quote_accepted_admin',
  'quote_declined_admin',
  'invoice_sent',
  'invoice_reminder_first',
  'invoice_reminder_second',
  'invoice_payment_check_admin',
  // Contracts (migration 130). contract_fully_signed lands in a later
  // commit alongside the dual-party send; the dev tester just exercises
  // the two templates that already exist.
  'contract_sent',
  'contract_signed_admin_notification',
  'contract_fully_signed',
];

router.get(
  '/email-templates',
  requirePermission('settings.edit'),
  handleAsync(async (_req, res) => {
    // Return the keys + whether each template exists in the DB so
    // the UI can grey out missing ones (e.g. on an install that
    // hasn't run migration 116 yet).
    const rows = await db('email_templates')
      .whereIn('template_key', TEMPLATES_KEYS)
      .select('template_key');
    const present = new Set(rows.map((r) => r.template_key));
    return successResponse(res, {
      templates: TEMPLATES_KEYS.map((k) => ({ key: k, present: present.has(k) })),
    });
  })
);

const FRONTEND_URL_FALLBACK = 'https://app.example.com';

function fakeMoney(major, currency, locale = 'de') {
  return new Intl.NumberFormat(locale === 'de' ? 'de-CH' : 'en-GB', {
    style: 'currency', currency: (currency || 'CHF').toUpperCase(),
  }).format(major);
}
function fakeShortDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

/**
 * For attachment-bearing templates, render a real PDF from the most
 * recent matching record if any exists. Returns null when nothing
 * usable is on file — caller drops the attachment and queues the
 * email body only.
 */
async function renderSampleQuotePdfPath(adminId) {
  const quote = await db('quotes').orderBy('id', 'desc').first();
  if (!quote) return null;
  try {
    const buffer = await quoteService.renderQuotePdfBuffer(quote.id);
    const dir = path.join(process.cwd(), 'storage', 'business-docs', 'dev-test');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `quote-sample-${adminId}-${Date.now()}.pdf`);
    fs.writeFileSync(filePath, buffer);
    return { path: filePath, filename: `${quote.quote_number}-sample.pdf` };
  } catch (err) {
    logger.warn('dev send-test-email: quote PDF render failed', { err: err.message });
    return null;
  }
}
async function renderSampleInvoicePdfPath(adminId) {
  const invoice = await db('invoices').orderBy('id', 'desc').first();
  if (!invoice) return null;
  try {
    const buffer = await invoiceService.renderInvoicePdfBuffer(invoice.id);
    const dir = path.join(process.cwd(), 'storage', 'business-docs', 'dev-test');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `invoice-sample-${adminId}-${Date.now()}.pdf`);
    fs.writeFileSync(filePath, buffer);
    return { path: filePath, filename: `${invoice.invoice_number}-sample.pdf` };
  } catch (err) {
    logger.warn('dev send-test-email: invoice PDF render failed', { err: err.message });
    return null;
  }
}

async function renderSampleContractPdfPath(adminId) {
  if (!(await db.schema.hasTable('contracts'))) return null;
  const contract = await db('contracts').orderBy('id', 'desc').first();
  if (!contract) return null;
  try {
    const contractService = require('../services/contractService');
    const buffer = await contractService.renderContractPdfBuffer(contract.id);
    const dir = path.join(process.cwd(), 'storage', 'business-docs', 'dev-test');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `contract-sample-${adminId}-${Date.now()}.pdf`);
    fs.writeFileSync(filePath, buffer);
    return { path: filePath, filename: `${contract.contract_number}-sample.pdf` };
  } catch (err) {
    logger.warn('dev send-test-email: contract PDF render failed', { err: err.message });
    return null;
  }
}

/**
 * Build a payload tailored to each template. All variables map back
 * to the `{{tokens}}` the seeded templates reference, so the email
 * the admin sees is identical to what the real flow would send.
 */
async function buildPayloadFor(key, adminId, frontendUrl) {
  const dummyToken = 'dev-test-token-' + Math.random().toString(16).slice(2, 12).padEnd(64, '0').slice(0, 64);
  const total = 1234.56;
  const lateFee = 25.00;
  const today = new Date();
  const dueDate = new Date(today.getTime() - 5 * 86400000);
  const validUntil = new Date(today.getTime() + 14 * 86400000);

  const common = {
    customer_name: 'Test Customer',
    customer_email: 'test.customer@example.com',
    event_name: 'Sample Event',
    invoice_number: 'R-DEV-0001',
    quote_number: 'Q-DEV-0001',
    total_amount: fakeMoney(total, 'CHF'),
    new_total_amount: fakeMoney(total + lateFee, 'CHF'),
    late_fee_amount: fakeMoney(lateFee, 'CHF'),
    late_fee_due: true,
    due_date: fakeShortDate(dueDate),
    valid_until: fakeShortDate(validUntil),
    days_overdue: 5,
    installment_label: 'Anzahlung',
    installment_index: 1,
    installment_total: 2,
    admin_dashboard_url: `${frontendUrl}/admin/clients/bills`,
    response_url: `${frontendUrl}/quote/${dummyToken}`,
    accept_url:   `${frontendUrl}/quote/${dummyToken}?action=accept`,
    decline_url:  `${frontendUrl}/quote/${dummyToken}?action=decline`,
    paid_url:     `${frontendUrl}/payment-check/${dummyToken}?action=paid_full`,
    partial_url:  `${frontendUrl}/payment-check/${dummyToken}?action=partial`,
    unpaid_url:   `${frontendUrl}/payment-check/${dummyToken}?action=unpaid`,
    accepted_on_behalf: true,
    // Contract-specific variables. Title + contract_number stand in
    // for the matching {{tokens}} in the seeded contract templates.
    contract_number: 'C-DEV-0001',
    title: 'Wedding contract — Doe / Müller (sample)',
    signed_customer_name: 'Test Customer',
  };

  // Templates with PDF attachments get a real recent record's PDF
  // when one exists; otherwise the email goes out without
  // attachments (still functionally readable).
  let attachments;
  if (key === 'quote_sent' || key === 'quote_accepted_customer') {
    const pdf = await renderSampleQuotePdfPath(adminId);
    if (pdf) attachments = [{ filename: pdf.filename, contentPath: pdf.path, contentType: 'application/pdf' }];
  } else if (key === 'invoice_sent' || key === 'invoice_reminder_first' || key === 'invoice_reminder_second') {
    const pdf = await renderSampleInvoicePdfPath(adminId);
    if (pdf) attachments = [{ filename: pdf.filename, contentPath: pdf.path, contentType: 'application/pdf' }];
  } else if (key === 'contract_sent' || key === 'contract_fully_signed') {
    const pdf = await renderSampleContractPdfPath(adminId);
    if (pdf) attachments = [{ filename: pdf.filename, contentPath: pdf.path, contentType: 'application/pdf' }];
  }

  return attachments ? { ...common, attachments } : common;
}

router.post(
  '/send-test-email',
  requirePermission('settings.edit'),
  [body('templateKey').isString().isIn(TEMPLATES_KEYS)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const admin = await db('admin_users').where({ id: req.admin.id }).first();
    if (!admin?.email) throw new AppError('Logged-in admin has no email on file', 400);

    const template = await db('email_templates')
      .where({ template_key: req.body.templateKey }).first();
    if (!template) {
      throw new AppError(`Template "${req.body.templateKey}" not seeded yet — run migrations`, 409, 'TEMPLATE_MISSING');
    }

    const frontendUrl = (process.env.FRONTEND_URL || FRONTEND_URL_FALLBACK).replace(/\/$/, '');
    const payload = await buildPayloadFor(req.body.templateKey, req.admin.id, frontendUrl);

    await emailProcessor.queueEmail(null, admin.email, req.body.templateKey, payload);

    return successResponse(res, {
      sent: true,
      to: admin.email,
      template: req.body.templateKey,
    }, 200, 'Test email queued');
  })
);

module.exports = router;
