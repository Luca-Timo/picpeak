/**
 * Migration: seed CRM installment-default settings.
 *
 * The pre-send installment split feature (commits #4-#7 of the
 * deal_uuid PR) lets admins build N-row installment plans on quotes
 * and invoices. Most plans follow the same shape — "first installment
 * fires at signing, middle one(s) N days before the event, final one
 * N days after the event". Three CRM-wide defaults let admin
 * configure that shape once and have it pre-populate new ad-hoc
 * installment rows in both editors:
 *
 *   - crm_invoices_installment_trigger_first    → 'quote_accepted'
 *     What "at signing / creation" maps to. Editor uses this for
 *     row #1 of any new installment plan.
 *
 *   - crm_invoices_installment_days_before_event → 14
 *     Default offset for the "X days before event" slot (middle
 *     installment).
 *
 *   - crm_invoices_installment_days_after_event  → 14
 *     Default offset for the "Y days after event" slot — typically
 *     the final installment, often combined with an `after_delivery`
 *     trigger on a wedding-style workflow.
 *
 * Idempotent: only inserts when the key is missing, never overwrites
 * a value the admin has already customised. Same pattern as the
 * existing Skonto-default backfill (migration 105).
 *
 * Setting type is 'crm' so the existing CRM-settings UI auto-renders
 * these alongside the Skonto defaults.
 */

const SEEDS = [
  { setting_key: 'crm_invoices_installment_trigger_first',     setting_value: 'quote_accepted', setting_type: 'crm' },
  { setting_key: 'crm_invoices_installment_days_before_event', setting_value: 14,               setting_type: 'crm' },
  { setting_key: 'crm_invoices_installment_days_after_event',  setting_value: 14,               setting_type: 'crm' },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  for (const row of SEEDS) {
    const existing = await knex('app_settings').where('setting_key', row.setting_key).first();
    if (existing) continue;
    await knex('app_settings').insert({
      setting_key: row.setting_key,
      setting_value: JSON.stringify(row.setting_value),
      setting_type: row.setting_type,
    });
  }
};

exports.down = async function (_knex) {
  // No-op on down — admin may have changed these defaults via the
  // Settings UI; rolling back a seed shouldn't clobber a customised
  // value. Same rationale as migration 105.
};
