/**
 * Migration: quote/invoice line items — parent + details_text.
 *
 * Adds two columns to BOTH `quote_line_items` and `invoice_line_items`:
 *
 *   parent_line_item_id  INTEGER NULL, FK self-reference, ON DELETE CASCADE.
 *     NULL  → top-level line item; `line_total_minor` rolls into the
 *             quote/invoice net total.
 *     SET   → sub-item under a parent; `line_total_minor` is
 *             display-only (transparency / itemisation). The parent's
 *             own line_total_minor is what counts for net + VAT.
 *
 *   details_text  TEXT NULL.
 *     Free-form notes rendered below the description on the PDF and
 *     the customer-facing view (smaller, italic, indented). Good for
 *     fine print, package inclusions, conditions.
 *
 * Nesting is one level deep — the application layer rejects a
 * sub-item whose parent itself has a parent. The schema doesn't
 * enforce this; the service-layer validators do.
 *
 * Both columns are additive and idempotent — safe to re-run, no
 * backfill needed. Existing line items render unchanged (NULL parent
 * = top-level, the behaviour they already have).
 */

async function addColumnsTo(knex, tableName) {
  if (!(await knex.schema.hasTable(tableName))) return;

  if (!(await knex.schema.hasColumn(tableName, 'parent_line_item_id'))) {
    await knex.schema.alterTable(tableName, (table) => {
      // Self-FK. ON DELETE CASCADE so removing a parent cleanly
      // sweeps its sub-items — matches the user's mental model
      // ("removing the line removes everything under it").
      table.integer('parent_line_item_id').unsigned()
        .references('id').inTable(tableName)
        .onDelete('CASCADE');
      // Index on the FK for the fast lookup the service does when
      // grouping items into their hierarchy at render time.
      table.index('parent_line_item_id', `${tableName}_parent_idx`);
    });
  }

  if (!(await knex.schema.hasColumn(tableName, 'details_text'))) {
    await knex.schema.alterTable(tableName, (table) => {
      table.text('details_text');
    });
  }
}

async function dropColumnsFrom(knex, tableName) {
  if (!(await knex.schema.hasTable(tableName))) return;

  if (await knex.schema.hasColumn(tableName, 'parent_line_item_id')) {
    await knex.schema.alterTable(tableName, (table) => {
      // Some DBs (MySQL) require dropping the index name before the
      // column. SQLite + Postgres tolerate either order; the guarded
      // try/catch keeps the down migration tolerant across backends.
      try { table.dropIndex('parent_line_item_id', `${tableName}_parent_idx`); } catch (_) { /* ignore */ }
      table.dropColumn('parent_line_item_id');
    });
  }

  if (await knex.schema.hasColumn(tableName, 'details_text')) {
    await knex.schema.alterTable(tableName, (table) => {
      table.dropColumn('details_text');
    });
  }
}

exports.up = async function (knex) {
  await addColumnsTo(knex, 'quote_line_items');
  await addColumnsTo(knex, 'invoice_line_items');
};

exports.down = async function (knex) {
  await dropColumnsFrom(knex, 'quote_line_items');
  await dropColumnsFrom(knex, 'invoice_line_items');
};
