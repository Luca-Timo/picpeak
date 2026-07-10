/**
 * Migration 159: per-event category order override (#782).
 *
 * Builds on migration 158 (photo_categories.display_order = the GLOBAL default
 * order) by adding a per-event OVERRIDE layer. Global categories are shared
 * across every event, so a single display_order can only express one order for
 * them. This table lets a single gallery arrange its categories — globals AND
 * event-specific, interleaved into the flow of the day — independently of the
 * global default.
 *
 * Resolution (see adminCategories / gallery):
 *   1. if the event has override rows -> use override.position;
 *   2. else fall back to photo_categories.display_order (the global default);
 *   3. else name.
 *
 * An event is either "using the default" (no rows here) or "customised" (a row
 * per category it shows). No backfill: every existing event starts on the
 * default order, so nothing reshuffles — a custom order is opt-in per event.
 *
 * Additive + hasTable-guarded.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('photo_categories'))) return;
  if (await knex.schema.hasTable('event_category_order')) return;

  await knex.schema.createTable('event_category_order', (t) => {
    t.increments('id').primary();
    t.integer('event_id').notNullable()
      .references('id').inTable('events').onDelete('CASCADE');
    t.integer('category_id').notNullable()
      .references('id').inTable('photo_categories').onDelete('CASCADE');
    t.integer('position').notNullable().defaultTo(0);
    t.timestamp('created_at').defaultTo(knex.fn.now());

    // At most one position per (event, category).
    t.unique(['event_id', 'category_id']);
    // Ordered reads are always scoped to one event.
    t.index(['event_id', 'position']);
  });
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('event_category_order')) {
    await knex.schema.dropTable('event_category_order');
  }
};
