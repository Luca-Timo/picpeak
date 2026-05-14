/**
 * invoiceService — lifecycle for `invoices`, line items, payment log.
 *
 * Layers on top of quoteService for the conversion path: quoteService
 * .convertToEvent() calls into scheduleInvoicesForEvent() to fan out
 * one row per installment with the right `scheduled_send_at` relative
 * to the event date.
 *
 * Statuses (`invoices.status`):
 *   scheduled  not yet sent; the scheduler picks it up when
 *              `scheduled_send_at <= now()` and flips to `sent`
 *   sent       email + PDF delivered; awaiting payment
 *   paid       fully paid (paid_amount_minor >= total_amount_minor)
 *   overdue    past due_date + reminder_first_days; reminder fired
 *   cancelled  admin cancelled; no further reminders
 *
 * Per-customer feature override (`customer_accounts.feature_bills`):
 *   when false, the service refuses to create or schedule invoices for
 *   that customer.
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
// Migration 119 line-item hierarchy helpers, shared with quoteService.
// We import lazily inside the functions that use them to avoid a
// require-cycle warning (quoteService also imports invoiceService for
// the quote→invoice conversion path).
function getHierarchyHelpers() {
  // eslint-disable-next-line global-require
  return require('./quoteService')._internal;
}

// Reused tiny helpers identical to quoteService — duplicated rather
// than imported to keep services decoupled.
function ensureInt(value) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? 0 : n;
}
function ensureNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function formatNumberInTemplate(format, year, seq) {
  return format
    .replace(/\{YEAR\}/g, String(year))
    .replace(/\{MONTH\}/g, String(new Date().getMonth() + 1).padStart(2, '0'))
    .replace(/\{SEQ:(\d+)d\}/g, (_, pad) => String(seq).padStart(parseInt(pad, 10), '0'))
    .replace(/\{SEQ\}/g, String(seq));
}

async function nextInvoiceNumber() {
  const format = (await getAppSetting('crm_invoices_number_format')) || 'R-{YEAR}-{SEQ:04d}';
  const year = new Date().getFullYear();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const yearPrefix = formatNumberInTemplate(format, year, 0).slice(0, -4);
    const rows = await db('invoices')
      .where('invoice_number', 'like', `${yearPrefix}%`)
      .select('invoice_number');
    let maxSeq = 0;
    for (const r of rows) {
      const m = r.invoice_number.match(/(\d+)\s*$/);
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
    }
    const candidate = formatNumberInTemplate(format, year, maxSeq + 1);
    const exists = await db('invoices').where({ invoice_number: candidate }).first();
    if (!exists) return candidate;
  }
  return `R-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function ensureCustomerCanBill(customer) {
  if (!customer) { throw new AppError('Customer not found', 404); }
  if (customer.is_active === false || customer.is_active === 0) {
    throw new AppError('Customer is deactivated', 409);
  }
  if (customer.feature_bills === false || customer.feature_bills === 0 || customer.feature_bills === '0') {
    throw new AppError('This customer has bills disabled', 409, 'CUSTOMER_FEATURE_DISABLED');
  }
}

/**
 * Resolve a trigger ('quote_accepted' | 'before_event' | ...) +
 * offset_days into a concrete date relative to the event.
 */
function computeScheduledSendAt(trigger, offsetDays, eventDate, baseDate = new Date()) {
  const ms = 24 * 60 * 60 * 1000;
  const offset = ensureInt(offsetDays) * ms;
  const eventTs = eventDate ? new Date(eventDate).getTime() : null;
  switch (trigger) {
    case 'quote_accepted':
      return new Date(baseDate.getTime() + offset);
    case 'before_event':
    case 'after_event':
      if (!eventTs) return new Date(baseDate.getTime() + offset);
      return new Date(eventTs + offset);
    case 'after_delivery':
      // Treat as event_date + 14 days as a sensible default; admin can
      // edit the scheduled_send_at on the invoice later.
      if (!eventTs) return new Date(baseDate.getTime() + 14 * ms + offset);
      return new Date(eventTs + 14 * ms + offset);
    case 'fixed_date':
    default:
      return new Date(baseDate.getTime() + offset);
  }
}

function computeDueDate(scheduledSendAt, netDays = 30) {
  return new Date(scheduledSendAt.getTime() + ensureInt(netDays) * 24 * 60 * 60 * 1000);
}

/**
 * Snap a baseline date to the next billing-cycle boundary for a
 * customer on a fixed cadence. Used by scheduleInvoicesForEvent so
 * monthly / quarterly customers don't get billed immediately on quote
 * acceptance — instead the invoice fires on `billing_cycle_day` of the
 * next period.
 *
 * `cycleDay` is clamped to the destination month's length (e.g. day 31
 * in February rolls back to Feb 28/29). This protects the scheduler
 * from "missing" bills.
 */
function snapToNextBillingCycle(baseDate, cadence, cycleDay) {
  if (!cadence || cadence === 'per_event') return baseDate;
  const day = Math.max(1, Math.min(31, ensureInt(cycleDay) || 1));
  const d = new Date(baseDate.getTime());

  if (cadence === 'monthly') {
    // Move to the cycleDay in the next calendar month. If we're already
    // before cycleDay this month and the base date is in the same month,
    // we still move forward to NEXT month so accepting a quote on
    // Jan 5 (cycleDay=1) fires on Feb 1, not Jan 5.
    const target = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const monthLen = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, monthLen));
    return target;
  }

  if (cadence === 'quarterly') {
    // First month of the next quarter. Quarter starts: Jan, Apr, Jul, Oct.
    const month = d.getMonth();
    const nextQuarterMonth = (Math.floor(month / 3) + 1) * 3; // 0,3,6,9
    const target = new Date(d.getFullYear(), nextQuarterMonth, 1);
    const monthLen = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, monthLen));
    return target;
  }

  return baseDate;
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

async function listInvoices({ filters = {}, sort = 'newest', page = 1, pageSize = 25 } = {}) {
  return await withRetry(async () => {
    let query = db('invoices')
      .leftJoin('customer_accounts', 'invoices.customer_account_id', 'customer_accounts.id')
      .select(
        'invoices.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
      );

    if (Array.isArray(filters.status) && filters.status.length > 0) {
      query = query.whereIn('invoices.status', filters.status);
    }
    if (filters.customerAccountId) {
      query = query.where('invoices.customer_account_id', filters.customerAccountId);
    }
    if (filters.sourceQuoteId) {
      query = query.where('invoices.source_quote_id', filters.sourceQuoteId);
    }
    if (filters.unpaidOnly) {
      query = query.whereIn('invoices.status', ['scheduled', 'sent', 'overdue']);
    }
    if (filters.q && String(filters.q).trim()) {
      const term = `%${String(filters.q).trim()}%`;
      query = query.andWhere(function() {
        this.where('invoices.invoice_number', 'like', term)
          .orWhere('customer_accounts.email', 'like', term)
          .orWhere('customer_accounts.company_name', 'like', term);
      });
    }
    const countRow = await query.clone().clearSelect().clearOrder().count('invoices.id as total').first();
    const total = ensureInt(countRow?.total || 0);

    switch (sort) {
      case 'oldest':       query = query.orderBy('invoices.issue_date', 'asc').orderBy('invoices.id', 'asc'); break;
      case 'due_asc':      query = query.orderBy('invoices.due_date', 'asc'); break;
      case 'due_desc':     query = query.orderBy('invoices.due_date', 'desc'); break;
      case 'value_asc':    query = query.orderBy('invoices.total_amount_minor', 'asc'); break;
      case 'value_desc':   query = query.orderBy('invoices.total_amount_minor', 'desc'); break;
      case 'customer_asc':
        query = query
          .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) asc')
          .orderBy('invoices.id', 'desc');
        break;
      case 'newest':
      default:
        query = query.orderBy('invoices.issue_date', 'desc').orderBy('invoices.id', 'desc');
        break;
    }

    const offset = Math.max(0, (page - 1) * pageSize);
    query = query.offset(offset).limit(pageSize);
    const rows = await query;
    return { rows, total, page, pageSize };
  });
}

async function getInvoiceById(id) {
  return await withRetry(async () => {
    // LEFT JOIN customer_accounts so transformInvoice has populated
    // customer_email / company etc. — mirrors getQuoteById.
    const invoice = await db('invoices')
      .leftJoin('customer_accounts', 'invoices.customer_account_id', 'customer_accounts.id')
      .where('invoices.id', id)
      .select(
        'invoices.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
      )
      .first();
    if (!invoice) return null;
    // Self-join so each row also carries `parent_position` (the position
    // of its parent line item, when it's a sub-item). The editor needs
    // position-based references to rebuild the hierarchy in the UI;
    // parent_line_item_id is the DB-level relationship but isn't
    // stable in the payload the editor sends back. Migration 119.
    const lineItems = await db('invoice_line_items as li')
      .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
      .where('li.invoice_id', id)
      .orderBy('li.position', 'asc')
      .select('li.*', 'parent.position as parent_position');
    const payments = await db('invoice_payment_log').where({ invoice_id: id }).orderBy('paid_at', 'asc');
    return { invoice, lineItems, payments };
  });
}

/**
 * Create one invoice. Returns id. Used both manually (admin creates a
 * standalone invoice) and by scheduleInvoicesForEvent (one per installment).
 */
async function createInvoice(payload, adminId, trx = db) {
  const customer = await trx('customer_accounts').where({ id: payload.customerAccountId }).first();
  ensureCustomerCanBill(customer);

  const profile = (await businessProfileService.getProfile()).profile;
  const currency = (payload.currency || profile?.default_currency || 'CHF').toUpperCase();
  const language = payload.language || customer.preferred_language || profile?.default_locale || 'de';

  const invoiceNumber = await nextInvoiceNumber();
  const issueDate = payload.issueDate || new Date().toISOString().slice(0, 10);
  const scheduledSendAt = payload.scheduledSendAt ? new Date(payload.scheduledSendAt) : null;
  const dueDate = payload.dueDate || computeDueDate(scheduledSendAt || new Date(issueDate), 30)
    .toISOString().slice(0, 10);

  // Re-compute totals from line items. Migration 119 — items with a
  // non-null `parent_position` are sub-items and their line totals do
  // NOT roll into net (display-only itemisation). The
  // validateLineItemHierarchy + insertLineItemsHierarchical helpers
  // (shared with quoteService) enforce the 1-level-deep rule and do
  // the two-phase insert. The DB-side line_total_minor is still
  // computed for every row so the renderer can show sub-prices.
  const lineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  let netMinor = 0;
  const items = lineItems.map((li, idx) => {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = ensureNumber(li.discount_percent, 0);
    const lineTotal = Math.round(Math.round(qty * unit) * (1 - discount / 100));
    const isSubItem = li.parent_position != null && li.parent_position !== '';
    if (!isSubItem) netMinor += lineTotal;
    return {
      position: ensureInt(li.position) || (idx + 1),
      quantity: qty,
      description: String(li.description || ''),
      unit_price_minor: unit,
      discount_percent: discount,
      line_total_minor: lineTotal,
      parent_position: isSubItem ? ensureInt(li.parent_position) : null,
      details_text: li.details_text || null,
    };
  });
  const vatRate = ensureNumber(payload.vatRate, 0);
  const vatMinor = Math.round(netMinor * vatRate / 100);
  const shippingMinor = ensureInt(payload.shippingAmountMinor);
  const totalMinor = netMinor + vatMinor + shippingMinor;

  const bank = await businessProfileService.resolveBankAccountForCurrency(currency, payload.businessBankAccountId);

  // Snapshot the selected payment-term template (net days / Skonto /
  // installment plan) onto the invoice itself. Mirrors how the quote
  // editor handles this — once snapshotted, edits to the template
  // don't retroactively change rendered invoices. Migration 113.
  let paymentTermTemplateId = null;
  let paymentTermSnapshot = null;
  if (payload.paymentTermTemplateId) {
    const tpl = await trx('payment_term_templates')
      .where({ id: payload.paymentTermTemplateId }).first();
    if (tpl) {
      paymentTermTemplateId = tpl.id;
      // Match the snapshot shape the quote service emits so the
      // PDF renderer's build* helpers can read both invoice and
      // quote snapshots through one code path.
      paymentTermSnapshot = JSON.stringify({
        description: tpl.description || null,
        net_days: tpl.net_days,
        skonto_percent: tpl.skonto_percent,
        skonto_within_days: tpl.skonto_within_days,
        installments: typeof tpl.installments === 'string'
          ? (() => { try { return JSON.parse(tpl.installments); } catch { return null; } })()
          : tpl.installments || null,
      });
    }
  }

  const row = {
    invoice_number: invoiceNumber,
    customer_account_id: payload.customerAccountId,
    source_quote_id: payload.sourceQuoteId || null,
    event_id: payload.eventId || null,
    language,
    currency,
    issue_date: issueDate,
    due_date: dueDate,
    installment_index: ensureInt(payload.installmentIndex),
    installment_total: ensureInt(payload.installmentTotal) || 1,
    installment_label: payload.installmentLabel || null,
    installment_trigger: payload.installmentTrigger || null,
    status: scheduledSendAt && scheduledSendAt.getTime() > Date.now() ? 'scheduled' : (payload.sendNow ? 'scheduled' : 'scheduled'),
    scheduled_send_at: scheduledSendAt,
    net_amount_minor: netMinor,
    vat_rate: vatRate,
    vat_amount_minor: vatMinor,
    shipping_amount_minor: shippingMinor,
    total_amount_minor: totalMinor,
    cc_pdf_email: payload.ccPdfEmail || null,
    business_bank_account_id: bank?.id || null,
    qr_format: payload.qrFormat || null,
    payment_term_template_id: paymentTermTemplateId,
    payment_term_snapshot: paymentTermSnapshot,
    created_by_admin_id: adminId,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const inserted = await trx('invoices').insert(row).returning('id');
  const invoiceId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  if (items.length > 0) {
    const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
    validateLineItemHierarchy(items);
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', invoiceId, items);
  }

  try { await logActivity('invoice_created', { invoiceId, invoiceNumber }, payload.eventId || null, `admin:${adminId}`); } catch (_) {}
  return invoiceId;
}

/**
 * Fan-out helper called by quoteService.convertToEvent. Creates one
 * invoice row per installment with the right scheduled_send_at.
 *
 * Expects to be called inside an existing transaction.
 */
async function scheduleInvoicesForEvent({ trx, eventId, quoteId, customer, currency, language,
                                          lineItems, totals, installments, eventDate, adminId,
                                          ccPdfEmail }) {
  const total = installments.length;
  const acceptanceTime = new Date();

  for (let i = 0; i < total; i++) {
    const inst = installments[i];
    const percent = ensureNumber(inst.percent, 0);
    if (percent <= 0) continue;

    // Each installment carries its own slice of the totals. Round to
    // minor units; last installment absorbs rounding drift so the
    // total exactly equals the quote total.
    let netSlice, vatSlice, shippingSlice, totalSlice;
    if (i === total - 1) {
      // We computed everything so far; remaining slice closes the gap.
      const accNet = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.net) * ensureNumber(x.percent, 0) / 100), 0);
      const accVat = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.vat) * ensureNumber(x.percent, 0) / 100), 0);
      const accShipping = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.shipping) * ensureNumber(x.percent, 0) / 100), 0);
      const accTotal = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.total) * ensureNumber(x.percent, 0) / 100), 0);
      netSlice = ensureInt(totals.net) - accNet;
      vatSlice = ensureInt(totals.vat) - accVat;
      shippingSlice = ensureInt(totals.shipping) - accShipping;
      totalSlice = ensureInt(totals.total) - accTotal;
    } else {
      netSlice = Math.round(ensureInt(totals.net) * percent / 100);
      vatSlice = Math.round(ensureInt(totals.vat) * percent / 100);
      shippingSlice = Math.round(ensureInt(totals.shipping) * percent / 100);
      totalSlice = Math.round(ensureInt(totals.total) * percent / 100);
    }

    let scheduledSendAt = computeScheduledSendAt(inst.trigger, inst.offset_days, eventDate, acceptanceTime);
    // Per-customer billing cadence override: monthly / quarterly
    // customers don't pay per-event — snap to the next period boundary.
    if (customer && customer.billing_cadence && customer.billing_cadence !== 'per_event') {
      scheduledSendAt = snapToNextBillingCycle(scheduledSendAt, customer.billing_cadence, customer.billing_cycle_day);
    }

    // `after_delivery` invoices wait for the admin to confirm photos
    // have actually been delivered before they fire — we can't infer
    // that automatically from a date. Mark them `pending_delivery`
    // with no scheduled_send_at; the scheduler only picks rows in
    // status `scheduled`, so they sit idle until the admin clicks
    // "Release for delivery" on the invoice detail page.
    const isDeliveryTrigger = inst.trigger === 'after_delivery';
    const rowStatus = isDeliveryTrigger ? 'pending_delivery' : 'scheduled';
    const rowScheduledSendAt = isDeliveryTrigger ? null : scheduledSendAt;

    const invoiceNumber = await nextInvoiceNumber();
    const dueDate = computeDueDate(scheduledSendAt, 30).toISOString().slice(0, 10);

    const row = {
      invoice_number: invoiceNumber,
      customer_account_id: customer.id,
      source_quote_id: quoteId,
      event_id: eventId,
      language,
      currency,
      issue_date: scheduledSendAt.toISOString().slice(0, 10),
      due_date: dueDate,
      installment_index: i,
      installment_total: total,
      installment_label: inst.label || `Installment ${i + 1}/${total}`,
      installment_trigger: inst.trigger,
      status: rowStatus,
      scheduled_send_at: rowScheduledSendAt,
      net_amount_minor: netSlice,
      vat_rate: ensureNumber(totals.vatRate, 0),
      vat_amount_minor: vatSlice,
      shipping_amount_minor: shippingSlice,
      total_amount_minor: totalSlice,
      cc_pdf_email: ccPdfEmail || null,
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const inserted = await trx('invoices').insert(row).returning('id');
    const invoiceId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Line items: copy from the quote so the customer sees what they
    // actually agreed to, not a generic "Gesamtbetrag" placeholder.
    // Two modes:
    //   - Single-installment (100%): clone every quote line item
    //     verbatim. The invoice totals already match the quote's.
    //   - Multi-installment (split payment): clone the quote lines
    //     but mark the invoice with the installment context. We pro-
    //     rate by inserting one extra line at the bottom that adjusts
    //     to the installment slice — keeps the per-line description
    //     visible while the total still equals the pro-rata amount.
    const sourceLines = Array.isArray(lineItems) ? lineItems : [];
    if (sourceLines.length === 0) {
      // Fallback for the (rare) case where the quote has no line
      // items — fall back to the legacy "Installment N/M" line so
      // we still produce a sensible invoice.
      await trx('invoice_line_items').insert({
        invoice_id: invoiceId,
        position: 1,
        quantity: 1,
        description: inst.label || `Installment ${i + 1}/${total}`,
        unit_price_minor: netSlice,
        discount_percent: 0,
        line_total_minor: netSlice,
        created_at: new Date(),
        updated_at: new Date(),
      });
    } else {
      // Clone each quote line as-is, preserving its original `position`
      // so the sub-item hierarchy carries over. Source lines already
      // have `parent_position` populated by getQuoteById's self-join,
      // so the same value reused on the new invoice points at the
      // correct (also-cloned) parent. insertLineItemsHierarchical
      // resolves position → new parent_line_item_id during the
      // two-phase insert. Migration 119.
      const cloned = sourceLines.map((li) => ({
        position: ensureInt(li.position),
        quantity: li.quantity,
        description: li.description,
        unit_price_minor: ensureInt(li.unit_price_minor),
        discount_percent: ensureNumber(li.discount_percent, 0),
        line_total_minor: ensureInt(li.line_total_minor),
        parent_position: li.parent_position == null ? null : ensureInt(li.parent_position),
        details_text: li.details_text || null,
      }));
      const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
      validateLineItemHierarchy(cloned);
      await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', invoiceId, cloned);

      // For split payments add an explicit "Installment X/Y (Z%)"
      // adjustment line that reconciles the cloned line totals to
      // the actual invoice net (which is the pro-rata slice). The
      // line carries the difference as a negative if the slice is
      // less than the quote total (typical), or positive on the
      // final installment if rounding nudged the other way.
      //
      // The adjustment ONLY considers top-level cloned lines —
      // sub-items don't contribute to net so they can't appear in
      // the reconciliation sum.
      if (total > 1) {
        const clonedSum = cloned
          .filter((x) => x.parent_position == null)
          .reduce((s, x) => s + ensureInt(x.line_total_minor), 0);
        const adjustment = netSlice - clonedSum;
        if (adjustment !== 0) {
          const installmentLabel = inst.label || `Installment ${i + 1}/${total}`;
          const maxPosition = cloned.reduce((m, x) => Math.max(m, x.position), 0);
          await trx('invoice_line_items').insert({
            invoice_id: invoiceId,
            position: maxPosition + 1,
            quantity: 1,
            description: `${installmentLabel} (${percent}% — ${i + 1}/${total})`,
            unit_price_minor: adjustment,
            discount_percent: 0,
            line_total_minor: adjustment,
            parent_line_item_id: null,
            details_text: null,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
      }
    }

    try {
      await logActivity('invoice_scheduled', { invoiceId, invoiceNumber, eventId, quoteId, scheduledSendAt },
        eventId, `admin:${adminId}`);
    } catch (_) {}
  }
}

async function buildInvoiceRenderContext(invoice, lineItems) {
  const { profile } = await businessProfileService.getProfile();
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  const bank = invoice.business_bank_account_id
    ? await db('business_bank_accounts').where({ id: invoice.business_bank_account_id }).first()
    : await businessProfileService.resolveBankAccountForCurrency(invoice.currency);

  // Resolve the PDF logo to a verified absolute disk path. The
  // helper exhaustively tries:
  //   1. business_profile.logo_path
  //   2. app_settings.branding_logo_path  (absolute multer path)
  //   3. app_settings.branding_logo_url   (URL path)
  // …and for each, generates ~7 candidate disk locations before
  // giving up. Returns null + logs a detailed warning when nothing
  // resolves. Already-verified path means the renderer never has
  // to second-guess.
  const { resolveLogoFile } = require('../utils/resolveLogoFile');
  const resolvedLogoPath = await resolveLogoFile(profile);

  // QR format resolution order (per-invoice override → profile
  // default → none) gated by the global enable toggle. The earlier
  // version had an operator-precedence bug that effectively dropped
  // the profile default; this rewrites it as plain if/else for
  // readability + correctness.
  const qrGloballyEnabled = (await getAppSetting('crm_invoices_qr_enabled')) !== false;
  let resolvedQrFormat = 'none';
  if (qrGloballyEnabled) {
    resolvedQrFormat = invoice.qr_format || profile?.default_qr_format || 'none';
  }

  // Resolve the payment-term snapshot to thread Skonto + net-days into
  // the PDF's "Zahlungsbedingungen" block. Three sources, in priority
  // order:
  //   1. The invoice's OWN snapshot (migration 113 — set when admin
  //      picks a template directly in the New Invoice form).
  //   2. The originating quote's snapshot, if this invoice was
  //      created from one.
  //   3. The global CRM defaults (settings tab) — `crm_invoices_*`.
  // Both layers above are wrapped in `paymentTerm` exactly as
  // quoteService builds it so pdfService.drawPaymentBlock renders
  // the same block on both document types.
  let paymentTerm = null;

  // Invoice-level snapshot wins when set.
  if (invoice.payment_term_snapshot) {
    const snapshot = typeof invoice.payment_term_snapshot === 'string'
      ? (() => { try { return JSON.parse(invoice.payment_term_snapshot); } catch { return null; } })()
      : invoice.payment_term_snapshot;
    if (snapshot) {
      paymentTerm = {
        description: snapshot.description,
        netDays: snapshot.net_days,
        skontoPercent: snapshot.skonto_percent,
        skontoWithinDays: snapshot.skonto_within_days,
      };
    }
  }

  // Load the source quote once — used for the payment-term snapshot
  // fallback AND for the "Bezug: Angebot Q-..." reference line on
  // the invoice PDF. We deliberately keep invoice numbers on a
  // strict monotonic sequence (tax compliance) and surface the link
  // as a text reference rather than mirroring the number.
  let sourceQuote = null;
  if (invoice.source_quote_id) {
    sourceQuote = await db('quotes').where({ id: invoice.source_quote_id }).first();
    if (!paymentTerm && sourceQuote?.payment_term_snapshot) {
      const snapshot = typeof sourceQuote.payment_term_snapshot === 'string'
        ? (() => { try { return JSON.parse(sourceQuote.payment_term_snapshot); } catch { return null; } })()
        : sourceQuote.payment_term_snapshot;
      if (snapshot) {
        paymentTerm = {
          description: snapshot.description,
          netDays: snapshot.net_days,
          skontoPercent: snapshot.skonto_percent,
          skontoWithinDays: snapshot.skonto_within_days,
        };
      }
    }
  }
  // Globally-default Skonto values, always loaded. Used either to
  // FILL a partial source-quote snapshot OR to seed the whole
  // paymentTerm when there's no source quote. Both reads survive
  // missing rows (returns null), unset values (NaN guarded), and
  // string-encoded numbers from app_settings.
  const defaultSkontoPercentRaw = await getAppSetting('crm_invoices_skonto_percent_default');
  const defaultSkontoDaysRaw = await getAppSetting('crm_invoices_skonto_business_days');
  const defaultSkontoPercent = Number.isFinite(Number(defaultSkontoPercentRaw)) && Number(defaultSkontoPercentRaw) > 0
    ? Number(defaultSkontoPercentRaw) : null;
  const defaultSkontoDays = Number.isFinite(Number(defaultSkontoDaysRaw)) && Number(defaultSkontoDaysRaw) > 0
    ? parseInt(defaultSkontoDaysRaw, 10) : null;

  if (paymentTerm) {
    // The source quote's snapshot may carry only some of the Skonto
    // fields (e.g. when the template predates Skonto support); fill
    // missing parts from the global defaults so the PDF still shows
    // the row whenever there's enough info to render it.
    if (paymentTerm.skontoPercent == null && defaultSkontoPercent != null) {
      paymentTerm.skontoPercent = defaultSkontoPercent;
    }
    if (paymentTerm.skontoWithinDays == null && defaultSkontoDays != null) {
      paymentTerm.skontoWithinDays = defaultSkontoDays;
    }
  } else {
    // Ad-hoc invoice (no source quote). Build the paymentTerm from
    // the global defaults. Renders only when BOTH percent + days are
    // set + > 0 (pdfService.drawPaymentBlock guards on that).
    paymentTerm = {
      description: null,
      netDays: 30,
      skontoPercent: defaultSkontoPercent,
      skontoWithinDays: defaultSkontoDays,
    };
  }

  // Global date format from Settings → General (general_date_format).
  // Stored as JSON `{ format, locale }`; missing or malformed entries
  // fall back to DD.MM.YYYY in the renderer.
  let dateFormat = null;
  try {
    const raw = await getAppSetting('general_date_format');
    if (raw && typeof raw === 'object' && raw.format) dateFormat = raw;
    else if (typeof raw === 'string' && raw.trim()) dateFormat = { format: raw.trim() };
  } catch (_) { /* fall back to default */ }

  return {
    locale: invoice.language || profile?.default_locale || 'de',
    currency: invoice.currency,
    qrFormat: resolvedQrFormat,
    dateFormat,
    issuer: profile ? {
      companyName: profile.company_name,
      addressLine1: profile.address_line1,
      addressLine2: profile.address_line2,
      postalCode: profile.postal_code,
      city: profile.city,
      state: profile.state,
      countryCode: profile.country_code,
      phone: profile.phone, mobile: profile.mobile, email: profile.email, website: profile.website,
      footerLine: profile.footer_line,
      vatId: profile.vat_id,
      logoPath: resolvedLogoPath,
      pdfFontTtfPath: profile.pdf_font_ttf_path,
      // Free-text country name override (migration 107). When set the
      // PDF renderer uses this verbatim; falls back to the locale-aware
      // COUNTRY_NAMES lookup when blank.
      countryName: profile.country_name || null,
      // Visibility toggles (migration 106). Default true when the
      // column is missing (older installs that haven't migrated yet)
      // so the previously implicit "always show" behavior is pinned.
      showLogo: profile.pdf_show_logo == null ? true
        : (profile.pdf_show_logo === true || profile.pdf_show_logo === 1 || profile.pdf_show_logo === '1'),
      showCompanyName: profile.pdf_show_company_name == null ? true
        : (profile.pdf_show_company_name === true || profile.pdf_show_company_name === 1 || profile.pdf_show_company_name === '1'),
      // Layout customisation (migration 108).
      logoHeight: profile.pdf_logo_height == null ? 56 : Number(profile.pdf_logo_height),
      companyNameInline: profile.pdf_company_name_inline === true || profile.pdf_company_name_inline === 1 || profile.pdf_company_name_inline === '1',
      foldingMarks: profile.pdf_folding_marks || 'none',
    } : {},
    recipient: (() => {
      // Recipient first-line rule (maintainer spec):
      //   1. If customer.company_name is set → bold company name on
      //      line 1, then "z. Hd. <person>" on line 2.
      //   2. Else → bold full person name on line 1, NO "z. Hd."
      //      attention line (avoids the "Luca Bresch / z. Hd. Luca
      //      Bresch" duplication).
      //
      // We trim each field defensively because empty strings ("")
      // are truthy after `||` short-circuiting unless we coerce
      // empty → null first. Without the trim, a customer row
      // saved with company_name = "" (instead of NULL) would still
      // engage the company-header path.
      const trimmedCompany = (customer?.company_name || '').trim();
      const personFull = [customer?.first_name, customer?.last_name]
        .map((s) => (s || '').trim()).filter(Boolean).join(' ');
      const headerWithCompany = !!trimmedCompany;
      const header = trimmedCompany
        || personFull
        || (customer?.display_name || '').trim()
        || customer?.email
        || '';
      const attentionParts = [customer?.salutation, personFull].filter(Boolean);
      const attentionLine = attentionParts.length > 0 ? `z. Hd. ${attentionParts.join(' ')}` : '';
      return {
        issuerLine: profile?.company_name
          ? `${profile.company_name} * ${profile.address_line1 || ''} * ${profile.postal_code || ''} ${profile.city || ''}`
          : '',
        companyName: header,
        hasCompany: headerWithCompany,
        attentionLine,
        // Honorific + last name surfaced for the personalised
        // salutation line ("Sehr geehrter Herr Bresch,"). Both must
        // be present for personalisation to fire; otherwise the
        // generic locale greeting is used.
        salutation: customer?.salutation || null,
        lastName: (customer?.last_name || '').trim() || null,
        addressLine1: customer?.address_line1,
        addressLine2: customer?.address_line2,
        postalCode: customer?.postal_code,
        city: customer?.city,
        // Country name override (migration 107). When the customer
        // record carries an explicit name, the PDF uses it verbatim;
        // otherwise the renderer falls back to the COUNTRY_NAMES
        // lookup on countryCodeIso.
        country: customer?.country_name || null,
        countryCodeIso: customer?.country_code,
      };
    })(),
    bank: bank ? {
      accountHolder: bank.account_holder || profile?.company_name,
      iban: bank.iban, bic: bank.bic, currency: bank.currency,
    } : null,
    paymentTerm,
    lineItems: lineItems.map((li) => ({
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: li.unit_price_minor,
      discountPercent: li.discount_percent,
      lineTotalMinor: li.line_total_minor,
    })),
    totals: {
      netAmountMinor: invoice.net_amount_minor,
      vatRate: invoice.vat_rate,
      vatAmountMinor: invoice.vat_amount_minor,
      shippingAmountMinor: invoice.shipping_amount_minor,
      totalAmountMinor: invoice.total_amount_minor,
      // Mahngebühr surfaced to the totals box (renders a row
      // between VAT and the grand-total divider) and folded
      // into the displayed Grand Total when > 0. Reminder
      // invoices after level 2 carry a non-zero value.
      lateFeeAmountMinor: invoice.late_fee_amount_minor || 0,
    },
    doc: {
      invoiceNumber: invoice.invoice_number,
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      totalAmountMinor: invoice.total_amount_minor,
      lateFeeMinor: invoice.late_fee_amount_minor,
      // Reminder level — drives Skonto suppression on second
      // reminders (no early-payment discount once the customer
      // is in dunning).
      reminderLevel: invoice.reminder_level || 0,
      // PDF renderer draws "Bezug: Angebot Q-..." under the title
      // when set. Empty/null suppresses the line (standalone invoice).
      sourceQuoteNumber: sourceQuote?.quote_number || null,
      // When this invoice supersedes a previous one (migration 114 —
      // cancel + reissue workflow), the renderer stamps a second
      // reference line: "Bezug: Ersetzt Rechnung R-XXXX vom DATE".
      supersedesInvoice: await (async () => {
        if (!invoice.supersedes_invoice_id) return null;
        const prior = await db('invoices')
          .where({ id: invoice.supersedes_invoice_id })
          .select('invoice_number', 'issue_date').first();
        return prior
          ? { number: prior.invoice_number, issueDate: prior.issue_date }
          : null;
      })(),
    },
  };
}

async function renderInvoicePdfBuffer(invoiceId) {
  const data = await getInvoiceById(invoiceId);
  if (!data) throw new AppError('Invoice not found', 404);
  // Imported (historical) invoices store the original PDF on disk
  // — short-circuit the renderer and stream the file untouched so
  // legal documents stay byte-identical to the source. Path is
  // stored relative to STORAGE_PATH but we accept absolute too.
  if (data.invoice.imported_pdf_path) {
    const fs = require('fs');
    const path = require('path');
    const { getStoragePath } = require('../config/storage');
    const raw = String(data.invoice.imported_pdf_path).trim();
    const candidates = [
      path.isAbsolute(raw) ? raw : null,
      path.join(getStoragePath(), raw.replace(/^\/+/, '')),
    ].filter(Boolean);
    const found = candidates.find((p) => {
      try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
    });
    if (!found) {
      throw new AppError('Imported invoice PDF is missing on disk', 410);
    }
    return fs.readFileSync(found);
  }
  const ctx = await buildInvoiceRenderContext(data.invoice, data.lineItems);
  return await pdfService.renderInvoiceToBuffer(ctx);
}

async function renderInvoicePdfFromPayload(payload) {
  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  const lineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  let netMinor = 0;
  const items = lineItems.map((li, idx) => {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = ensureNumber(li.discount_percent, 0);
    const lineTotal = Math.round(Math.round(qty * unit) * (1 - discount / 100));
    netMinor += lineTotal;
    return { ...li, position: li.position || idx + 1, line_total_minor: lineTotal };
  });
  const vatRate = ensureNumber(payload.vatRate, 0);
  const vatMinor = Math.round(netMinor * vatRate / 100);
  const shippingMinor = ensureInt(payload.shippingAmountMinor);
  const totalMinor = netMinor + vatMinor + shippingMinor;
  const fakeInvoice = {
    invoice_number: 'PREVIEW',
    customer_account_id: payload.customerAccountId,
    language: payload.language || customer?.preferred_language || 'de',
    currency: (payload.currency || 'CHF').toUpperCase(),
    issue_date: payload.issueDate || new Date().toISOString().slice(0, 10),
    due_date: payload.dueDate || new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10),
    business_bank_account_id: payload.businessBankAccountId,
    qr_format: payload.qrFormat,
    net_amount_minor: netMinor,
    vat_rate: vatRate,
    vat_amount_minor: vatMinor,
    shipping_amount_minor: shippingMinor,
    total_amount_minor: totalMinor,
  };
  const ctx = await buildInvoiceRenderContext(fakeInvoice, items);
  return await pdfService.renderInvoiceToBuffer(ctx);
}

/**
 * Send an invoice email + PDF. Flips status scheduled → sent.
 */
async function sendInvoice(id, adminId) {
  const data = await getInvoiceById(id);
  if (!data) throw new AppError('Invoice not found', 404);
  const { invoice, lineItems } = data;
  if (!['scheduled', 'sent', 'overdue'].includes(invoice.status)) {
    throw new AppError(`Cannot send invoice with status '${invoice.status}'`, 409);
  }
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  ensureCustomerCanBill(customer);

  const ctx = await buildInvoiceRenderContext(invoice, lineItems);
  const buffer = await pdfService.renderInvoiceToBuffer(ctx);

  // Persist PDF snapshot.
  const fs = require('fs');
  const path = require('path');
  const year = new Date(invoice.issue_date).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', 'invoice', String(year));
  fs.mkdirSync(root, { recursive: true });
  const pdfPath = path.join(root, `${invoice.invoice_number}.pdf`);
  fs.writeFileSync(pdfPath, buffer);

  const newStatus = invoice.status === 'overdue' ? 'overdue' : 'sent';
  await db('invoices').where({ id }).update({
    status: newStatus, sent_at: new Date(), pdf_path: pdfPath, updated_at: new Date(),
  });

  await emailProcessor.queueEmail(invoice.event_id || null, customer.email, 'invoice_sent', {
    invoice_number: invoice.invoice_number,
    customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
    event_name: '',
    total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, ctx.locale),
    due_date: formatShortDate(invoice.due_date),
    installment_label: invoice.installment_label || '',
    installment_index: invoice.installment_index + 1,
    installment_total: invoice.installment_total,
    cc: invoice.cc_pdf_email || undefined,
    attachments: [{
      filename: `${invoice.invoice_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }],
  });

  try { await logActivity('invoice_sent', { invoiceId: id }, invoice.event_id || null, `admin:${adminId}`); } catch (_) {}
  return { sent: true, pdfPath };
}

/**
 * Record a payment against an invoice. Supports partial payments
 * (multiple rows accumulate into `paid_amount_minor`). Status flips
 * to `paid` once the running total meets or exceeds total_amount_minor.
 */
async function markPaid(id, { amountMinor, paidAt, paymentMethod, reference, notes }, adminId) {
  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'cancelled') {
    throw new AppError('Cannot mark a cancelled invoice as paid', 409);
  }
  const amount = ensureInt(amountMinor);
  if (amount <= 0) {
    throw new AppError('amount must be > 0', 400);
  }

  return await db.transaction(async (trx) => {
    await trx('invoice_payment_log').insert({
      invoice_id: id,
      amount_minor: amount,
      paid_at: paidAt ? new Date(paidAt) : new Date(),
      payment_method: paymentMethod || null,
      reference: reference || null,
      notes: notes || null,
      recorded_by_admin_id: adminId,
      created_at: new Date(),
    });
    const sumRow = await trx('invoice_payment_log').where({ invoice_id: id }).sum('amount_minor as total').first();
    const total = ensureInt(sumRow?.total || 0);
    // Consider the invoice paid when the recorded payments cover the
    // invoice total. The late fee is NOT added to the threshold here
    // — admins frequently waive it once the customer actually pays
    // (and chasing the extra 25 CHF after a 1500 CHF invoice clears
    // makes nobody happy). Admin can record a separate payment_log
    // row if they did collect the fee; status flips to paid the
    // moment the principal is covered.
    const isFull = total >= invoice.total_amount_minor;

    const update = {
      paid_amount_minor: total,
      payment_method: paymentMethod || invoice.payment_method,
      payment_reference: reference || invoice.payment_reference,
      updated_at: new Date(),
    };
    if (isFull) {
      update.status = 'paid';
      update.paid_at = paidAt ? new Date(paidAt) : new Date();
    }
    await trx('invoices').where({ id }).update(update);

    try { await logActivity(isFull ? 'invoice_paid' : 'invoice_partial_payment',
      { invoiceId: id, amountMinor: amount, totalPaidMinor: total },
      invoice.event_id || null, `admin:${adminId}`); } catch (_) {}

    return { paidTotalMinor: total, status: isFull ? 'paid' : invoice.status };
  });
}

/**
 * Cancel + reissue an invoice — the legally-correct alternative to
 * post-send editing. Atomic:
 *   1. The original (if not already cancelled) flips to status
 *      'cancelled'
 *   2. A new `scheduled` invoice is created with a fresh sequential
 *      number, copying line items + customer + totals + payment
 *      terms + bank + QR + everything the renderer needs
 *   3. The new row's `supersedes_invoice_id` points at the original
 *      so the PDF renderer can stamp "Bezug: Ersetzt Rechnung X" and
 *      auditors can trace the chain
 *
 * Refuses to act on `scheduled` rows — those are still editable
 * via Edit; reissuing them creates a confusing duplicate. Allows
 * `sent` / `overdue` / `paid` / `cancelled` (caller's
 * responsibility to know whether reissuing a paid invoice makes
 * sense — usually that's a credit-note scenario instead).
 */
async function reissueInvoice(id, adminId) {
  const original = await db('invoices').where({ id }).first();
  if (!original) throw new AppError('Invoice not found', 404);
  if (original.status === 'scheduled') {
    throw new AppError(
      'This invoice has not been sent yet — use Edit instead of Cancel & reissue.',
      409,
      'USE_EDIT_INSTEAD',
    );
  }

  return await db.transaction(async (trx) => {
    // 1. Cancel the original (idempotent on already-cancelled rows).
    if (original.status !== 'cancelled') {
      await trx('invoices').where({ id }).update({
        status: 'cancelled',
        updated_at: new Date(),
      });
      try {
        await logActivity('invoice_cancelled_for_reissue', { invoiceId: id },
          original.event_id || null, `admin:${adminId}`);
      } catch (_) {}
    }

    // 2. Snapshot the line items so the duplicate carries identical
    //    rows. We re-insert via createInvoice rather than direct DB
    //    copies so the totals get re-computed authoritatively (any
    //    rounding drift is recalculated from line items, matching
    //    the create flow). Self-join carries parent_position across
    //    so the migration-119 sub-item hierarchy is preserved.
    const lineItems = await trx('invoice_line_items as li')
      .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
      .where('li.invoice_id', id)
      .orderBy('li.position', 'asc')
      .select('li.*', 'parent.position as parent_position');
    const liPayload = lineItems.map((li) => ({
      position: li.position,
      quantity: Number(li.quantity),
      description: li.description,
      unit_price_minor: Number(li.unit_price_minor),
      discount_percent: Number(li.discount_percent || 0),
      parent_position: li.parent_position == null ? null : Number(li.parent_position),
      details_text: li.details_text || null,
    }));

    const newId = await createInvoice({
      customerAccountId: original.customer_account_id,
      sourceQuoteId: original.source_quote_id || null,
      eventId: original.event_id || null,
      language: original.language,
      currency: original.currency,
      vatRate: original.vat_rate,
      shippingAmountMinor: original.shipping_amount_minor,
      ccPdfEmail: original.cc_pdf_email,
      businessBankAccountId: original.business_bank_account_id,
      qrFormat: original.qr_format,
      paymentTermTemplateId: original.payment_term_template_id,
      // No installment metadata — reissue defaults to a single
      // standalone invoice. If the admin needs the same split they
      // can run the original conversion again from the quote.
      lineItems: liPayload,
    }, adminId, trx);

    // 3. Link the new row to the cancelled original.
    await trx('invoices').where({ id: newId }).update({
      supersedes_invoice_id: id,
      updated_at: new Date(),
    });

    try {
      await logActivity('invoice_reissued', { originalInvoiceId: id, newInvoiceId: newId },
        original.event_id || null, `admin:${adminId}`);
    } catch (_) {}

    return { id: newId, supersedes: id };
  });
}

/**
 * Release a `pending_delivery` invoice for sending. Used when the
 * photographer has actually delivered the photos and is ready to
 * collect the final installment — flips the status to `scheduled`
 * with `scheduled_send_at = now`, then immediately calls sendInvoice
 * so the email goes out without waiting for the next scheduler tick.
 *
 * Refuses to act on rows that aren't pending — admins should use
 * sendInvoice / sendReminder for the normal `scheduled`/`sent` flow.
 */
async function releaseForDelivery(id, adminId) {
  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status !== 'pending_delivery') {
    throw new AppError(
      `Invoice is not awaiting delivery (status: '${invoice.status}')`,
      409,
      'NOT_PENDING_DELIVERY',
    );
  }
  const now = new Date();
  await db('invoices').where({ id }).update({
    status: 'scheduled',
    scheduled_send_at: now,
    updated_at: now,
  });
  try {
    await logActivity('invoice_released_for_delivery', { invoiceId: id }, invoice.event_id || null, `admin:${adminId}`);
  } catch (_) {}
  // Fire immediately rather than waiting for the next scheduler
  // tick — admin clicked the button because they want it out now.
  return await sendInvoice(id, adminId);
}

async function cancelInvoice(id, adminId) {
  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'paid') {
    throw new AppError('Cannot cancel a paid invoice', 409);
  }
  await db('invoices').where({ id }).update({
    status: 'cancelled', updated_at: new Date(),
  });
  try { await logActivity('invoice_cancelled', { invoiceId: id }, invoice.event_id || null, `admin:${adminId}`); } catch (_) {}
  return { cancelled: true };
}

/**
 * Manually trigger a reminder email. The scheduler does this
 * automatically; this is the "Send reminder now" button on the
 * invoice detail page.
 */
async function sendReminder(id, levelOverride, adminId) {
  const data = await getInvoiceById(id);
  if (!data) throw new AppError('Invoice not found', 404);
  const { invoice, lineItems } = data;
  if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
    throw new AppError(`Cannot remind on status '${invoice.status}'`, 409);
  }
  const newLevel = levelOverride || (invoice.reminder_level + 1);
  if (newLevel > 2) {
    throw new AppError('Reminder level exhausted', 409);
  }
  return await applyReminder(invoice, lineItems, newLevel, adminId);
}

async function applyReminder(invoice, lineItems, level, adminId) {
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  let lateFeeMinor = invoice.late_fee_amount_minor || 0;
  if (level === 2) {
    const enabled = await getAppSetting('crm_invoices_late_fee_enabled');
    if (enabled !== false) {
      const fee = ensureInt(await getAppSetting('crm_invoices_late_fee_minor')) || 2500;
      lateFeeMinor = fee;
    }
  }
  const newTotal = invoice.total_amount_minor + lateFeeMinor;

  await db('invoices').where({ id: invoice.id }).update({
    status: 'overdue',
    reminder_level: level,
    last_reminder_sent_at: new Date(),
    late_fee_amount_minor: lateFeeMinor,
    updated_at: new Date(),
  });

  // Re-render PDF so the late fee shows up.
  const fresh = await db('invoices').where({ id: invoice.id }).first();
  const ctx = await buildInvoiceRenderContext(fresh, lineItems);
  const buffer = await pdfService.renderInvoiceToBuffer(ctx);
  const fs = require('fs');
  const path = require('path');
  const year = new Date(fresh.issue_date).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', 'invoice', String(year));
  fs.mkdirSync(root, { recursive: true });
  const pdfPath = path.join(root, `${fresh.invoice_number}.pdf`);
  fs.writeFileSync(pdfPath, buffer);

  await db('invoices').where({ id: invoice.id }).update({ pdf_path: pdfPath, updated_at: new Date() });

  // days_overdue floors at 1 — a reminder that fires with "0 days
  // overdue" reads as broken to the customer ("Why am I getting this
  // already?"). The scheduler only triggers the row once
  // due_date <= now - reminder_first_days, so the natural minimum is
  // the configured threshold; for the manual "Send reminder now"
  // path the admin's intent is "this customer is late", so 1 is the
  // sensible lower bound even if the calendar arithmetic disagrees.
  const rawDaysOverdue = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
  const daysOverdue = Math.max(1, rawDaysOverdue);
  const templateKey = level === 1 ? 'invoice_reminder_first' : 'invoice_reminder_second';

  // Outstanding = gross total + late fee − already paid. Reminder
  // templates use this for the "outstanding is X" line so partial
  // payments are reflected in the reminder amount.
  const outstandingMinor = Math.max(0,
    Number(invoice.total_amount_minor || 0)
    + Number(lateFeeMinor || 0)
    - Number(invoice.paid_amount_minor || 0));

  await emailProcessor.queueEmail(invoice.event_id || null, customer.email, templateKey, {
    invoice_number: invoice.invoice_number,
    customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
    total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, ctx.locale),
    new_total_amount: formatMajor(newTotal, invoice.currency, ctx.locale),
    outstanding_amount: formatMajor(outstandingMinor, invoice.currency, ctx.locale),
    paid_amount: formatMajor(invoice.paid_amount_minor, invoice.currency, ctx.locale),
    late_fee_amount: formatMajor(lateFeeMinor, invoice.currency, ctx.locale),
    // Format dates as DD.MM.YYYY for the customer-facing email
    // (matches the quote_sent + invoice_sent templates).
    due_date: formatShortDate(invoice.due_date),
    days_overdue: daysOverdue,
    cc: invoice.cc_pdf_email || undefined,
    attachments: [{
      filename: `${invoice.invoice_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }],
  });

  try {
    await logActivity('invoice_reminder_sent', { invoiceId: invoice.id, level, lateFeeMinor },
      invoice.event_id || null, `admin:${adminId || 'system'}`);
  } catch (_) {}

  return { level, lateFeeMinor };
}

// ---------------------------------------------------------------------
// Payment-check workflow (admin-confirmed reminders)
// ---------------------------------------------------------------------

/**
 * Resolve the admin email address that should receive the payment-
 * check prompt. Priority:
 *   1. created_by_admin_id's email (the admin who issued the invoice)
 *   2. First admin user with bills.manage permission
 *   3. business_profile.email as a last resort
 * Returns null when nothing usable is found — caller logs + skips.
 */
async function resolveAdminEmailForInvoice(invoice) {
  if (invoice.created_by_admin_id) {
    const admin = await db('admin_users').where({ id: invoice.created_by_admin_id }).first();
    if (admin?.email) return { email: admin.email, name: admin.username || admin.email };
  }
  // Fallback: business_profile.email.
  const profile = await db('business_profile').where({ id: 1 }).first();
  if (profile?.email) return { email: profile.email, name: profile.company_name || profile.email };
  return null;
}

/**
 * Generate a fresh payment-check token for an invoice and queue the
 * admin email with three signed action buttons. Throttled to once
 * per 24h per invoice via invoices.last_payment_check_at.
 *
 * Returns { token, sent: bool, reason? } so callers can log /
 * surface the outcome.
 */
async function queuePaymentCheckEmail(invoiceId, { skipThrottle = false } = {}) {
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return { sent: false, reason: 'not_found' };
  if (!['sent', 'overdue'].includes(invoice.status)) {
    return { sent: false, reason: `wrong_status_${invoice.status}` };
  }
  const now = new Date();
  if (!skipThrottle && invoice.last_payment_check_at) {
    const last = new Date(invoice.last_payment_check_at).getTime();
    if (now.getTime() - last < 24 * 60 * 60 * 1000) {
      return { sent: false, reason: 'throttled_24h' };
    }
  }

  const adminContact = await resolveAdminEmailForInvoice(invoice);
  if (!adminContact?.email) {
    logger.warn('Payment-check email skipped — no admin email resolved', { invoiceId });
    return { sent: false, reason: 'no_admin_email' };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await db('invoice_payment_check_tokens').insert({
    invoice_id: invoiceId,
    token,
    expires_at: expiresAt,
    created_at: now,
  });
  await db('invoices').where({ id: invoiceId }).update({
    last_payment_check_at: now,
    updated_at: now,
  });

  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  const profile = await db('business_profile').where({ id: 1 }).first();
  const locale = invoice.language || profile?.default_locale || 'de';

  // Determine whether the customer reminder will include a Mahngebühr
  // if the admin selects "Not paid" / "Partial" — surfaced to the
  // email so the admin sees the consequence before clicking.
  const reminderLateFeeEnabled = (await getAppSetting('crm_invoices_late_fee_enabled')) !== false;
  const reminderFeeMinor = ensureInt(await getAppSetting('crm_invoices_late_fee_minor')) || 2500;
  const nextLevel = (invoice.reminder_level || 0) + 1;
  const willChargeFee = reminderLateFeeEnabled && nextLevel >= 2;

  const baseUrl = process.env.FRONTEND_URL
    || (await getAppSetting('app_frontend_url'))
    || 'https://app.example.com';
  const buildUrl = (action) =>
    `${baseUrl.replace(/\/$/, '')}/payment-check/${token}?action=${action}`;

  // Outstanding = gross total + late fee − already paid. The admin
  // is being asked about what's STILL OWED, not the original gross
  // figure — so surface outstanding + paid in the email context.
  // Partial payments logged earlier (e.g. via a previous admin
  // payment-check click) are reflected, so the admin doesn't get
  // asked "did the customer pay CHF 234?" when they already paid
  // CHF 134 of it.
  const paidMinor = Number(invoice.paid_amount_minor || 0);
  const lateFeeAlreadyMinor = Number(invoice.late_fee_amount_minor || 0);
  const outstandingMinor = Math.max(0,
    Number(invoice.total_amount_minor || 0) + lateFeeAlreadyMinor - paidMinor);
  const hasPartial = paidMinor > 0;

  await emailProcessor.queueEmail(invoice.event_id || null, adminContact.email,
    'invoice_payment_check_admin', {
      invoice_number: invoice.invoice_number,
      customer_name: customer?.company_name
        || customer?.display_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.email || '',
      event_name: '',
      due_date: formatShortDate(invoice.due_date),
      total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, locale),
      paid_amount: formatMajor(paidMinor, invoice.currency, locale),
      outstanding_amount: formatMajor(outstandingMinor, invoice.currency, locale),
      has_partial_payment: hasPartial,
      paid_url:    buildUrl('paid_full'),
      partial_url: buildUrl('partial'),
      unpaid_url:  buildUrl('unpaid'),
      late_fee_due: willChargeFee,
      late_fee_amount: formatMajor(reminderFeeMinor, invoice.currency, locale),
    });

  try {
    await logActivity('invoice_payment_check_sent', { invoiceId, token: token.slice(0, 8) },
      invoice.event_id || null, 'scheduler');
  } catch (_) {}

  return { token, sent: true };
}

/**
 * Validate a payment-check token and return the invoice context
 * the public page needs. Token must exist, not be expired, not
 * already used.
 */
async function getPaymentCheckByToken(token) {
  const row = await db('invoice_payment_check_tokens').where({ token }).first();
  if (!row) throw new AppError('Token not found', 404);
  if (row.used_at) {
    const err = new AppError('This link has already been used', 410, 'TOKEN_ALREADY_USED');
    err.usedAt = row.used_at;
    err.usedAction = row.used_action;
    throw err;
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new AppError('This link has expired', 410, 'TOKEN_EXPIRED');
  }
  const invoice = await db('invoices').where({ id: row.invoice_id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();

  const outstandingMinor = Math.max(0,
    Number(invoice.total_amount_minor || 0) + Number(invoice.late_fee_amount_minor || 0)
    - Number(invoice.paid_amount_minor || 0));

  return {
    invoiceNumber: invoice.invoice_number,
    customer: {
      label: customer?.company_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.display_name || customer?.email || '',
      email: customer?.email,
    },
    issueDate: invoice.issue_date,
    dueDate: invoice.due_date,
    totalMinor: invoice.total_amount_minor,
    paidMinor: invoice.paid_amount_minor,
    lateFeeMinor: invoice.late_fee_amount_minor,
    outstandingMinor,
    currency: invoice.currency,
    status: invoice.status,
    reminderLevel: invoice.reminder_level,
    expiresAt: row.expires_at,
  };
}

/**
 * Record the admin's payment-check action and fire the downstream
 * consequences:
 *   - 'paid_full' → markPaid for the outstanding amount, no reminder.
 *   - 'partial'   → markPaid for the amount supplied, then fire the
 *                   next reminder for the remainder.
 *   - 'unpaid'    → fire the next reminder (level 1 or 2) with the
 *                   existing Mahngebühr logic in applyReminder.
 *
 * Atomic: token consumption + invoice status update happen in one
 * transaction. The reminder email is queued AFTER the txn commits
 * to avoid emailing a customer about a payment that never
 * actually committed.
 */
async function recordPaymentCheckAction({ token, action, amountMinor, ip, adminId }) {
  if (!['paid_full', 'partial', 'unpaid'].includes(action)) {
    throw new AppError('Invalid action', 400);
  }

  const row = await db('invoice_payment_check_tokens').where({ token }).first();
  if (!row) throw new AppError('Token not found', 404);
  if (row.used_at) {
    throw new AppError('This link has already been used', 410, 'TOKEN_ALREADY_USED');
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new AppError('This link has expired', 410, 'TOKEN_EXPIRED');
  }
  const invoice = await db('invoices').where({ id: row.invoice_id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);

  const outstandingMinor = Math.max(0,
    Number(invoice.total_amount_minor || 0) + Number(invoice.late_fee_amount_minor || 0)
    - Number(invoice.paid_amount_minor || 0));

  if (action === 'partial') {
    const amt = ensureInt(amountMinor);
    if (amt <= 0) throw new AppError('partial amount must be > 0', 400);
    if (amt > outstandingMinor) throw new AppError('partial amount exceeds outstanding', 400);
  }

  // Consume the token first — atomic with status update so a
  // double-click can't fire the action twice.
  const now = new Date();
  const updated = await db('invoice_payment_check_tokens')
    .where({ id: row.id })
    .whereNull('used_at')
    .update({
      used_at: now,
      used_action: action,
      used_amount_minor: action === 'partial' ? ensureInt(amountMinor) : null,
      used_ip: ip || null,
    });
  if (updated === 0) {
    // Lost a race with another consumer.
    throw new AppError('This link has already been used', 410, 'TOKEN_ALREADY_USED');
  }

  try {
    await logActivity('invoice_payment_check_recorded',
      { invoiceId: invoice.id, action, amountMinor: amountMinor || null },
      invoice.event_id || null,
      adminId ? `admin:${adminId}` : 'public:payment-check');
  } catch (_) {}

  // --- Apply the action -----------------------------------------
  if (action === 'paid_full') {
    await markPaid(invoice.id, {
      amountMinor: outstandingMinor,
      paymentMethod: invoice.payment_method || 'bank_transfer',
      reference: invoice.payment_reference || null,
      notes: 'Confirmed via admin payment-check link',
    }, adminId || invoice.created_by_admin_id);
    return { applied: 'paid_full' };
  }

  if (action === 'partial') {
    const amt = ensureInt(amountMinor);
    await markPaid(invoice.id, {
      amountMinor: amt,
      paymentMethod: invoice.payment_method || 'bank_transfer',
      reference: invoice.payment_reference || null,
      notes: 'Partial payment confirmed via admin payment-check link',
    }, adminId || invoice.created_by_admin_id);
    // Then fire the customer reminder for the remainder, unless
    // markPaid flipped the invoice to paid (i.e. the partial
    // amount equalled the outstanding).
    const refreshed = await db('invoices').where({ id: invoice.id }).first();
    if (refreshed.status !== 'paid') {
      const nextLevel = (refreshed.reminder_level || 0) + 1;
      if (nextLevel <= 2) {
        const lineItems = await db('invoice_line_items')
          .where({ invoice_id: invoice.id }).orderBy('position', 'asc');
        await applyReminder(refreshed, lineItems, nextLevel, adminId);
      }
    }
    return { applied: 'partial' };
  }

  // 'unpaid'
  const nextLevel = (invoice.reminder_level || 0) + 1;
  if (nextLevel > 2) {
    // Already at max reminder — admin has to take this offline.
    return { applied: 'unpaid', reminderSkipped: 'max_level_reached' };
  }
  const lineItems = await db('invoice_line_items')
    .where({ invoice_id: invoice.id }).orderBy('position', 'asc');
  await applyReminder(invoice, lineItems, nextLevel, adminId);
  return { applied: 'unpaid', reminderLevel: nextLevel };
}

/**
 * Cron tick — find scheduled invoices ready to send + invoices past
 * due date that need a reminder. Called by invoiceSchedulerService.
 */
async function runScheduledTasks() {
  const now = new Date();

  // 1. Flush scheduled invoices.
  const ready = await db('invoices')
    .where({ status: 'scheduled' })
    .andWhere(function() {
      this.whereNotNull('scheduled_send_at').andWhere('scheduled_send_at', '<=', now);
    })
    .limit(20);
  for (const inv of ready) {
    try {
      await sendInvoice(inv.id, null);
    } catch (err) {
      logger.error('Scheduled invoice send failed', { invoiceId: inv.id, err: err.message });
    }
  }

  // 2. Overdue payment-check prompts (if reminders enabled).
  //
  // NEW behavior (migration 115/116): instead of auto-firing the
  // customer reminder when an invoice goes overdue, we email the
  // ADMIN with three signed-token action buttons:
  //   - Paid in full  → markPaid for the outstanding amount
  //   - Partial       → admin enters amount; partial + reminder
  //   - Not paid yet  → reminder fires (with Mahngebühr at level 2)
  //
  // The reminder thresholds still gate when the prompt fires:
  //   - level 0 invoice past firstCutoff  → prompt for level-1 path
  //   - level 1 invoice past secondCutoff → prompt for level-2 path
  // Throttled to one email per 24h per invoice via
  // invoices.last_payment_check_at.
  const remindersEnabled = await getAppSetting('crm_invoices_reminders_enabled');
  if (remindersEnabled !== false) {
    const firstDays  = ensureInt(await getAppSetting('crm_invoices_reminder_first_days')) || 14;
    const secondDays = ensureInt(await getAppSetting('crm_invoices_reminder_second_days')) || 30;

    const firstCutoff  = new Date(now.getTime() - firstDays  * 86400000);
    const secondCutoff = new Date(now.getTime() - secondDays * 86400000);

    // Pre-reminder check (would-be-level-1).
    const firstBatch = await db('invoices')
      .whereIn('status', ['sent', 'overdue'])
      .where('reminder_level', 0)
      .where('due_date', '<=', firstCutoff)
      .limit(20);
    for (const inv of firstBatch) {
      try {
        await queuePaymentCheckEmail(inv.id);
      } catch (err) {
        logger.error('Payment-check email failed', { invoiceId: inv.id, err: err.message });
      }
    }

    // Pre-reminder check (would-be-level-2, including Mahngebühr).
    const secondBatch = await db('invoices')
      .whereIn('status', ['sent', 'overdue'])
      .where('reminder_level', 1)
      .where('due_date', '<=', secondCutoff)
      .limit(20);
    for (const inv of secondBatch) {
      try {
        await queuePaymentCheckEmail(inv.id);
      } catch (err) {
        logger.error('Payment-check email (level 2) failed', { invoiceId: inv.id, err: err.message });
      }
    }
  }
}

function formatMajor(minor, currency, locale) {
  return new Intl.NumberFormat(locale === 'de' ? 'de-CH' : 'en-GB', {
    style: 'currency', currency: (currency || 'CHF').toUpperCase(),
  }).format(Number(minor || 0) / 100);
}

/**
 * Format a date as DD.MM.YYYY for customer-facing email templates.
 * Duplicate of the helper in quoteService — kept local to avoid the
 * services growing a circular dep.
 */
function formatShortDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

module.exports = {
  listInvoices,
  getInvoiceById,
  createInvoice,
  scheduleInvoicesForEvent,
  sendInvoice,
  sendReminder,
  markPaid,
  cancelInvoice,
  releaseForDelivery,
  reissueInvoice,
  queuePaymentCheckEmail,
  getPaymentCheckByToken,
  recordPaymentCheckAction,
  renderInvoicePdfBuffer,
  renderInvoicePdfFromPayload,
  runScheduledTasks,
};
