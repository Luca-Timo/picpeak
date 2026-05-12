/**
 * Migration: Terms of Service / AGB step on quote acceptance.
 *
 * Adds two app_settings keys for the global ToS text + an opt-in
 * "required" flag, plus two columns on `quotes` to record what the
 * customer agreed to and when.
 *
 * The frontend public quote response page renders the ToS block above
 * the Accept button; when `crm_quotes_tos_required` is true, Accept is
 * gated behind a checkbox. The text rendered to the customer is
 * snapshotted onto the quote at acceptance time so future ToS edits
 * don't retroactively rewrite history.
 *
 * Idempotent — check before each insert/add.
 */

const NEW_SETTINGS = [
  // Default OFF — installs that don't care about ToS won't see the
  // checkbox at all. Flip ON in CRM Settings to enforce.
  { setting_key: 'crm_quotes_tos_required',  setting_value: false, setting_type: 'crm' },
  { setting_key: 'crm_quotes_tos_text',      setting_value: '',    setting_type: 'crm' },
  // Optional link displayed alongside the checkbox label.
  { setting_key: 'crm_quotes_tos_url',       setting_value: '',    setting_type: 'crm' },
];

exports.up = async function(knex) {
  // 1. quotes.tos_accepted_at + tos_text_snapshot
  if (await knex.schema.hasTable('quotes')) {
    if (!(await knex.schema.hasColumn('quotes', 'tos_accepted_at'))) {
      await knex.schema.alterTable('quotes', (table) => {
        table.timestamp('tos_accepted_at');
        // Snapshot of the text the customer ticked through — admin
        // can read it back from the quote detail page for audit.
        table.text('tos_text_snapshot');
      });
    }
  }

  // 2. app_settings seeds — same pattern as migration 102.
  if (await knex.schema.hasTable('app_settings')) {
    for (const row of NEW_SETTINGS) {
      const existing = await knex('app_settings').where('setting_key', row.setting_key).first();
      if (!existing) {
        await knex('app_settings').insert({
          setting_key: row.setting_key,
          setting_value: JSON.stringify(row.setting_value),
          setting_type: row.setting_type,
        });
      }
    }
  }
};

exports.down = async function(knex) {
  if (await knex.schema.hasTable('quotes')) {
    for (const col of ['tos_accepted_at', 'tos_text_snapshot']) {
      if (await knex.schema.hasColumn('quotes', col)) {
        await knex.schema.alterTable('quotes', (table) => { table.dropColumn(col); });
      }
    }
  }
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings')
      .whereIn('setting_key', NEW_SETTINGS.map((s) => s.setting_key))
      .del();
  }
};
