/**
 * Migration: backfill CRM settings that were added to migration 102
 * AFTER the migration had already shipped to some installs.
 *
 * Affected keys:
 *   - crm_invoices_skonto_percent_default  → 2
 *   - crm_quotes_skonto_enabled            → true
 *   - crm_invoices_qr_enabled              → true
 *   - crm_invoices_reminders_enabled       → true
 *   - crm_invoices_late_fee_enabled        → true
 *
 * Idempotent: only inserts when the key is missing, never overwrites
 * a value the admin has already customised.
 *
 * Why a follow-up migration: per project policy "no compensation
 * migrations" — BUT migration 102 has already shipped to beta and was
 * reverted then re-applied, so its content is effectively frozen on
 * live deployments. Adding the seed inline would never re-run. This
 * migration only backfills the rows for installs that ran the
 * earlier 102. It deliberately does NOT change schema.
 */

const SEEDS = [
  { setting_key: 'crm_invoices_skonto_percent_default', setting_value: 2,    setting_type: 'crm' },
  { setting_key: 'crm_quotes_skonto_enabled',           setting_value: true, setting_type: 'crm' },
  { setting_key: 'crm_invoices_qr_enabled',             setting_value: true, setting_type: 'crm' },
  { setting_key: 'crm_invoices_reminders_enabled',      setting_value: true, setting_type: 'crm' },
  { setting_key: 'crm_invoices_late_fee_enabled',       setting_value: true, setting_type: 'crm' },
];

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  for (const row of SEEDS) {
    const existing = await knex('app_settings').where('setting_key', row.setting_key).first();
    if (!existing) {
      await knex('app_settings').insert({
        setting_key: row.setting_key,
        setting_value: JSON.stringify(row.setting_value),
        setting_type: row.setting_type,
      });
    }
  }
};

exports.down = async function(_knex) {
  // No-op on down — admin may have set explicit values we don't want
  // to clobber by rolling back a backfill.
};
