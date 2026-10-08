/**
 * Emails take the brand's filled accent (Branding › Colours) from now on
 * when Settings → Email sets no Primary colour (emailProcessor
 * resolveEmailAccent), and the green the seeded templates carry inline
 * follows that accent.
 *
 * An install that has already sent mail keeps the look its recipients know:
 * it gets the old green pinned as its email Primary colour, unless it set one
 * already. The admin can clear it in Settings → Email to follow the brand. A
 * fresh install follows the brand from its first mail.
 */

const { sanitizeCssColor } = require('../../src/utils/cssSanitizer');

const LEGACY_EMAIL_GREEN = '#5C8762';

function stored(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : '';
  } catch (_) {
    return value;
  }
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  if (!(await knex.schema.hasTable('email_queue'))) return;
  if (!(await knex('email_queue').first('id'))) return;

  const row = await knex('app_settings').where({ setting_key: 'email_primary_color' }).first('setting_value');
  // Only a value the mailer would use counts as set (emailProcessor
  // readColor): an invalid one fell back to the green, so it is pinned too.
  if (row && sanitizeCssColor(stored(row.setting_value))) return;

  const value = JSON.stringify(LEGACY_EMAIL_GREEN);
  if (row) {
    await knex('app_settings').where({ setting_key: 'email_primary_color' }).update({ setting_value: value, updated_at: new Date() });
  } else {
    await knex('app_settings').insert({ setting_key: 'email_primary_color', setting_value: value, setting_type: 'general', updated_at: new Date() });
  }
};

// The pinned value is indistinguishable from one the admin set, so it stays.
exports.down = async function () {};
