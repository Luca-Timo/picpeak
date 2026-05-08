/**
 * Migration: Advanced Features tab + customer_portal_enabled master toggle.
 *
 * Per the discussion in #354 — luap and Luca-Timo agreed the customer
 * portal should be opt-in via a Settings → Advanced features page, so
 * installs that just want gallery delivery aren't paying for the
 * extra surface area. This migration introduces the master toggle.
 *
 * Default: false. The customer-portal feature has not been released
 * to a stable channel yet (PR #403 is still under review), so there
 * are no production installs to grandfather in. Every install starts
 * with the feature OFF; admins flip it on from Settings → Advanced
 * features when they want it.
 *
 * Idempotent — re-running is a no-op.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;

  const existing = await knex('app_settings')
    .where('setting_key', 'customer_portal_enabled')
    .first();
  if (existing) return;

  await knex('app_settings').insert({
    setting_key: 'customer_portal_enabled',
    setting_value: JSON.stringify(false),
    setting_type: 'advanced_features',
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  await knex('app_settings').where('setting_key', 'customer_portal_enabled').del();
};
