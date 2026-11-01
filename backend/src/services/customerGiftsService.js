/**
 * Customer gifts and gift stock (migration 343).
 *
 * Who qualifies is worked out from paid invoices when a list loads
 * (customerGiftRules); only an admin's decisions are stored. Three rules the
 * rest of the code relies on:
 *   - a gift and its stock movement are written in one transaction, and the
 *     count is checked inside it, so two gifts can't take the last unit;
 *   - stock is always the sum of the movements, never a stored total;
 *   - gift data is admin-only and never reaches the customer portal.
 *
 * Activity is logged after commit: a global-db write inside a transaction
 * deadlocks on the single SQLite connection.
 */

const { db, logActivity } = require('../database/db');
const { AppError, NotFoundError } = require('../utils/errors');
const { isUniqueViolation } = require('../utils/dbErrors');
const { formatBoolean } = require('../utils/dbCompat');
const { auditedUpdate } = require('./accountingHistory');
const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');
const businessProfileService = require('./businessProfileService');
const rules = require('./customerGiftRules');

const SETTING_KEYS = {
  milestoneYears: 'gift_milestone_years',
  minBookings: 'gift_min_bookings',
  activityMinInvoices: 'gift_activity_min_invoices',
  activityPeriodYears: 'gift_activity_period_years',
  rhythmMarginMonths: 'gift_rhythm_margin_months',
  graceDays: 'gift_grace_days',
};

const adminActor = (admin) => ({
  type: 'admin', id: admin.id, name: admin.username || `Admin #${admin.id}`,
});

const insertedId = (inserted) => (typeof inserted === 'object' ? inserted.id : inserted);

/** Date and timestamp columns read back differently per engine; this is the one shape. */
function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  if (typeof value === 'number') return new Date(value).toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

const today = () => toDateOnly(new Date());

// ---- rules ---------------------------------------------------------------

async function getRules() {
  const rows = await db('app_settings')
    .whereIn('setting_key', Object.values(SETTING_KEYS))
    .select('setting_key', 'setting_value');
  const stored = new Map(rows.map((row) => [row.setting_key, row.setting_value]));
  const out = { ...rules.DEFAULT_RULES };
  for (const [field, key] of Object.entries(SETTING_KEYS)) {
    if (!stored.has(key)) continue;
    try {
      out[field] = JSON.parse(stored.get(key));
    } catch {
      // A hand-edited value that isn't JSON keeps the default.
    }
  }
  return out;
}

async function updateRules(input, admin) {
  const current = await getRules();
  const next = { ...current, ...input };
  if (next.milestoneYears) {
    next.milestoneYears = [...new Set(next.milestoneYears.map(Number))].sort((a, b) => a - b);
  }
  await db.transaction(async (trx) => {
    for (const [field, key] of Object.entries(SETTING_KEYS)) {
      const value = JSON.stringify(next[field]);
      const updated = await trx('app_settings').where({ setting_key: key }).update({ setting_value: value });
      if (!updated) {
        await trx('app_settings').insert({
          setting_key: key,
          setting_value: value,
          setting_type: Array.isArray(next[field]) ? 'json' : 'number',
        });
      }
    }
  });
  await logActivity('customer_gift_rules_updated', { rules: next }, null, adminActor(admin));
  return next;
}

// ---- items and stock -----------------------------------------------------

function stockQuery(conn) {
  return conn('gift_stock_movements')
    .groupBy('gift_item_id')
    .select('gift_item_id')
    .sum({ stock: 'quantity_delta' });
}

async function stockOf(conn, itemId) {
  const row = await stockQuery(conn).where({ gift_item_id: itemId }).first();
  return Number(row?.stock || 0);
}

/** On PostgreSQL holds the item's row, so the count read next can't go stale. */
async function lockItem(trx, itemId) {
  const query = trx('gift_items').where({ id: itemId });
  if (trx.client.config.client === 'pg') query.forUpdate();
  const item = await query.first();
  if (!item) throw new NotFoundError('Gift item', itemId);
  return item;
}

function itemToApi(row, stock) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    isArchived: Boolean(row.is_archived),
    stock,
  };
}

async function listItems({ includeArchived = false } = {}) {
  const query = db('gift_items').orderBy('name');
  if (!includeArchived) query.where({ is_archived: formatBoolean(false) });
  const [items, stocks] = await Promise.all([query, stockQuery(db)]);
  const stockById = new Map(stocks.map((row) => [row.gift_item_id, Number(row.stock || 0)]));
  return items.map((item) => itemToApi(item, stockById.get(item.id) || 0));
}

async function createItem({ name, description }, admin) {
  const [inserted] = await db('gift_items').insert({
    name,
    description: description || null,
    created_by_admin_id: admin.id,
  }).returning('id');
  const id = insertedId(inserted);
  await logActivity('customer_gift_item_created', { giftItemId: id, name }, null, adminActor(admin));
  return itemToApi(await db('gift_items').where({ id }).first(), 0);
}

async function updateItem(id, fields, admin) {
  const existing = await db('gift_items').where({ id }).first();
  if (!existing) throw new NotFoundError('Gift item', id);
  const updates = { updated_at: new Date() };
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.description !== undefined) updates.description = fields.description || null;
  if (fields.isArchived !== undefined) updates.is_archived = formatBoolean(fields.isArchived);
  await db('gift_items').where({ id }).update(updates);
  await logActivity('customer_gift_item_updated', { giftItemId: id, name: updates.name || existing.name }, null, adminActor(admin));
  return itemToApi(await db('gift_items').where({ id }).first(), await stockOf(db, id));
}

function movementToApi(row) {
  return {
    id: row.id,
    kind: row.kind,
    quantityDelta: row.quantity_delta,
    unitCostMinor: row.unit_cost_minor === null ? null : Number(row.unit_cost_minor),
    currency: row.currency || null,
    inboundDocumentId: row.inbound_document_id || null,
    reason: row.reason || null,
    occurredOn: toDateOnly(row.occurred_on),
  };
}

async function listMovements(itemId) {
  const item = await db('gift_items').where({ id: itemId }).first();
  if (!item) throw new NotFoundError('Gift item', itemId);
  const rows = await db('gift_stock_movements')
    .where({ gift_item_id: itemId })
    .orderBy('occurred_on', 'desc')
    .orderBy('id', 'desc');
  return rows.map(movementToApi);
}

/**
 * Add stock. A supplier invoice is optional and needs both the incoming
 * invoices feature and access to accounting: it opens a document, so it gets
 * the same gate the document has.
 */
async function addStock(itemId, input, admin, { canReadInvoices }) {
  const { quantity, unitCostMinor, currency, occurredOn, inboundDocumentId, note } = input;
  let invoice = null;
  if (inboundDocumentId) {
    if (!canReadInvoices || !(await isFeatureEnabled('incomingInvoices'))) {
      throw new AppError('Linking a supplier invoice needs access to incoming invoices', 403, 'GIFT_INVOICE_FORBIDDEN');
    }
    invoice = await db('inbound_documents').where({ id: inboundDocumentId }).first();
    if (!invoice) throw new NotFoundError('Supplier invoice', inboundDocumentId);
  }
  const fallbackCurrency = invoice?.currency || (await businessProfileService.getProfile())?.default_currency;
  const movementId = await db.transaction(async (trx) => {
    await lockItem(trx, itemId);
    const [inserted] = await trx('gift_stock_movements').insert({
      gift_item_id: itemId,
      kind: 'purchase',
      quantity_delta: quantity,
      unit_cost_minor: unitCostMinor ?? null,
      currency: unitCostMinor === undefined || unitCostMinor === null
        ? null
        : (currency || fallbackCurrency || 'CHF').toUpperCase(),
      inbound_document_id: inboundDocumentId || null,
      reason: note || null,
      occurred_on: occurredOn || today(),
      created_by_admin_id: admin.id,
    }).returning('id');
    return insertedId(inserted);
  });
  await logActivity('customer_gift_stock_added', { giftItemId: itemId, quantity, inboundDocumentId: inboundDocumentId || null }, null, adminActor(admin));
  return movementToApi(await db('gift_stock_movements').where({ id: movementId }).first());
}

async function correctStock(itemId, { quantityDelta, reason, occurredOn }, admin) {
  const movementId = await db.transaction(async (trx) => {
    await lockItem(trx, itemId);
    if (await stockOf(trx, itemId) + quantityDelta < 0) {
      throw new AppError('A correction can\'t take stock below zero', 409, 'GIFT_STOCK_NEGATIVE');
    }
    const [inserted] = await trx('gift_stock_movements').insert({
      gift_item_id: itemId,
      kind: 'correction',
      quantity_delta: quantityDelta,
      reason,
      occurred_on: occurredOn || today(),
      created_by_admin_id: admin.id,
    }).returning('id');
    return insertedId(inserted);
  });
  await logActivity('customer_gift_stock_corrected', { giftItemId: itemId, quantityDelta, reason }, null, adminActor(admin));
  return movementToApi(await db('gift_stock_movements').where({ id: movementId }).first());
}

// ---- who qualifies -------------------------------------------------------

/** Paid invoices by customer. Storno rows and cancelled originals never count. */
async function paymentsByCustomer(customerIds) {
  const query = db('invoices')
    .where({ status: 'paid', kind: 'invoice' })
    .whereNull('cancels_invoice_id')
    .select('id', 'customer_account_id', 'deal_uuid', 'paid_at', 'issue_date');
  if (customerIds) query.whereIn('customer_account_id', customerIds);
  const rows = await query;
  const out = new Map();
  for (const row of rows) {
    const list = out.get(row.customer_account_id) || [];
    list.push({
      key: row.deal_uuid || `invoice-${row.id}`,
      paidOn: toDateOnly(row.paid_at || row.issue_date),
    });
    out.set(row.customer_account_id, list);
  }
  return out;
}

function eligibleCustomers() {
  return db('customer_accounts')
    .where({ is_active: formatBoolean(true), no_gifts: formatBoolean(false) })
    .whereNot('email', 'like', '%@deleted.invalid')
    .select('id', 'display_name', 'company_name', 'email', 'gift_start_date_override');
}

function suggestionToApi(customer, evaluation) {
  return {
    customerId: customer.id,
    customerName: customer.company_name || customer.display_name || customer.email,
    milestoneYears: evaluation.milestoneYears,
    milestoneDate: evaluation.milestoneDate,
    bookingCount: evaluation.bookingCount,
    lastPaidOn: evaluation.lastPaidOn,
    reason: evaluation.reason || null,
  };
}

/** The two lists on the Gifts page. A customer waiting out the grace period is on neither. */
async function listSuggestions() {
  const [customers, payments, closed, giftRules] = await Promise.all([
    eligibleCustomers(),
    paymentsByCustomer(),
    db('customer_gifts').whereNull('undone_at').whereNotNull('milestone_years')
      .select('customer_account_id', 'milestone_years'),
    getRules(),
  ]);
  const closedKeys = new Set(closed.map((row) => `${row.customer_account_id}:${row.milestone_years}`));
  const due = [];
  const notQualified = [];
  const date = today();
  for (const customer of customers) {
    const evaluation = rules.evaluate({
      payments: payments.get(customer.id) || [],
      startDateOverride: toDateOnly(customer.gift_start_date_override),
      today: date,
      rules: giftRules,
    });
    if (evaluation.state !== 'due' && evaluation.state !== 'not_qualified') continue;
    if (closedKeys.has(`${customer.id}:${evaluation.milestoneYears}`)) continue;
    (evaluation.state === 'due' ? due : notQualified).push(suggestionToApi(customer, evaluation));
  }
  const byDate = (a, b) => a.milestoneDate.localeCompare(b.milestoneDate);
  return { due: due.sort(byDate), notQualified: notQualified.sort(byDate) };
}

// ---- gifts ---------------------------------------------------------------

function giftToApi(row) {
  return {
    id: row.id,
    status: row.status,
    giftItemId: row.gift_item_id || null,
    itemName: row.item_name || null,
    milestoneYears: row.milestone_years ?? null,
    isOverride: Boolean(row.is_override),
    unitCostMinor: row.unit_cost_minor === null || row.unit_cost_minor === undefined
      ? null : Number(row.unit_cost_minor),
    currency: row.currency || null,
    note: row.note || null,
    giftDate: toDateOnly(row.gift_date),
    undone: Boolean(row.undone_at),
  };
}

async function customerOrThrow(customerId) {
  const customer = await db('customer_accounts').where({ id: customerId }).first();
  if (!customer) throw new NotFoundError('Customer', customerId);
  return customer;
}

async function getCustomerGifts(customerId) {
  const customer = await customerOrThrow(customerId);
  const rows = await db('customer_gifts as g')
    .leftJoin('gift_items as i', 'i.id', 'g.gift_item_id')
    .where('g.customer_account_id', customerId)
    .orderBy('g.gift_date', 'desc')
    .orderBy('g.id', 'desc')
    .select('g.*', 'i.name as item_name');
  return {
    noGifts: Boolean(customer.no_gifts),
    startDateOverride: toDateOnly(customer.gift_start_date_override),
    gifts: rows.map(giftToApi),
  };
}

async function updateCustomerPreferences(customerId, { noGifts, startDateOverride }, admin) {
  await customerOrThrow(customerId);
  const updates = {};
  if (noGifts !== undefined) updates.no_gifts = formatBoolean(noGifts);
  if (startDateOverride !== undefined) updates.gift_start_date_override = startDateOverride || null;
  if (Object.keys(updates).length > 0) {
    await auditedUpdate(db, 'customer_accounts', { id: customerId }, updates, {
      actor: admin.id, source: 'customer.gift_preferences',
    });
    await logActivity('customer_gift_preferences_updated', { customerId, noGifts, startDateOverride }, null, adminActor(admin));
  }
  return getCustomerGifts(customerId);
}

const milestoneTaken = () => new AppError('This milestone is already closed', 409, 'GIFT_MILESTONE_CLOSED');

async function latestPurchaseCost(trx, itemId) {
  const row = await trx('gift_stock_movements')
    .where({ gift_item_id: itemId, kind: 'purchase' })
    .whereNotNull('unit_cost_minor')
    .orderBy('occurred_on', 'desc')
    .orderBy('id', 'desc')
    .first();
  return row ? { unit_cost_minor: row.unit_cost_minor, currency: row.currency } : { unit_cost_minor: null, currency: null };
}

/**
 * Log a gift. `reduceStock: false` records a gift from before this feature,
 * which never came out of the counted stock. Without a milestone this is a gift
 * by hand; with one it closes that milestone. `isOverride` marks "Gift anyway".
 */
async function giveGift(customerId, input, admin) {
  const {
    giftItemId, giftDate, note, milestoneYears, isOverride = false, reduceStock = true,
  } = input;
  await customerOrThrow(customerId);
  let id;
  try {
    id = await db.transaction(async (trx) => {
      const item = await lockItem(trx, giftItemId);
      if (item.is_archived) throw new AppError('This gift item is archived', 409, 'GIFT_ITEM_ARCHIVED');
      if (reduceStock && await stockOf(trx, giftItemId) < 1) {
        throw new AppError('This gift item is out of stock', 409, 'GIFT_OUT_OF_STOCK');
      }
      const date = giftDate || today();
      const cost = await latestPurchaseCost(trx, giftItemId);
      const [inserted] = await trx('customer_gifts').insert({
        customer_account_id: customerId,
        gift_item_id: giftItemId,
        status: 'given',
        milestone_years: milestoneYears ?? null,
        is_override: formatBoolean(isOverride),
        unit_cost_minor: cost.unit_cost_minor,
        currency: cost.currency,
        note: note || null,
        gift_date: date,
        created_by_admin_id: admin.id,
      }).returning('id');
      const giftId = insertedId(inserted);
      if (reduceStock) {
        await trx('gift_stock_movements').insert({
          gift_item_id: giftItemId,
          kind: 'gift',
          quantity_delta: -1,
          customer_gift_id: giftId,
          occurred_on: date,
          created_by_admin_id: admin.id,
        });
      }
      return giftId;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw milestoneTaken();
    throw err;
  }
  await logActivity('customer_gift_given', {
    customerId, giftId: id, giftItemId, milestoneYears: milestoneYears ?? null, isOverride,
  }, null, adminActor(admin));
  return getCustomerGifts(customerId);
}

/** Closes one milestone. The next one still comes up; `no_gifts` is the way to stop them all. */
async function declineMilestone(customerId, { milestoneYears, note }, admin) {
  await customerOrThrow(customerId);
  let id;
  try {
    const [inserted] = await db('customer_gifts').insert({
      customer_account_id: customerId,
      status: 'declined',
      milestone_years: milestoneYears,
      note: note || null,
      gift_date: today(),
      created_by_admin_id: admin.id,
    }).returning('id');
    id = insertedId(inserted);
  } catch (err) {
    if (isUniqueViolation(err)) throw milestoneTaken();
    throw err;
  }
  await logActivity('customer_gift_declined', { customerId, giftId: id, milestoneYears }, null, adminActor(admin));
  return getCustomerGifts(customerId);
}

/** Undoes a gift or decline. A gift's stock comes back; the milestone reopens. */
async function undo(giftId, admin) {
  const customerId = await db.transaction(async (trx) => {
    const query = trx('customer_gifts').where({ id: giftId });
    if (trx.client.config.client === 'pg') query.forUpdate();
    const gift = await query.first();
    if (!gift) throw new NotFoundError('Gift', giftId);
    if (gift.undone_at) throw new AppError('This entry is already undone', 409, 'GIFT_ALREADY_UNDONE');
    await trx('customer_gifts').where({ id: giftId }).update({
      undone_at: new Date(),
      undone_by_admin_id: admin.id,
    });
    const movement = await trx('gift_stock_movements').where({ customer_gift_id: giftId, kind: 'gift' }).first();
    if (movement) {
      await trx('gift_stock_movements').insert({
        gift_item_id: movement.gift_item_id,
        kind: 'gift_undone',
        quantity_delta: 1,
        customer_gift_id: giftId,
        occurred_on: today(),
        created_by_admin_id: admin.id,
      });
    }
    return gift.customer_account_id;
  });
  await logActivity('customer_gift_undone', { customerId, giftId }, null, adminActor(admin));
  return getCustomerGifts(customerId);
}

/** Part of customer erasure. Called on the erasure's transaction. */
async function forgetCustomer(trx, customerId, actor) {
  await trx('customer_gifts').where({ customer_account_id: customerId }).update({ note: null });
  await auditedUpdate(trx, 'customer_accounts', { id: customerId }, { gift_start_date_override: null }, {
    actor, source: 'customer.erase',
  });
}

module.exports = {
  getRules,
  updateRules,
  listItems,
  createItem,
  updateItem,
  listMovements,
  addStock,
  correctStock,
  listSuggestions,
  getCustomerGifts,
  updateCustomerPreferences,
  giveGift,
  declineMilestone,
  undo,
  forgetCustomer,
};
