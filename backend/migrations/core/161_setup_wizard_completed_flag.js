/**
 * Migration 161: `setup_wizard_completed` app setting (#800).
 *
 * The setup wizard gains an event-types step that may rename or DELETE the
 * seeded system event types. That is only safe on a pristine install, so the
 * backend gates system-type deletion on this flag being unset (plus zero
 * usage — see eventTypeService.deleteEventType).
 *
 * Backfill rule: any install that already has an admin account predates the
 * wizard step (or already finished the wizard), so it is marked completed
 * here — the deletion window never opens on existing setups. A genuinely
 * fresh install runs this migration BEFORE its first admin is created, so
 * the flag starts false and the wizard's finish call flips it to true.
 *
 * Idempotent: skips when the key already exists. Values are JSON-stringified
 * to match getAppSetting's JSON.parse on read.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;

  const existing = await knex('app_settings')
    .where({ setting_key: 'setup_wizard_completed' })
    .first();
  if (existing) return;

  let hasAdmin = false;
  if (await knex.schema.hasTable('admin_users')) {
    const row = await knex('admin_users').count({ c: '*' }).first();
    hasAdmin = Number(row?.c || 0) > 0;
  }

  await knex('app_settings').insert({
    setting_key: 'setup_wizard_completed',
    setting_value: JSON.stringify(hasAdmin),
    setting_type: 'boolean',
    updated_at: new Date(),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  await knex('app_settings').where({ setting_key: 'setup_wizard_completed' }).del();
};
