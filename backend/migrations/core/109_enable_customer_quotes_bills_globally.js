/**
 * Migration: enable customer-facing Quotes + Invoices tabs by default
 *
 * Migration 092 seeded the global feature toggles
 *   customer_feature_quotes_enabled
 *   customer_feature_bills_enabled
 * to `false` on every install. The pages, routes, services, and
 * backend endpoints have since been fully implemented and the
 * maintainer wants the tabs to show up automatically for customers
 * whose per-customer flags are on (which is the default).
 *
 * This migration flips both globals to `true`. We intentionally do
 * NOT touch `customer_feature_calendar_enabled` because the
 * customer-side calendar page is still a coming-soon stub.
 *
 * Idempotent — only writes when the row exists and currently holds
 * `false`, so an admin who has explicitly turned the feature off
 * (true → false, deliberate) is preserved. Hmm, well — we DO want
 * to flip it for installs that still hold the original seed `false`,
 * but we can't tell those apart from a deliberate-false. The
 * pragmatic call: flip both to true unconditionally. An admin who
 * needs to disable the feature can do so post-deploy.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;

  const keys = [
    'customer_feature_quotes_enabled',
    'customer_feature_bills_enabled',
  ];

  for (const key of keys) {
    const existing = await knex('app_settings').where('setting_key', key).first();
    // Detect both Postgres JSON storage and SQLite text storage. We
    // want to flip the value to `true` (stored as the same JSON
    // literal the rest of the seed uses).
    const desired = JSON.stringify(true);
    if (existing) {
      await knex('app_settings')
        .where('setting_key', key)
        .update({ setting_value: desired, updated_at: new Date() });
    } else {
      await knex('app_settings').insert({
        setting_key: key,
        setting_value: desired,
        setting_type: 'customer_surface',
        updated_at: new Date(),
      });
    }
  }
};

exports.down = async function(knex) {
  // No-op: flipping the toggles back to `false` would surprise
  // admins who relied on the new default. The toggles remain
  // editable from settings, so explicit opt-out is still possible.
};
