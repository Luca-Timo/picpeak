/**
 * quoteService — orchestrates the lifecycle of `quotes`, their
 * `quote_line_items`, and the public `quote_action_tokens` used by the
 * accept/decline link in the customer email.
 *
 * Mirrors the layered shape of customerAccountsService: pure functions
 * doing one thing each, with a small set of transformation helpers at
 * the top. Routes (adminQuotes.js / publicQuotes.js) stay thin.
 *
 * Money is stored as INTEGER minor units (cents/Rappen). The service
 * re-computes line totals + net/vat/total on save, never trusting the
 * payload — the editor sends a hint for live UX, the server is the
 * source of truth.
 *
 * Statuses (`quotes.status`):
 *   draft     freshly created or edited after send; not visible publicly
 *   sent      emailed to customer; public token live
 *   accepted  customer accepted; ready to convert to event
 *   declined  customer declined; admin can resend after edits
 *   expired   valid_until passed without a response (set by the scheduler)
 *   converted accepted + event created from it
 *
 * Per-customer feature override: when `customer_accounts.feature_quotes`
 * is false (toggled by admin on the customer detail page) the service
 * refuses to create / send / convert quotes for that customer. Admins
 * can still view existing rows for audit.
 */

const crypto = require('crypto');
const { db, withRetry, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');
const { AppError } = require('../utils/errors');
const { formatBoolean } = require('../utils/dbCompat');
const businessProfileService = require('./businessProfileService');
const pdfService = require('./pdfService');
const emailProcessor = require('./emailProcessor');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const fs = require('fs');
const path = require('path');

const VALID_QUOTE_TRANSITIONS = {
  draft: new Set(['sent', 'declined']),
  sent: new Set(['draft', 'accepted', 'declined', 'expired']),
  accepted: new Set(['converted', 'declined']),
  declined: new Set(['draft', 'accepted']),
  expired: new Set(['draft']),
  converted: new Set([]),
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function ensureInt(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return 0;
  return n;
}

function ensureNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Compute line totals + document totals authoritatively from the
 * supplied line items + VAT rate. Returns BigInt-safe integers (minor
 * units). Discount is applied before VAT.
 */
function computeTotals(lineItems, vatRate, shippingAmountMinor = 0) {
  let netMinor = 0;
  const out = [];
  for (const li of lineItems) {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = Math.max(0, Math.min(100, ensureNumber(li.discount_percent, 0)));
    const rawLineMinor = Math.round(qty * unit);
    const discountedMinor = Math.round(rawLineMinor * (1 - discount / 100));
    netMinor += discountedMinor;
    out.push({
      ...li,
      line_total_minor: discountedMinor,
    });
  }
  const vatPercent = ensureNumber(vatRate, 0);
  const vatMinor = Math.round(netMinor * vatPercent / 100);
  const shipping = ensureInt(shippingAmountMinor);
  const totalMinor = netMinor + vatMinor + shipping;
  return {
    netAmountMinor: netMinor,
    vatAmountMinor: vatMinor,
    shippingAmountMinor: shipping,
    totalAmountMinor: totalMinor,
    lineItems: out,
  };
}

function formatNumberInTemplate(format, year, seq) {
  // Tokens: {YEAR}, {MONTH}, {SEQ:04d}. Defaults handle padding via
  // a tiny formatter, kept inline to avoid a new dependency.
  return format
    .replace(/\{YEAR\}/g, String(year))
    .replace(/\{MONTH\}/g, String(new Date().getMonth() + 1).padStart(2, '0'))
    .replace(/\{SEQ:(\d+)d\}/g, (_, pad) => String(seq).padStart(parseInt(pad, 10), '0'))
    .replace(/\{SEQ\}/g, String(seq));
}

async function nextQuoteNumber() {
  const format = (await getAppSetting('crm_quotes_number_format')) || 'Q-{YEAR}-{SEQ:04d}';
  const year = new Date().getFullYear();
  // Find the highest existing seq for this year + base prefix. Loop on
  // unique-key collisions (concurrent admins) up to 5 times.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const yearPrefix = formatNumberInTemplate(format, year, 0).slice(0, -4);
    const rows = await db('quotes')
      .where('quote_number', 'like', `${yearPrefix}%`)
      .select('quote_number');
    let maxSeq = 0;
    for (const r of rows) {
      const m = r.quote_number.match(/(\d+)\s*$/);
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
    }
    const candidate = formatNumberInTemplate(format, year, maxSeq + 1);
    const exists = await db('quotes').where({ quote_number: candidate }).first();
    if (!exists) return candidate;
  }
  // Fall back to a UUID-suffixed number — guaranteed unique. Should
  // basically never trigger.
  return `Q-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function ensureCustomerFeatureEnabled(customer, feature) {
  // Global toggle (`customer_feature_quotes_enabled` / `..._bills_enabled`)
  // is checked at the route layer (feature flag); here we only enforce
  // the per-customer override.
  if (!customer) {
    throw new AppError('Customer not found', 404);
  }
  if (customer.is_active === false || customer.is_active === 0) {
    throw new AppError('Customer is deactivated', 409);
  }
  const flagField = feature === 'quotes' ? 'feature_quotes' : 'feature_bills';
  const flagValue = customer[flagField];
  if (flagValue === false || flagValue === 0 || flagValue === '0') {
    throw new AppError(`This customer has ${feature} disabled`, 409, 'CUSTOMER_FEATURE_DISABLED');
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * List quotes with filter + sort + pagination support. Returns a flat
 * list (transformed by the route layer); pagination metadata is in the
 * wrapper.
 *
 * Filters: { status[], customerAccountId, from, to, q }
 * Sort:    'newest' | 'oldest' | 'customer_asc' | 'value_asc' | 'value_desc'
 */
async function listQuotes({ filters = {}, sort = 'newest', page = 1, pageSize = 25 } = {}) {
  return await withRetry(async () => {
    let query = db('quotes')
      .leftJoin('customer_accounts', 'quotes.customer_account_id', 'customer_accounts.id')
      .select(
        'quotes.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
      );

    if (Array.isArray(filters.status) && filters.status.length > 0) {
      query = query.whereIn('quotes.status', filters.status);
    }
    if (filters.customerAccountId) {
      query = query.where('quotes.customer_account_id', filters.customerAccountId);
    }
    if (filters.from) {
      query = query.where('quotes.issue_date', '>=', filters.from);
    }
    if (filters.to) {
      query = query.where('quotes.issue_date', '<=', filters.to);
    }
    if (filters.q && String(filters.q).trim()) {
      const term = `%${String(filters.q).trim()}%`;
      query = query.andWhere(function() {
        this.where('quotes.quote_number', 'like', term)
          .orWhere('quotes.event_name', 'like', term)
          .orWhere('customer_accounts.email', 'like', term)
          .orWhere('customer_accounts.company_name', 'like', term);
      });
    }

    // Total before pagination.
    const countQuery = query.clone().clearSelect().clearOrder().count('quotes.id as total').first();
    const totalRow = await countQuery;
    const total = ensureInt(totalRow?.total || 0);

    switch (sort) {
      case 'oldest':
        query = query.orderBy('quotes.issue_date', 'asc').orderBy('quotes.id', 'asc');
        break;
      case 'customer_asc':
        query = query
          .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) asc')
          .orderBy('quotes.id', 'desc');
        break;
      case 'value_asc':
        query = query.orderBy('quotes.total_amount_minor', 'asc');
        break;
      case 'value_desc':
        query = query.orderBy('quotes.total_amount_minor', 'desc');
        break;
      case 'newest':
      default:
        query = query.orderBy('quotes.issue_date', 'desc').orderBy('quotes.id', 'desc');
        break;
    }

    const offset = Math.max(0, (page - 1) * pageSize);
    query = query.offset(offset).limit(pageSize);
    const rows = await query;
    return { rows, total, page, pageSize };
  });
}

async function getQuoteById(id) {
  return await withRetry(async () => {
    // LEFT JOIN customer_accounts so transformQuote (which reads
    // q.customer_email / q.customer_display_name etc.) has populated
    // fields. Without this the API returns nulls for the recipient
    // block and the editor shows "undefined undefined" in its summary.
    const quote = await db('quotes')
      .leftJoin('customer_accounts', 'quotes.customer_account_id', 'customer_accounts.id')
      .where('quotes.id', id)
      .select(
        'quotes.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
      )
      .first();
    if (!quote) return null;
    const lineItems = await db('quote_line_items')
      .where({ quote_id: id })
      .orderBy('position', 'asc');
    return { quote, lineItems };
  });
}

/**
 * Create a quote. Validates the customer + recomputes totals.
 * Returns the new quote id.
 */
async function createQuote(payload, adminId) {
  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  ensureCustomerFeatureEnabled(customer, 'quotes');

  const profile = (await businessProfileService.getProfile()).profile;
  const currency = (payload.currency || profile?.default_currency || 'CHF').toUpperCase();
  const language = payload.language || customer.preferred_language || profile?.default_locale || 'de';

  const validDays = ensureInt(await getAppSetting('crm_quotes_default_valid_days')) || 30;
  const issueDate = payload.issueDate || new Date().toISOString().slice(0, 10);
  const validUntil = payload.validUntil || new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  // Authoritative totals.
  const totals = computeTotals(
    Array.isArray(payload.lineItems) ? payload.lineItems : [],
    payload.vatRate,
    payload.shippingAmountMinor
  );

  // Resolve bank account for the chosen currency.
  const bank = await businessProfileService.resolveBankAccountForCurrency(currency, payload.businessBankAccountId);

  return await db.transaction(async (trx) => {
    const quoteNumber = await nextQuoteNumber();
    const row = {
      quote_number: quoteNumber,
      customer_account_id: payload.customerAccountId,
      status: 'draft',
      language,
      currency,
      issue_date: issueDate,
      valid_until: validUntil,
      event_name: payload.eventName || null,
      event_date: payload.eventDate || null,
      event_time_start: payload.eventTimeStart || null,
      event_time_end: payload.eventTimeEnd || null,
      expected_duration_hours: payload.expectedDurationHours == null ? null : ensureNumber(payload.expectedDurationHours),
      payment_term_template_id: payload.paymentTermTemplateId || null,
      net_amount_minor: totals.netAmountMinor,
      vat_rate: ensureNumber(payload.vatRate, 0),
      vat_amount_minor: totals.vatAmountMinor,
      shipping_amount_minor: totals.shippingAmountMinor,
      total_amount_minor: totals.totalAmountMinor,
      intro_text: payload.introText || null,
      outro_text: payload.outroText || null,
      internal_notes: payload.internalNotes || null,
      cc_pdf_email: payload.ccPdfEmail || null,
      business_bank_account_id: bank?.id || null,
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const inserted = await trx('quotes').insert(row).returning('id');
    const quoteId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    if (totals.lineItems.length > 0) {
      await trx('quote_line_items').insert(totals.lineItems.map((li, idx) => ({
        quote_id: quoteId,
        position: ensureInt(li.position) || (idx + 1),
        quantity: ensureNumber(li.quantity, 1),
        description: String(li.description || ''),
        unit_price_minor: ensureInt(li.unit_price_minor),
        discount_percent: ensureNumber(li.discount_percent, 0),
        line_total_minor: li.line_total_minor,
        created_at: new Date(),
        updated_at: new Date(),
      })));
    }

    try {
      await logActivity('quote_created', { quoteId, quoteNumber, customerAccountId: payload.customerAccountId }, null, `admin:${adminId}`);
    } catch (_) {}

    logger.info('Quote created', { adminId, quoteId, quoteNumber });
    return quoteId;
  });
}

/**
 * Update a quote (line items + scalar fields). Editing a `sent` quote
 * reverts it to draft so a fresh send is required to push the change.
 */
async function updateQuote(id, payload, adminId) {
  const existing = await db('quotes').where({ id }).first();
  if (!existing) {
    throw new AppError('Quote not found', 404);
  }
  if (existing.status === 'converted') {
    throw new AppError('Cannot edit a converted quote', 409);
  }

  const totals = computeTotals(
    Array.isArray(payload.lineItems) ? payload.lineItems : [],
    payload.vatRate ?? existing.vat_rate,
    payload.shippingAmountMinor ?? existing.shipping_amount_minor
  );

  return await db.transaction(async (trx) => {
    const updates = {
      updated_at: new Date(),
      net_amount_minor: totals.netAmountMinor,
      vat_amount_minor: totals.vatAmountMinor,
      shipping_amount_minor: totals.shippingAmountMinor,
      total_amount_minor: totals.totalAmountMinor,
      vat_rate: ensureNumber(payload.vatRate ?? existing.vat_rate, 0),
    };
    // Revert sent → draft on edit so the admin must explicitly resend.
    if (existing.status === 'sent') updates.status = 'draft';
    const map = {
      eventName: 'event_name',
      eventDate: 'event_date',
      eventTimeStart: 'event_time_start',
      eventTimeEnd: 'event_time_end',
      expectedDurationHours: 'expected_duration_hours',
      paymentTermTemplateId: 'payment_term_template_id',
      introText: 'intro_text',
      outroText: 'outro_text',
      internalNotes: 'internal_notes',
      ccPdfEmail: 'cc_pdf_email',
      businessBankAccountId: 'business_bank_account_id',
      validUntil: 'valid_until',
      language: 'language',
    };
    for (const [api, col] of Object.entries(map)) {
      if (Object.prototype.hasOwnProperty.call(payload, api)) {
        updates[col] = payload[api];
      }
    }
    await trx('quotes').where({ id }).update(updates);

    await trx('quote_line_items').where({ quote_id: id }).del();
    if (totals.lineItems.length > 0) {
      await trx('quote_line_items').insert(totals.lineItems.map((li, idx) => ({
        quote_id: id,
        position: ensureInt(li.position) || (idx + 1),
        quantity: ensureNumber(li.quantity, 1),
        description: String(li.description || ''),
        unit_price_minor: ensureInt(li.unit_price_minor),
        discount_percent: ensureNumber(li.discount_percent, 0),
        line_total_minor: li.line_total_minor,
        created_at: new Date(),
        updated_at: new Date(),
      })));
    }

    try {
      await logActivity('quote_updated', { quoteId: id }, null, `admin:${adminId}`);
    } catch (_) {}
  });
}

/**
 * Build the renderer context object from the quote + DB lookups. Shared
 * by sendQuote (where we persist the PDF) and previewQuote* (where we
 * just return the buffer to the admin).
 */
async function buildRenderContext(quote, lineItems) {
  const { profile } = await businessProfileService.getProfile();
  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  const bank = quote.business_bank_account_id
    ? await db('business_bank_accounts').where({ id: quote.business_bank_account_id }).first()
    : await businessProfileService.resolveBankAccountForCurrency(quote.currency);
  const paymentTerm = quote.payment_term_template_id
    ? await db('payment_term_templates').where({ id: quote.payment_term_template_id }).first()
    : null;

  return {
    locale: quote.language || profile?.default_locale || 'de',
    currency: quote.currency,
    qrFormat: 'none', // quotes never carry a Swiss QR-bill
    issuer: profile ? {
      companyName: profile.company_name,
      addressLine1: profile.address_line1,
      addressLine2: profile.address_line2,
      postalCode: profile.postal_code,
      city: profile.city,
      state: profile.state,
      countryCode: profile.country_code,
      phone: profile.phone,
      mobile: profile.mobile,
      email: profile.email,
      website: profile.website,
      footerLine: profile.footer_line,
      vatId: profile.vat_id,
      // PDF renderer resolves this relative to the storage/ root.
      logoPath: profile.logo_path,
    } : {},
    recipient: {
      issuerLine: profile?.company_name
        ? `${profile.company_name} * ${profile.address_line1 || ''} * ${profile.postal_code || ''} ${profile.city || ''}`
        : '',
      companyName: customer?.company_name || customer?.display_name || customer?.email,
      attentionLine: customer?.salutation || customer?.first_name
        ? `z. Hd. ${[customer.first_name, customer.last_name].filter(Boolean).join(' ')}`
        : '',
      addressLine1: customer?.address_line1,
      addressLine2: customer?.address_line2,
      postalCode: customer?.postal_code,
      city: customer?.city,
      country: customer?.country_code,
      countryCodeIso: customer?.country_code,
    },
    bank: bank ? {
      accountHolder: bank.account_holder || profile?.company_name,
      iban: bank.iban,
      bic: bank.bic,
      currency: bank.currency,
    } : null,
    paymentTerm: paymentTerm ? {
      description: paymentTerm.description,
      netDays: paymentTerm.net_days,
      skontoPercent: paymentTerm.skonto_percent,
      skontoWithinDays: paymentTerm.skonto_within_days,
    } : null,
    lineItems: lineItems.map((li) => ({
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: li.unit_price_minor,
      discountPercent: li.discount_percent,
      lineTotalMinor: li.line_total_minor,
    })),
    totals: {
      netAmountMinor: quote.net_amount_minor,
      vatRate: quote.vat_rate,
      vatAmountMinor: quote.vat_amount_minor,
      shippingAmountMinor: quote.shipping_amount_minor,
      totalAmountMinor: quote.total_amount_minor,
    },
    doc: {
      quoteNumber: quote.quote_number,
      issueDate: quote.issue_date,
      validUntil: quote.valid_until,
      introText: quote.intro_text,
      outroText: quote.outro_text,
      totalAmountMinor: quote.total_amount_minor,
    },
  };
}

async function renderQuotePdfBuffer(quoteId) {
  const data = await getQuoteById(quoteId);
  if (!data) throw new AppError('Quote not found', 404);
  const ctx = await buildRenderContext(data.quote, data.lineItems);
  return await pdfService.renderQuoteToBuffer(ctx);
}

/**
 * Preview a quote PDF from an unsaved payload — never touches the DB.
 * The frontend "Preview" button on the editor calls this with the
 * current form state so the admin can validate before saving.
 */
async function renderQuotePdfFromPayload(payload) {
  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  const totals = computeTotals(
    Array.isArray(payload.lineItems) ? payload.lineItems : [],
    payload.vatRate,
    payload.shippingAmountMinor
  );
  const fakeQuote = {
    quote_number: 'PREVIEW',
    customer_account_id: payload.customerAccountId,
    language: payload.language || customer?.preferred_language || 'de',
    currency: (payload.currency || 'CHF').toUpperCase(),
    issue_date: payload.issueDate || new Date().toISOString().slice(0, 10),
    valid_until: payload.validUntil,
    intro_text: payload.introText,
    outro_text: payload.outroText,
    payment_term_template_id: payload.paymentTermTemplateId,
    business_bank_account_id: payload.businessBankAccountId,
    net_amount_minor: totals.netAmountMinor,
    vat_rate: ensureNumber(payload.vatRate, 0),
    vat_amount_minor: totals.vatAmountMinor,
    shipping_amount_minor: totals.shippingAmountMinor,
    total_amount_minor: totals.totalAmountMinor,
  };
  const ctx = await buildRenderContext(fakeQuote, totals.lineItems.map((li) => ({
    quantity: li.quantity,
    description: li.description,
    unit_price_minor: li.unit_price_minor,
    discount_percent: li.discount_percent,
    line_total_minor: li.line_total_minor,
  })));
  return await pdfService.renderQuoteToBuffer(ctx);
}

/**
 * Send a quote: render PDF, persist snapshot, generate accept/decline
 * tokens, queue email. Transitions status draft|declined → sent.
 */
async function sendQuote(id, adminId) {
  const data = await getQuoteById(id);
  if (!data) throw new AppError('Quote not found', 404);
  const { quote, lineItems } = data;

  if (!['draft', 'declined', 'expired'].includes(quote.status)) {
    throw new AppError(`Cannot send a quote with status '${quote.status}'`, 409);
  }

  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  ensureCustomerFeatureEnabled(customer, 'quotes');

  // Render PDF + persist snapshot.
  const ctx = await buildRenderContext(quote, lineItems);
  const buffer = await pdfService.renderQuoteToBuffer(ctx);
  const pdfPath = await persistDocPdf('quote', quote, buffer);

  // Snapshot payment term so future template edits don't mutate the doc.
  const paymentTermSnapshot = quote.payment_term_template_id
    ? (await db('payment_term_templates').where({ id: quote.payment_term_template_id }).first())
    : null;

  // Mint a single shared token; accept and decline are differentiated
  // by the request body. This makes the email link survive a customer
  // changing their mind inside the 15-min window without sending two
  // links.
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = quote.valid_until
    ? new Date(new Date(quote.valid_until).getTime() + 14 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

  await db.transaction(async (trx) => {
    await trx('quote_action_tokens').insert({
      quote_id: id,
      token,
      expires_at: expiresAt,
      created_at: new Date(),
    });
    await trx('quotes').where({ id }).update({
      status: 'sent',
      sent_at: new Date(),
      pdf_path: pdfPath,
      payment_term_snapshot: paymentTermSnapshot ? JSON.stringify(paymentTermSnapshot) : null,
      updated_at: new Date(),
    });
  });

  // Queue customer email (with PDF + cc) — honour the global
  // crm_quotes_pdf_attachment_enabled toggle.
  const attachPdf = await getAppSetting('crm_quotes_pdf_attachment_enabled');
  const frontendUrl = await getFrontendBaseUrl() || 'http://localhost:3000';
  const responseUrl = `${frontendUrl}/quote/${token}`;
  await emailProcessor.queueEmail(null, customer.email, 'quote_sent', {
    quote_number: quote.quote_number,
    customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
    response_url: responseUrl,
    accept_url: `${responseUrl}?action=accept`,
    decline_url: `${responseUrl}?action=decline`,
    valid_until: quote.valid_until || '',
    event_name: quote.event_name || '',
    total_amount: formatMajor(quote.total_amount_minor, quote.currency, ctx.locale),
    cc: quote.cc_pdf_email || undefined,
    attachments: (attachPdf !== false && pdfPath) ? [{
      filename: `${quote.quote_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }] : undefined,
  });

  try {
    await logActivity('quote_sent', { quoteId: id, token }, null, `admin:${adminId}`);
  } catch (_) {}

  logger.info('Quote sent', { adminId, quoteId: id });
  return { token, pdfPath };
}

function formatMajor(minor, currency, locale) {
  return new Intl.NumberFormat(locale === 'de' ? 'de-CH' : 'en-GB', {
    style: 'currency', currency: (currency || 'CHF').toUpperCase(),
  }).format(Number(minor || 0) / 100);
}

/**
 * Persist a rendered PDF under storage/business-docs/quote/<YEAR>/<NUMBER>.pdf
 */
async function persistDocPdf(type, doc, buffer) {
  const number = doc.quote_number || doc.invoice_number;
  if (!number) return null;
  const year = (doc.issue_date ? new Date(doc.issue_date) : new Date()).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', type, String(year));
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, `${number}.pdf`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Record a customer response from the public accept/decline link.
 *
 * 15-min toggle rule: the first response opens a window equal to
 * crm_quotes_accept_window_minutes (default 15). Within that window
 * the same token may flip accept↔decline. After the window expires the
 * response is locked.
 */
async function recordResponse({ token, action, ip }) {
  if (!['accept', 'decline'].includes(action)) {
    throw new AppError('Invalid action', 400);
  }
  const tokenRow = await db('quote_action_tokens').where({ token }).first();
  if (!tokenRow) {
    throw new AppError('Token not found', 404);
  }
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
    throw new AppError('Token expired', 410);
  }

  const quote = await db('quotes').where({ id: tokenRow.quote_id }).first();
  if (!quote) {
    throw new AppError('Quote not found', 404);
  }
  if (!['sent', 'accepted', 'declined'].includes(quote.status)) {
    throw new AppError(`Quote cannot be responded to in status '${quote.status}'`, 409);
  }

  const now = new Date();
  const windowMinutes = ensureInt(await getAppSetting('crm_quotes_accept_window_minutes')) || 15;
  // If there's already a response, check if we're inside the toggle window.
  if (quote.responded_at && quote.response_locked_at) {
    if (now.getTime() > new Date(quote.response_locked_at).getTime()) {
      const err = new AppError('Response window has closed', 423, 'RESPONSE_LOCKED');
      err.lockedAt = quote.response_locked_at;
      err.currentStatus = quote.status;
      throw err;
    }
  }

  const isAccept = action === 'accept';
  const newStatus = isAccept ? 'accepted' : 'declined';
  const respondedAt = quote.responded_at || now;
  const responseLockedAt = new Date(new Date(respondedAt).getTime() + windowMinutes * 60 * 1000);

  await db.transaction(async (trx) => {
    await trx('quotes').where({ id: quote.id }).update({
      status: newStatus,
      responded_at: respondedAt,
      response_locked_at: responseLockedAt,
      accepted_at: isAccept ? now : null,
      declined_at: !isAccept ? now : null,
      updated_at: now,
    });
    await trx('quote_action_tokens').where({ id: tokenRow.id }).update({
      used_at: now,
      used_action: newStatus,
      used_ip: ip || null,
    });
  });

  try {
    await logActivity(`quote_${newStatus}`, { quoteId: quote.id, token: tokenRow.token }, null, 'customer:public');
  } catch (_) {}

  return { status: newStatus, lockedAt: responseLockedAt };
}

/**
 * Convert an accepted quote to an event + scheduled invoices.
 * Wraps everything in a transaction so a half-finished conversion
 * doesn't litter the DB.
 *
 * Implementation note: invoice creation delegates to invoiceService —
 * required by Commit 7. We `require` lazily to dodge the circular
 * dependency between quoteService and invoiceService.
 */
async function convertToEvent(quoteId, adminId) {
  const { quote, lineItems } = (await getQuoteById(quoteId)) || {};
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status !== 'accepted') {
    throw new AppError(`Cannot convert a quote with status '${quote.status}'`, 409);
  }
  if (quote.converted_event_id) {
    return { eventId: quote.converted_event_id, alreadyConverted: true };
  }

  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  ensureCustomerFeatureEnabled(customer, 'quotes');

  const paymentTermSnapshot = quote.payment_term_snapshot
    ? (typeof quote.payment_term_snapshot === 'string'
        ? JSON.parse(quote.payment_term_snapshot)
        : quote.payment_term_snapshot)
    : null;

  // Lazy import to avoid the circular dep.
  const invoiceService = require('./invoiceService');

  return await db.transaction(async (trx) => {
    const eventRow = {
      slug: `quote-${quote.quote_number.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`,
      event_name: quote.event_name || `Event ${quote.quote_number}`,
      event_date: quote.event_date || quote.issue_date,
      customer_name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.display_name || customer.company_name,
      customer_email: customer.email,
      customer_phone: customer.phone,
      admin_email: null,
      event_type: 'wedding', // sensible default; admin can change
      is_active: true,
      is_archived: false,
      is_draft: true, // give admin a chance to review before activating
      created_by: adminId,
      quote_id: quote.id,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const inserted = await trx('events').insert(eventRow).returning('id');
    const eventId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Junction row so the customer can already see the event in their
    // dashboard once the admin activates it.
    await trx('event_customer_assignments').insert({
      event_id: eventId,
      customer_account_id: customer.id,
      assigned_by_admin_id: adminId,
      assigned_at: new Date(),
    });

    // Payment-plan glue.
    await trx('event_payment_plans').insert({
      event_id: eventId,
      quote_id: quote.id,
      payment_term_snapshot: JSON.stringify(paymentTermSnapshot || {}),
      created_at: new Date(),
      updated_at: new Date(),
    });

    // Build the invoice schedule from installments.
    const installments = Array.isArray(paymentTermSnapshot?.installments)
      ? paymentTermSnapshot.installments
      : [{ percent: 100, trigger: 'after_delivery', offset_days: 0, label: 'Total' }];

    await invoiceService.scheduleInvoicesForEvent({
      trx,
      eventId,
      quoteId: quote.id,
      customer,
      currency: quote.currency,
      language: quote.language,
      lineItems,
      totals: {
        net: quote.net_amount_minor,
        vatRate: quote.vat_rate,
        vat: quote.vat_amount_minor,
        shipping: quote.shipping_amount_minor,
        total: quote.total_amount_minor,
      },
      installments,
      eventDate: quote.event_date,
      adminId,
      ccPdfEmail: quote.cc_pdf_email,
    });

    await trx('quotes').where({ id: quote.id }).update({
      status: 'converted',
      converted_event_id: eventId,
      updated_at: new Date(),
    });

    try {
      await logActivity('quote_converted', { quoteId: quote.id, eventId }, eventId, `admin:${adminId}`);
    } catch (_) {}

    logger.info('Quote converted to event', { adminId, quoteId: quote.id, eventId });
    return { eventId, alreadyConverted: false };
  });
}

async function duplicateQuote(id, adminId) {
  const { quote, lineItems } = (await getQuoteById(id)) || {};
  if (!quote) throw new AppError('Quote not found', 404);

  return await createQuote({
    customerAccountId: quote.customer_account_id,
    language: quote.language,
    currency: quote.currency,
    eventName: quote.event_name,
    eventDate: quote.event_date,
    eventTimeStart: quote.event_time_start,
    eventTimeEnd: quote.event_time_end,
    expectedDurationHours: quote.expected_duration_hours,
    paymentTermTemplateId: quote.payment_term_template_id,
    vatRate: quote.vat_rate,
    shippingAmountMinor: quote.shipping_amount_minor,
    introText: quote.intro_text,
    outroText: quote.outro_text,
    internalNotes: quote.internal_notes,
    ccPdfEmail: quote.cc_pdf_email,
    businessBankAccountId: quote.business_bank_account_id,
    lineItems: lineItems.map((li) => ({
      position: li.position,
      quantity: li.quantity,
      description: li.description,
      unit_price_minor: li.unit_price_minor,
      discount_percent: li.discount_percent,
    })),
  }, adminId);
}

// ---------------------------------------------------------------------
// Presets (line items + payment terms)
// ---------------------------------------------------------------------

async function listLineItemPresets() {
  return await db('quote_line_item_presets')
    .where({ is_active: formatBoolean(true) })
    .orderBy('display_order', 'asc').orderBy('id', 'asc');
}

async function createLineItemPreset(payload) {
  const row = {
    name: payload.name,
    description: payload.description || '',
    unit_price_minor: ensureInt(payload.unit_price_minor),
    currency: (payload.currency || 'CHF').toUpperCase(),
    quantity_default: ensureNumber(payload.quantity_default, 1),
    display_order: ensureInt(payload.display_order),
    is_active: formatBoolean(true),
    created_at: new Date(),
    updated_at: new Date(),
  };
  const inserted = await db('quote_line_item_presets').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return await db('quote_line_item_presets').where({ id }).first();
}

async function updateLineItemPreset(id, payload) {
  const map = {
    name: 'name', description: 'description', currency: 'currency',
    unit_price_minor: 'unit_price_minor', quantity_default: 'quantity_default',
    display_order: 'display_order', is_active: 'is_active',
  };
  const updates = { updated_at: new Date() };
  for (const [api, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(payload, api)) {
      updates[col] = col === 'is_active' ? formatBoolean(Boolean(payload[api])) : payload[api];
    }
  }
  await db('quote_line_item_presets').where({ id }).update(updates);
  return await db('quote_line_item_presets').where({ id }).first();
}

async function deleteLineItemPreset(id) {
  // Soft delete via is_active = false to preserve historical references.
  await db('quote_line_item_presets').where({ id })
    .update({ is_active: formatBoolean(false), updated_at: new Date() });
  return { deleted: true };
}

async function listPaymentTermTemplates() {
  return await db('payment_term_templates')
    .where({ is_active: formatBoolean(true) })
    .orderBy('display_order', 'asc').orderBy('id', 'asc');
}

async function createPaymentTermTemplate(payload) {
  if (!Array.isArray(payload.installments) || payload.installments.length === 0) {
    throw new AppError('At least one installment is required', 400);
  }
  const sum = payload.installments.reduce((s, x) => s + ensureNumber(x.percent, 0), 0);
  if (Math.abs(sum - 100) > 0.01) {
    throw new AppError('Installment percentages must sum to 100', 400);
  }
  const row = {
    name: payload.name,
    description: payload.description || '',
    net_days: ensureInt(payload.net_days) || 30,
    skonto_percent: payload.skonto_percent == null ? null : ensureNumber(payload.skonto_percent),
    skonto_within_days: payload.skonto_within_days == null ? null : ensureInt(payload.skonto_within_days),
    installments: JSON.stringify(payload.installments),
    is_system: formatBoolean(false),
    is_active: formatBoolean(true),
    display_order: ensureInt(payload.display_order),
    created_at: new Date(),
    updated_at: new Date(),
  };
  const inserted = await db('payment_term_templates').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return await db('payment_term_templates').where({ id }).first();
}

async function updatePaymentTermTemplate(id, payload) {
  const existing = await db('payment_term_templates').where({ id }).first();
  if (!existing) throw new AppError('Not found', 404);
  if (existing.is_system && Object.prototype.hasOwnProperty.call(payload, 'installments')) {
    // Allow renaming + description tweaks on system rows but never let
    // an admin reshape the installment array — keeps the "factory
    // presets" semantically stable for migrations & docs.
    delete payload.installments;
  }
  const updates = { updated_at: new Date() };
  for (const k of ['name', 'description', 'net_days', 'skonto_percent', 'skonto_within_days', 'display_order', 'is_active']) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) {
      updates[k] = k === 'is_active' ? formatBoolean(Boolean(payload[k])) : payload[k];
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'installments')) {
    updates.installments = JSON.stringify(payload.installments);
  }
  await db('payment_term_templates').where({ id }).update(updates);
  return await db('payment_term_templates').where({ id }).first();
}

async function deletePaymentTermTemplate(id) {
  const existing = await db('payment_term_templates').where({ id }).first();
  if (!existing) throw new AppError('Not found', 404);
  if (existing.is_system) {
    throw new AppError('Cannot delete a system payment-term template', 409);
  }
  // Soft-delete to keep snapshots referenced by sent quotes coherent.
  await db('payment_term_templates').where({ id })
    .update({ is_active: formatBoolean(false), updated_at: new Date() });
  return { deleted: true };
}

module.exports = {
  // Lifecycle
  listQuotes,
  getQuoteById,
  createQuote,
  updateQuote,
  sendQuote,
  duplicateQuote,
  recordResponse,
  convertToEvent,

  // Preview / PDF
  renderQuotePdfBuffer,
  renderQuotePdfFromPayload,

  // Presets
  listLineItemPresets,
  createLineItemPreset,
  updateLineItemPreset,
  deleteLineItemPreset,
  listPaymentTermTemplates,
  createPaymentTermTemplate,
  updatePaymentTermTemplate,
  deletePaymentTermTemplate,

  // Internals exposed for tests + invoiceService re-use.
  _internal: { computeTotals, ensureCustomerFeatureEnabled, nextQuoteNumber, persistDocPdf, buildRenderContext },
};
