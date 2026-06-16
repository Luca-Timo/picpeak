/**
 * Accounting service — two separate concepts (split in migration 126):
 *
 *   INCOMING INVOICES (external)  → the `inbound_documents` row IS the payable.
 *     It carries its own disposition, supplier-payment, booking (event_id, NULL
 *     = company) and re-bill linkage. A supplier invoice never creates an
 *     `expenses` row, so it appears ONLY in the incoming-invoices surface.
 *
 *   EXPENSES (internal)           → `expenses` rows are own costs entered by
 *     staff: kind = amount | mileage(km) | per_diem, amount = quantity x rate
 *     (rate from accounting settings, per-entry override), optional proof file,
 *     booked to an event or the company. No supplier payment (you incur these).
 *
 * Money is integer minor units. VAT/tax handling is v1 (capture only) — verify
 * with a Treuhaender.
 */
const crypto = require('crypto');
const fsp = require('fs').promises;
const { PDFDocument } = require('pdf-lib');
const { db, logActivity } = require('../database/db');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');
const invoiceService = require('./invoiceService');

const DISPOSITIONS = ['rebill', 'durchlaufend', 'eigener_aufwand', 'duplikat', 'abgelehnt'];
const TAX_TREATMENTS = ['domestic', 'reverse_charge_service', 'foreign_vat_non_reclaimable', 'import_goods'];
const MARKUP_TYPES = ['none', 'percent', 'flat'];
const PAYMENT_METHODS = ['bank_transfer', 'cash', 'twint', 'paypal', 'card', 'other'];
const EXPENSE_KINDS = ['amount', 'mileage', 'per_diem'];

const DISPOSITION_DOC_STATUS = {
  rebill: 'categorized',
  durchlaufend: 'categorized',
  eigener_aufwand: 'categorized',
  duplikat: 'duplicate',
  abgelehnt: 'declined',
};

function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// ── Accounting settings (app_settings, type 'accounting') ───────────────────
async function getAccountingSettings() {
  const keys = ['accounting_km_rate_minor', 'accounting_per_diem_rate_minor', 'accounting_require_proof'];
  let rows = [];
  try {
    rows = await db('app_settings').whereIn('setting_key', keys).select('setting_key', 'setting_value');
  } catch (_e) { /* table may not exist in some test harnesses */ }
  const map = {};
  for (const r of rows) {
    let v = r.setting_value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_e) { /* keep raw */ } }
    map[r.setting_key] = v;
  }
  return {
    kmRateMinor: Number.isFinite(Number(map.accounting_km_rate_minor)) ? Number(map.accounting_km_rate_minor) : 0,
    perDiemRateMinor: Number.isFinite(Number(map.accounting_per_diem_rate_minor)) ? Number(map.accounting_per_diem_rate_minor) : 0,
    requireProof: map.accounting_require_proof === true || map.accounting_require_proof === 1 || map.accounting_require_proof === '1',
  };
}

// ── Incoming invoices (inbound_documents) ───────────────────────────────────
function transformInbound(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    status: row.status,
    parseStatus: row.parse_status,
    parseMethod: row.parse_method,
    pageCount: row.page_count,
    supplierName: row.supplier_name,
    invoiceNumber: row.invoice_number,
    invoiceDate: toIsoDate(row.invoice_date),
    dueDate: toIsoDate(row.due_date),
    currency: row.currency,
    netAmountMinor: row.net_amount_minor,
    vatAmountMinor: row.vat_amount_minor,
    totalAmountMinor: row.total_amount_minor,
    qrAmountMinor: row.qr_amount_minor,
    iban: row.iban,
    paymentReference: row.payment_reference,
    duplicateOfId: row.duplicate_of_id,
    // classification + booking (migration 126)
    disposition: row.disposition,
    taxTreatment: row.tax_treatment,
    eventId: row.event_id,
    categoryId: row.category_id,
    markupType: row.markup_type,
    markupPercent: row.markup_percent != null ? Number(row.markup_percent) : null,
    markupFlatMinor: row.markup_flat_minor,
    billedInvoiceId: row.billed_invoice_id,
    billedInvoiceLineItemId: row.billed_invoice_line_item_id,
    // supplier payment (paid on the incoming invoice itself)
    supplierPaid: !!row.supplier_paid,
    supplierPaidAt: row.supplier_paid_at,
    supplierPaymentMethod: row.supplier_payment_method,
    supplierPaymentRef: row.supplier_payment_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampPage(page, pageSize) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25));
  return { p, ps };
}

async function inspectFile(filePath, mimeType) {
  const buf = await fsp.readFile(filePath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  let pageCount = null;
  if ((mimeType || '').includes('pdf')) {
    try {
      const pdf = await PDFDocument.load(buf, { updateMetadata: false });
      pageCount = pdf.getPageCount();
    } catch (e) {
      logger.warn?.(`expenseService: PDF page count failed for ${filePath}: ${e.message}`);
    }
  }
  return { sha, pageCount };
}

async function recordInboundDocument({ source, filePath, originalFilename, mimeType }, adminId) {
  let fileSha256 = null;
  let pageCount = null;
  try {
    const info = await inspectFile(filePath, mimeType);
    fileSha256 = info.sha; pageCount = info.pageCount;
  } catch (e) {
    logger.warn?.(`expenseService: could not inspect ${filePath}: ${e.message}`);
  }

  let duplicateOfId = null;
  if (fileSha256) {
    const dup = await db('inbound_documents').where({ file_sha256: fileSha256 }).first('id');
    if (dup) duplicateOfId = dup.id;
  }

  const now = new Date();
  const row = {
    source: source || 'upload',
    original_filename: originalFilename || null,
    file_path: filePath,
    mime_type: mimeType || null,
    file_sha256: fileSha256,
    status: duplicateOfId ? 'duplicate' : 'unsorted',
    parse_status: 'pending',
    parse_method: 'none',
    // Cap stored page_count to the renderable max (rasterizeService
    // MAX_RENDERABLE_PAGES) so a hostile high-page PDF can't drive an
    // unbounded inbox pager (PR #622 concern 6).
    page_count: pageCount != null ? Math.min(pageCount, 200) : null,
    duplicate_of_id: duplicateOfId,
    created_by_admin_id: adminId || null,
    created_at: now,
    updated_at: now,
  };
  const inserted = await db('inbound_documents').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  await logActivity('incoming_invoice_captured', { inboundDocumentId: id, source: row.source, duplicate: !!duplicateOfId }, adminId);
  return getInbound(id);
}

async function getInbound(id) {
  const row = await db('inbound_documents').where({ id }).first();
  if (!row) throw new AppError('Incoming invoice not found', 404, 'INBOUND_NOT_FOUND');
  return transformInbound(row);
}

async function listInbound({ status, page, pageSize } = {}) {
  const { p, ps } = clampPage(page, pageSize);
  const base = db('inbound_documents');
  if (status) base.where({ status });
  const countRow = await base.clone().count({ count: '*' }).first();
  const total = parseInt(countRow?.count || 0, 10);
  const rows = await base.clone().orderBy('created_at', 'desc').limit(ps).offset((p - 1) * ps);
  return { items: rows.map(transformInbound), pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) } };
}

const INBOUND_EDITABLE = {
  supplierName: 'supplier_name', invoiceNumber: 'invoice_number', invoiceDate: 'invoice_date',
  dueDate: 'due_date', currency: 'currency', netAmountMinor: 'net_amount_minor',
  vatAmountMinor: 'vat_amount_minor', totalAmountMinor: 'total_amount_minor', iban: 'iban',
  paymentReference: 'payment_reference',
};

async function updateInbound(id, payload, adminId) {
  await getInbound(id);
  const patch = { updated_at: new Date(), parse_status: 'manual' };
  for (const [camel, snake] of Object.entries(INBOUND_EDITABLE)) {
    if (payload[camel] !== undefined) patch[snake] = payload[camel] === '' ? null : payload[camel];
  }
  await db('inbound_documents').where({ id }).update(patch);
  await logActivity('incoming_invoice_updated', { inboundDocumentId: id }, adminId);
  return getInbound(id);
}

// markup helpers (shared with re-bill)
async function resolveMarkup(source, override, contractId, trx) {
  const pick = (type, percent, flatMinor) => ({
    type: MARKUP_TYPES.includes(type) ? type : 'none',
    percent: percent != null ? Number(percent) : null,
    flatMinor: Number.isInteger(flatMinor) ? flatMinor : null,
  });
  if (override && override.markupType && override.markupType !== 'none') {
    return pick(override.markupType, override.markupPercent, override.markupFlatMinor);
  }
  if (source && source.markupType && source.markupType !== 'none') {
    return pick(source.markupType, source.markupPercent, source.markupFlatMinor);
  }
  const { hasColumnCached } = require('../utils/schemaCache');
  if (contractId && (await hasColumnCached('contracts', 'expense_markup_type'))) {
    const c = await (trx || db)('contracts').where({ id: contractId })
      .first('expense_markup_type', 'expense_markup_percent', 'expense_markup_flat_minor');
    if (c && c.expense_markup_type && c.expense_markup_type !== 'none') {
      return pick(c.expense_markup_type, c.expense_markup_percent, c.expense_markup_flat_minor);
    }
  }
  return pick('none', null, null);
}

function computeMarkupMinor(baseMinor, markup) {
  if (markup.type === 'percent' && markup.percent != null) return Math.round(baseMinor * Number(markup.percent) / 100);
  if (markup.type === 'flat' && Number.isInteger(markup.flatMinor)) return markup.flatMinor;
  return 0;
}

/** Re-bill an incoming invoice to a client (mints an editable scheduled invoice). */
async function rebillInbound(id, payload, adminId, trx0) {
  const run = async (trx) => {
    const row = await trx('inbound_documents').where({ id }).first();
    if (!row) throw new AppError('Incoming invoice not found', 404, 'INBOUND_NOT_FOUND');
    const doc = transformInbound(row);
    if (doc.billedInvoiceId) throw new AppError('Already re-billed', 409, 'ALREADY_BILLED');
    if (!payload.customerAccountId) throw new AppError('customerAccountId is required to re-bill', 400, 'CUSTOMER_REQUIRED');
    const base = doc.totalAmountMinor != null ? doc.totalAmountMinor : doc.netAmountMinor;
    if (base == null) throw new AppError('Incoming invoice has no amount to re-bill', 400, 'AMOUNT_REQUIRED');

    const markup = await resolveMarkup(
      { markupType: doc.markupType, markupPercent: doc.markupPercent, markupFlatMinor: doc.markupFlatMinor },
      payload, payload.contractId, trx,
    );
    const lineTotal = base + computeMarkupMinor(base, markup);
    const label = doc.supplierName || 'Weiterverrechnete Auslage';
    const { invoiceIds } = await invoiceService.createInvoice({
      customerAccountId: payload.customerAccountId,
      eventId: payload.eventId || doc.eventId || null,
      lineItems: [{ description: `${label} (Weiterverrechnung)`, quantity: 1, unit_price_minor: lineTotal, discount_percent: 0, line_total_minor: lineTotal }],
    }, adminId, trx);
    const invoiceId = Array.isArray(invoiceIds) ? invoiceIds[0] : null;
    if (!invoiceId) throw new AppError('Failed to create the re-bill invoice', 500, 'REBILL_FAILED');
    const line = await trx('invoice_line_items').where({ invoice_id: invoiceId }).orderBy('id', 'desc').first('id');

    await trx('inbound_documents').where({ id }).update({
      disposition: 'rebill',
      status: 'categorized',
      event_id: payload.eventId || doc.eventId || null,
      markup_type: markup.type,
      markup_percent: markup.type === 'percent' ? markup.percent : null,
      markup_flat_minor: markup.type === 'flat' ? markup.flatMinor : null,
      billed_invoice_id: invoiceId,
      billed_invoice_line_item_id: line ? line.id : null,
      updated_at: new Date(),
    });
    await logActivity('incoming_invoice_rebilled', { inboundDocumentId: id, invoiceId }, adminId);
    return invoiceId;
  };
  const invoiceId = trx0 ? await run(trx0) : await db.transaction(run);
  return { document: await getInbound(id), invoiceId };
}

/** Give an incoming invoice a disposition (updates the document, no expense row). */
async function categorizeInbound(id, payload, adminId) {
  const doc = await getInbound(id);
  const disposition = payload.disposition;
  if (!DISPOSITIONS.includes(disposition)) {
    throw new AppError(`disposition must be one of ${DISPOSITIONS.join(', ')}`, 400, 'BAD_DISPOSITION');
  }
  if (disposition === 'rebill') {
    const { document } = await rebillInbound(id, payload, adminId);
    // also stamp tax_treatment/category/event from payload
    await db('inbound_documents').where({ id }).update({
      tax_treatment: TAX_TREATMENTS.includes(payload.taxTreatment) ? payload.taxTreatment : (document.taxTreatment || 'domestic'),
      category_id: payload.categoryId || null,
      updated_at: new Date(),
    });
    return getInbound(id);
  }
  const patch = {
    disposition,
    tax_treatment: TAX_TREATMENTS.includes(payload.taxTreatment) ? payload.taxTreatment : 'domestic',
    event_id: payload.eventId || null, // null = company
    category_id: disposition === 'eigener_aufwand' ? (payload.categoryId || null) : null,
    status: DISPOSITION_DOC_STATUS[disposition] || 'categorized',
    updated_at: new Date(),
  };
  if (disposition === 'duplikat' && payload.duplicateOfId) patch.duplicate_of_id = payload.duplicateOfId;
  await db('inbound_documents').where({ id }).update(patch);
  await logActivity('incoming_invoice_categorized', { inboundDocumentId: id, disposition }, adminId);
  return getInbound(id);
}

/** Mark the supplier paid on the incoming invoice (the payable lives here). */
async function markInboundSupplierPayment(id, { paid, paidAt, paymentMethod, paymentReference }, adminId) {
  await getInbound(id);
  if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
    throw new AppError(`paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}`, 400, 'BAD_PAYMENT_METHOD');
  }
  await db('inbound_documents').where({ id }).update({
    supplier_paid: !!paid,
    supplier_paid_at: paid ? (paidAt ? new Date(paidAt) : new Date()) : null,
    supplier_payment_method: paid ? (paymentMethod || null) : null,
    supplier_payment_ref: paid ? (paymentReference || null) : null,
    updated_at: new Date(),
  });
  await logActivity('incoming_invoice_supplier_payment', { inboundDocumentId: id, paid: !!paid }, adminId);
  return getInbound(id);
}

// ── Expenses (internal) ─────────────────────────────────────────────────────
function transformExpense(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind || 'amount',
    quantity: row.quantity != null ? Number(row.quantity) : null,
    rateMinor: row.rate_minor,
    eventId: row.event_id, // null = company
    supplierName: row.supplier_name,
    description: row.description,
    chfAmountMinor: row.chf_amount_minor,
    categoryId: row.category_id,
    receiptPath: row.receipt_path,
    hasProof: !!row.receipt_path,
    taxTreatment: row.tax_treatment,
    // invoiced = added to a real client invoice (locks editing); paid = settled.
    billedInvoiceId: row.billed_invoice_id,
    billedInvoiceLineItemId: row.billed_invoice_line_item_id,
    invoiced: !!row.billed_invoice_id,
    customerAccountId: row.customer_account_id,
    paid: !!row.supplier_paid,
    paidAt: row.supplier_paid_at,
    paymentMethod: row.payment_method,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Compute the booked amount (minor) for an internal expense. */
function computeExpenseAmount(kind, quantity, rateMinor, amountMinor) {
  if (kind === 'mileage' || kind === 'per_diem') {
    if (quantity != null && rateMinor != null) return Math.round(Number(quantity) * Number(rateMinor));
    return null;
  }
  return Number.isInteger(amountMinor) ? amountMinor : null;
}

function buildExpenseInsert(payload, adminId, opts = {}) {
  const now = new Date();
  const kind = EXPENSE_KINDS.includes(payload.kind) ? payload.kind : 'amount';
  let rateMinor = null;
  if (kind === 'mileage') rateMinor = Number.isInteger(payload.rateMinor) ? payload.rateMinor : (opts.kmRateMinor ?? null);
  else if (kind === 'per_diem') rateMinor = Number.isInteger(payload.rateMinor) ? payload.rateMinor : (opts.perDiemRateMinor ?? null);
  const quantity = (kind === 'mileage' || kind === 'per_diem') && payload.quantity != null ? Number(payload.quantity) : null;
  const chf = computeExpenseAmount(kind, quantity, rateMinor, payload.chfAmountMinor);
  return {
    inbound_document_id: null,
    disposition: 'eigener_aufwand', // internal expenses are always own-cost
    tax_treatment: TAX_TREATMENTS.includes(payload.taxTreatment) ? payload.taxTreatment : 'domestic',
    event_id: payload.eventId || null, // null = company
    supplier_name: payload.supplierName || null,
    description: payload.description || null,
    kind,
    quantity,
    rate_minor: rateMinor,
    chf_amount_minor: chf,
    gross_amount_minor: chf,
    category_id: payload.categoryId || null,
    receipt_path: opts.receiptPath || null,
    status: 'open',
    created_by_admin_id: adminId || null,
    created_at: now,
    updated_at: now,
  };
}

async function getExpense(id) {
  const row = await db('expenses').where({ id }).first();
  if (!row) throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
  return transformExpense(row);
}

async function createExpense(payload, adminId, { receiptPath } = {}) {
  const settings = await getAccountingSettings();
  if (settings.requireProof && !receiptPath) {
    throw new AppError('A proof file is required for expenses', 400, 'PROOF_REQUIRED');
  }
  const row = buildExpenseInsert(payload, adminId, {
    receiptPath,
    kmRateMinor: settings.kmRateMinor,
    perDiemRateMinor: settings.perDiemRateMinor,
  });
  const inserted = await db('expenses').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  await logActivity('expense_created', { expenseId: id, kind: row.kind }, adminId);
  return getExpense(id);
}

async function listExpenses({ kind, eventId, categoryId, page, pageSize } = {}) {
  const { p, ps } = clampPage(page, pageSize);
  const base = db('expenses').where({ inbound_document_id: null }); // internal only
  if (kind) base.where({ kind });
  if (categoryId) base.where({ category_id: categoryId });
  if (eventId === 'company') base.whereNull('event_id');
  else if (eventId) base.where({ event_id: eventId });
  const countRow = await base.clone().count({ count: '*' }).first();
  const total = parseInt(countRow?.count || 0, 10);
  const rows = await base.clone().orderBy('created_at', 'desc').limit(ps).offset((p - 1) * ps);
  return { items: rows.map(transformExpense), pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) } };
}

const EXPENSE_EDITABLE = {
  supplierName: 'supplier_name', description: 'description', taxTreatment: 'tax_treatment',
  eventId: 'event_id', categoryId: 'category_id',
};

async function updateExpense(id, payload, adminId, { receiptPath } = {}) {
  const existing = await getExpense(id);
  if (existing.invoiced) {
    throw new AppError('Expense is invoiced — editing is locked', 409, 'EXPENSE_LOCKED');
  }
  const patch = { updated_at: new Date() };
  for (const [camel, snake] of Object.entries(EXPENSE_EDITABLE)) {
    if (payload[camel] !== undefined) patch[snake] = payload[camel] === '' ? null : payload[camel];
  }
  if (receiptPath) patch.receipt_path = receiptPath;
  await db('expenses').where({ id }).update(patch);
  await logActivity('expense_updated', { expenseId: id }, adminId);
  return getExpense(id);
}

/** Add an internal expense onto a client invoice (mints a line). Marks it
 *  invoiced (locks editing) + links the invoice. base = chf amount + markup. */
async function rebillExpense(id, payload, adminId, trx0) {
  const run = async (trx) => {
    const row = await trx('expenses').where({ id }).first();
    if (!row) throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    const exp = transformExpense(row);
    if (exp.invoiced) throw new AppError('Expense already invoiced', 409, 'ALREADY_INVOICED');
    if (!payload.customerAccountId) throw new AppError('customerAccountId is required', 400, 'CUSTOMER_REQUIRED');
    const base = exp.chfAmountMinor;
    if (base == null) throw new AppError('Expense has no amount to invoice', 400, 'AMOUNT_REQUIRED');
    const markup = await resolveMarkup(
      { markupType: row.markup_type, markupPercent: row.markup_percent, markupFlatMinor: row.markup_flat_minor },
      payload, payload.contractId, trx,
    );
    const lineTotal = base + computeMarkupMinor(base, markup);
    const label = exp.description || exp.supplierName || 'Aufwand';
    const { invoiceIds } = await invoiceService.createInvoice({
      customerAccountId: payload.customerAccountId,
      eventId: payload.eventId || exp.eventId || null,
      lineItems: [{ description: `${label} (Weiterverrechnung)`, quantity: 1, unit_price_minor: lineTotal, discount_percent: 0, line_total_minor: lineTotal }],
    }, adminId, trx);
    const invoiceId = Array.isArray(invoiceIds) ? invoiceIds[0] : null;
    if (!invoiceId) throw new AppError('Failed to create invoice', 500, 'INVOICE_FAILED');
    const line = await trx('invoice_line_items').where({ invoice_id: invoiceId }).orderBy('id', 'desc').first('id');
    await trx('expenses').where({ id }).update({
      billed_invoice_id: invoiceId,
      billed_invoice_line_item_id: line ? line.id : null,
      billed_at: new Date(),
      customer_account_id: payload.customerAccountId,
      markup_type: markup.type,
      markup_percent: markup.type === 'percent' ? markup.percent : null,
      markup_flat_minor: markup.type === 'flat' ? markup.flatMinor : null,
      status: 'invoiced',
      updated_at: new Date(),
    });
    await logActivity('expense_invoiced', { expenseId: id, invoiceId }, adminId);
    return invoiceId;
  };
  const invoiceId = trx0 ? await run(trx0) : await db.transaction(run);
  return { expense: await getExpense(id), invoiceId };
}

/** Mark an expense paid/settled (manual). */
async function markExpensePaid(id, { paid, paidAt, paymentMethod, paymentReference }, adminId) {
  await getExpense(id);
  if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
    throw new AppError(`paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}`, 400, 'BAD_PAYMENT_METHOD');
  }
  await db('expenses').where({ id }).update({
    supplier_paid: !!paid,
    supplier_paid_at: paid ? (paidAt ? new Date(paidAt) : new Date()) : null,
    payment_method: paid ? (paymentMethod || null) : null,
    payment_reference: paid ? (paymentReference || null) : null,
    updated_at: new Date(),
  });
  await logActivity('expense_paid', { expenseId: id, paid: !!paid }, adminId);
  return getExpense(id);
}

module.exports = {
  getAccountingSettings,
  rebillExpense,
  markExpensePaid,
  // incoming invoices
  recordInboundDocument,
  getInbound,
  listInbound,
  updateInbound,
  categorizeInbound,
  rebillInbound,
  markInboundSupplierPayment,
  // expenses
  createExpense,
  getExpense,
  listExpenses,
  updateExpense,
  // constants
  DISPOSITIONS,
  TAX_TREATMENTS,
  MARKUP_TYPES,
  PAYMENT_METHODS,
  EXPENSE_KINDS,
  // unit-test surface
  _internal: { computeMarkupMinor, resolveMarkup, computeExpenseAmount, buildExpenseInsert, transformExpense, transformInbound },
};
