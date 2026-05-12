/**
 * businessProfileService — single source of truth for the issuer block
 * printed at the top of every quote/invoice PDF.
 *
 * Two tables back this:
 *   - business_profile        singleton row (id=1) seeded by migration 102
 *   - business_bank_accounts  1:N from business_profile
 *
 * Bank accounts are partitioned by currency: at most one default per
 * currency. The Quote/Invoice editors auto-pick the matching default when
 * the user changes the doc currency. The defaulting rule is enforced at
 * the service layer (inside a transaction) — the DB doesn't have a
 * partial unique index so we can't rely on it cross-dialect.
 */

const { db, withRetry } = require('../database/db');
const { logger } = require('../utils/logger');
const { formatBoolean } = require('../utils/dbCompat');

const ALLOWED_PROFILE_FIELDS = [
  'company_name',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'state',
  'country_code',
  'phone',
  'mobile',
  'email',
  'website',
  'vat_id',
  'vat_label',
  'vat_rate_default',
  'default_currency',
  'default_locale',
  'default_qr_format',
  'footer_line',
  'logo_path',
];

const ALLOWED_BANK_FIELDS = [
  'label',
  'account_holder',
  'iban',
  'bic',
  'currency',
  'is_default',
  'display_order',
];

const VALID_QR_FORMATS = new Set(['swiss', 'epc', 'none']);

function pickFields(payload, allowed) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      out[key] = payload[key];
    }
  }
  return out;
}

function normaliseIban(iban) {
  if (!iban) return iban;
  return String(iban).replace(/\s+/g, '').toUpperCase();
}

function normaliseCurrency(currency) {
  if (!currency) return currency;
  return String(currency).trim().toUpperCase();
}

function normaliseCountryCode(cc) {
  if (!cc) return cc;
  return String(cc).trim().toUpperCase().slice(0, 2);
}

function sanitiseProfilePayload(payload) {
  const updates = pickFields(payload, ALLOWED_PROFILE_FIELDS);

  if (updates.country_code !== undefined) {
    updates.country_code = normaliseCountryCode(updates.country_code);
  }
  if (updates.default_currency !== undefined) {
    updates.default_currency = normaliseCurrency(updates.default_currency);
  }
  if (updates.default_qr_format !== undefined) {
    const v = String(updates.default_qr_format || '').trim().toLowerCase();
    updates.default_qr_format = VALID_QR_FORMATS.has(v) ? v : 'none';
  }
  // Trim free-text fields to avoid silent leading/trailing whitespace
  // when the admin pastes from a printed letterhead.
  for (const field of ['company_name', 'address_line1', 'address_line2',
    'city', 'state', 'phone', 'mobile', 'email', 'website',
    'vat_id', 'vat_label', 'footer_line', 'logo_path']) {
    if (typeof updates[field] === 'string') {
      updates[field] = updates[field].trim();
    }
  }

  return updates;
}

function sanitiseBankPayload(payload) {
  const updates = pickFields(payload, ALLOWED_BANK_FIELDS);

  if (updates.iban !== undefined) {
    updates.iban = normaliseIban(updates.iban);
  }
  if (updates.bic !== undefined && typeof updates.bic === 'string') {
    updates.bic = updates.bic.replace(/\s+/g, '').toUpperCase();
  }
  if (updates.currency !== undefined) {
    updates.currency = normaliseCurrency(updates.currency);
  }
  if (updates.is_default !== undefined) {
    updates.is_default = formatBoolean(Boolean(updates.is_default));
  }
  for (const field of ['label', 'account_holder']) {
    if (typeof updates[field] === 'string') {
      updates[field] = updates[field].trim();
    }
  }

  return updates;
}

/**
 * Fetch the singleton business_profile row + its bank accounts.
 * Always returns a profile object even if the row is empty — the
 * Settings UI binds straight to this shape.
 */
async function getProfile() {
  return await withRetry(async () => {
    let profile = await db('business_profile').where({ id: 1 }).first();
    if (!profile) {
      // Belt-and-braces: migration 102 seeds id=1, but if a fresh install
      // ran an earlier rollback that wiped the row, re-create it so the
      // service never throws.
      await db('business_profile').insert({ id: 1 });
      profile = await db('business_profile').where({ id: 1 }).first();
    }

    const accounts = await db('business_bank_accounts')
      .where({ business_profile_id: 1 })
      .orderBy('display_order', 'asc')
      .orderBy('id', 'asc');

    return { profile, bankAccounts: accounts };
  });
}

async function updateProfile(payload, adminId) {
  const updates = sanitiseProfilePayload(payload);
  if (Object.keys(updates).length === 0) {
    return await getProfile();
  }
  updates.updated_at = new Date();

  await withRetry(async () => {
    await db('business_profile').where({ id: 1 }).update(updates);
  });

  logger.info('Business profile updated', {
    adminId,
    fields: Object.keys(updates).filter((k) => k !== 'updated_at'),
  });

  return await getProfile();
}

/**
 * Insert a new bank account. If `is_default = true`, atomically clear
 * the default flag on every other account in the same currency.
 */
async function createBankAccount(payload, adminId) {
  const data = sanitiseBankPayload(payload);
  if (!data.iban) {
    const err = new Error('iban is required');
    err.statusCode = 400;
    throw err;
  }
  data.business_profile_id = 1;
  data.created_at = new Date();
  data.updated_at = new Date();
  // Default off when not specified — we don't want the first account
  // accidentally becoming default just because the form omitted the field.
  if (data.is_default === undefined) data.is_default = formatBoolean(false);

  return await db.transaction(async (trx) => {
    if (data.is_default && (data.is_default === true || data.is_default === 1)) {
      await trx('business_bank_accounts')
        .where({ business_profile_id: 1, currency: data.currency })
        .update({ is_default: formatBoolean(false), updated_at: new Date() });
    }
    const inserted = await trx('business_bank_accounts').insert(data).returning('id');
    const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    logger.info('Business bank account created', {
      adminId, id, iban: data.iban?.slice(-4), currency: data.currency,
    });

    return await trx('business_bank_accounts').where({ id }).first();
  });
}

async function updateBankAccount(id, payload, adminId) {
  const data = sanitiseBankPayload(payload);
  data.updated_at = new Date();

  return await db.transaction(async (trx) => {
    const existing = await trx('business_bank_accounts').where({ id }).first();
    if (!existing) {
      const err = new Error('Bank account not found');
      err.statusCode = 404;
      throw err;
    }
    // Honour the per-currency single-default rule.
    if (data.is_default === true || data.is_default === 1 || data.is_default === formatBoolean(true)) {
      const targetCurrency = data.currency || existing.currency;
      await trx('business_bank_accounts')
        .where({ business_profile_id: 1, currency: targetCurrency })
        .andWhereNot({ id })
        .update({ is_default: formatBoolean(false), updated_at: new Date() });
    }
    await trx('business_bank_accounts').where({ id }).update(data);

    logger.info('Business bank account updated', { adminId, id });

    return await trx('business_bank_accounts').where({ id }).first();
  });
}

async function deleteBankAccount(id, adminId) {
  return await withRetry(async () => {
    const existing = await db('business_bank_accounts').where({ id }).first();
    if (!existing) {
      const err = new Error('Bank account not found');
      err.statusCode = 404;
      throw err;
    }
    await db('business_bank_accounts').where({ id }).del();
    logger.info('Business bank account deleted', { adminId, id });
    return { deleted: true };
  });
}

/**
 * Resolve the bank account that should print on a quote/invoice for a
 * given currency: explicit override → default for that currency →
 * default for the profile's default_currency → first by display_order.
 */
async function resolveBankAccountForCurrency(currency, overrideId = null) {
  return await withRetry(async () => {
    if (overrideId) {
      const explicit = await db('business_bank_accounts').where({ id: overrideId }).first();
      if (explicit) return explicit;
    }
    if (currency) {
      const match = await db('business_bank_accounts')
        .where({ business_profile_id: 1, currency, is_default: formatBoolean(true) })
        .first();
      if (match) return match;
    }
    const anyDefault = await db('business_bank_accounts')
      .where({ business_profile_id: 1, is_default: formatBoolean(true) })
      .first();
    if (anyDefault) return anyDefault;
    return await db('business_bank_accounts')
      .where({ business_profile_id: 1 })
      .orderBy('display_order', 'asc').orderBy('id', 'asc').first();
  });
}

module.exports = {
  getProfile,
  updateProfile,
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
  resolveBankAccountForCurrency,
};
