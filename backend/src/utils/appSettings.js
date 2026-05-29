/**
 * Small helper to read app_settings rows.
 *
 * The picpeak codebase has TWO settings services:
 *   - `src/services/settingsService.js` queries a `settings` table that
 *     doesn't actually exist on most deployments (legacy SQLite-era
 *     name). Calling getSetting() from there raises
 *     "relation \"settings\" does not exist" on Postgres.
 *   - The canonical store is `app_settings`, accessed inline by every
 *     other service (shareLinkService, customerAccountsService,
 *     authSecurity, dateFormatter, …).
 *
 * The CRM services use this helper instead of settingsService so the
 * crm_* keys seeded by migration 102 are actually readable.
 */

const { db } = require('../database/db');

/**
 * Read a single app_settings row by key. Returns the parsed value or
 * `defaultValue` when the key doesn't exist.
 *
 * `setting_value` is always JSON-stringified at write time
 * (see migration 102 + the /admin/settings/general route), so we
 * JSON.parse on the way out. Falls back to the raw string on
 * malformed JSON so legacy text values still work.
 */
async function getAppSetting(key, defaultValue = null) {
  const row = await db('app_settings').where({ setting_key: key }).first();
  if (!row || row.setting_value == null) return defaultValue;
  try {
    return JSON.parse(row.setting_value);
  } catch (_) {
    return row.setting_value;
  }
}

module.exports = { getAppSetting };
