/**
 * Migration: seed CRM default payment-term picker app_settings.
 *
 * Migration 124 introduced two split tables (`payment_net_days_templates`,
 * `payment_timing_templates`) and removed the conflated single picker.
 * The quote + invoice editors auto-prefill new documents to Net 30 +
 * "Komplettzahlung nach Auslieferung" — but those defaults were
 * hardcoded in the React effect. This migration writes them as
 * configurable app_settings so the CRM settings page can expose them
 * as defaults the admin can change.
 *
 * Two keys:
 *   - crm_invoices_default_payment_net_days_template_id  → Net 30 row id
 *   - crm_invoices_default_payment_timing_template_id    → "Komplettzahlung nach Auslieferung" row id
 *
 * Lookup matches the system-seeded rows by `is_system=true` plus a
 * `net_days` value (for net-days) or a name (for timing). This way
 * the seed survives an admin renaming the rows later — but only
 * applies on first run; subsequent re-runs are skipped per the
 * "don't clobber admin customisation" pattern from migration 105.
 *
 * Idempotent: skips when the setting_key already exists.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  if (!(await knex.schema.hasTable('payment_net_days_templates'))) return;
  if (!(await knex.schema.hasTable('payment_timing_templates'))) return;

  // Net 30 by value. Falls back to whatever system row has the
  // smallest non-zero net_days if Net 30 isn't seeded (defensive —
  // migration 124's seed always includes Net 30).
  const netDays30 = await knex('payment_net_days_templates')
    .where('is_system', true)
    .andWhere('net_days', 30)
    .first();
  const netDaysFallback = netDays30 || (await knex('payment_net_days_templates')
    .where('is_system', true)
    .andWhere('net_days', '>', 0)
    .orderBy('net_days', 'asc')
    .first());

  // "Komplettzahlung nach Auslieferung" is the safest single-installment
  // default — no advance payment required, fires when the photos
  // actually go out. Match by name to mirror the editor's old behaviour
  // (which picked it as the first display_order=10 system row).
  const timingDelivery = await knex('payment_timing_templates')
    .where('is_system', true)
    .andWhere('name', 'Komplettzahlung nach Auslieferung')
    .first();
  const timingFallback = timingDelivery || (await knex('payment_timing_templates')
    .where('is_system', true)
    .orderBy('display_order', 'asc')
    .first());

  const seeds = [];
  if (netDaysFallback) {
    seeds.push({
      setting_key: 'crm_invoices_default_payment_net_days_template_id',
      setting_value: netDaysFallback.id,
      setting_type: 'crm',
    });
  }
  if (timingFallback) {
    seeds.push({
      setting_key: 'crm_invoices_default_payment_timing_template_id',
      setting_value: timingFallback.id,
      setting_type: 'crm',
    });
  }

  for (const row of seeds) {
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
  // No-op — admin may have customised the values; don't clobber on
  // rollback. Matches the policy in migration 105.
};
