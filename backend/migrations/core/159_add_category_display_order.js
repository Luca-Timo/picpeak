/**
 * Migration 159: per-event category ordering (#782).
 *
 * Adds a `display_order` integer to `photo_categories` so photographers can
 * arrange an event's categories in the flow of the day (Pre-Ceremony →
 * Ceremony → Reception …) instead of the hard-coded A–Z order. Mirrors the
 * `display_order` column + reorder pattern already used by `event_types`.
 *
 * Preserve existing galleries: backfill `display_order` from the CURRENT
 * (alphabetical) order, scoped — globals numbered together, event-specific
 * numbered per event — so nothing reshuffles on upgrade. A custom order is
 * opt-in via the admin reorder controls. See feedback: migrations should pin
 * previously-implicit defaults onto existing rows.
 *
 * Backfill runs in JS (not a SQL window function) to stay portable across
 * SQLite (dev) and Postgres (prod).
 *
 * Additive + hasColumn-guarded.
 */
async function addColumn(knex, table, column, builder) {
  if (!(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, builder);
  }
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('photo_categories'))) return;

  await addColumn(knex, 'photo_categories', 'display_order', (t) => {
    t.integer('display_order').notNullable().defaultTo(0);
    t.index('display_order');
  });

  // Backfill from the current alphabetical order, per scope, so existing
  // galleries render exactly as before until an admin reorders.
  const cats = await knex('photo_categories')
    .select('id', 'name', 'is_global', 'event_id')
    .orderBy('name', 'asc');

  const counters = {};
  for (const c of cats) {
    const scope = c.is_global ? 'global' : `event:${c.event_id}`;
    counters[scope] = (counters[scope] || 0) + 1;
    await knex('photo_categories')
      .where('id', c.id)
      .update({ display_order: counters[scope] });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('photo_categories'))) return;
  if (await knex.schema.hasColumn('photo_categories', 'display_order')) {
    await knex.schema.alterTable('photo_categories', (t) =>
      t.dropColumn('display_order')
    );
  }
};
