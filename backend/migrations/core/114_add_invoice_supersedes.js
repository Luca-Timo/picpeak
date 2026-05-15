/**
 * Migration: storno-aware invoice columns.
 *
 * Picpeak's original cancel+reissue flow was a software-only concept —
 * the invoice row got `status='cancelled'` and a "Bezug: Ersetzt" line
 * was stamped on the replacement PDF. That fails the §14c UStG /
 * GoBD requirement that the recipient receive a *separate, dated
 * cancellation document* before the VAT liability is reversed.
 *
 * This migration widens the schema so invoices can either be a normal
 * invoice or a Stornorechnung (cancellation invoice) — both rows live
 * in the same table sharing the gap-free sequence, distinguished by
 * the `kind` discriminator. Three FK columns wire the lineage:
 *
 *   - cancels_invoice_id      → on a Storno row, points to the
 *                                original it reverses.
 *   - replaces_invoice_id     → on a reissued invoice, points to the
 *                                original that was cancelled. Used by
 *                                the renderer to stamp the "Replaces
 *                                R-XXXX" reference line.
 *   - cancellation_storno_id  → on a cancelled original, points back
 *                                to the Storno that cancelled it.
 *                                Convenience for the admin detail
 *                                view ("Cancelled by Storno S-XXXX").
 *
 * Filename retained for migration-history stability (pre-beta change,
 * but some devs may have run the earlier version locally — knex
 * tracks completion by filename).
 *
 * Idempotent.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;

  await knex.schema.alterTable('invoices', (table) => {
    // Discriminator. 'invoice' is the default so existing rows
    // continue to render exactly as they did before this migration —
    // the renderer only branches on Storno.
    table.string('kind', 16).notNullable().defaultTo('invoice');
  }).catch(() => {});
  // The `.catch(() => {})` swallows the "column already exists" error
  // that knex throws when the alterTable runs on a DB that already
  // applied a prior version of this migration. Each individual column
  // is guarded by hasColumn below — the alterTable is split per
  // column so partial migrations recover cleanly.

  if (!(await knex.schema.hasColumn('invoices', 'cancels_invoice_id'))) {
    await knex.schema.alterTable('invoices', (table) => {
      // ON DELETE SET NULL — if the original ever gets purged (rare;
      // tax retention generally prevents it), the Storno's link
      // dangles as NULL rather than cascading.
      table.integer('cancels_invoice_id').unsigned()
        .references('id').inTable('invoices').onDelete('SET NULL');
    });
  }

  if (!(await knex.schema.hasColumn('invoices', 'replaces_invoice_id'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.integer('replaces_invoice_id').unsigned()
        .references('id').inTable('invoices').onDelete('SET NULL');
    });
  }

  if (!(await knex.schema.hasColumn('invoices', 'cancellation_storno_id'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.integer('cancellation_storno_id').unsigned()
        .references('id').inTable('invoices').onDelete('SET NULL');
    });
  }

  // Backfill: previous in-flight version of this migration created
  // `supersedes_invoice_id` with the same semantics as the new
  // `replaces_invoice_id`. Carry the data forward then drop the
  // legacy column. The COALESCE keeps the new column authoritative
  // on dev DBs that have been running both schemas in flight.
  if (await knex.schema.hasColumn('invoices', 'supersedes_invoice_id')) {
    await knex('invoices')
      .whereNotNull('supersedes_invoice_id')
      .update({
        replaces_invoice_id: knex.raw('COALESCE(replaces_invoice_id, supersedes_invoice_id)'),
      });
    await knex.schema.alterTable('invoices', (table) => {
      table.dropColumn('supersedes_invoice_id');
    });
  }

  // Index the discriminator alongside status — the list view filters
  // both ('kind=invoice AND status IN (...)') in nearly every query.
  // Wrapped in catch so re-runs on a DB that already has the index
  // don't fail; the column-level hasColumn guards above keep the
  // rest of the migration idempotent.
  await knex.schema.alterTable('invoices', (table) => {
    table.index(['kind', 'status'], 'invoices_kind_status_idx');
  }).catch(() => {});
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  // Drop FKs / columns in reverse order. Keep the docblock terse —
  // down-migrations on this codebase are advisory, prod uses the
  // forward-only path.
  for (const col of ['cancellation_storno_id', 'replaces_invoice_id', 'cancels_invoice_id', 'kind']) {
    if (await knex.schema.hasColumn('invoices', col)) {
      await knex.schema.alterTable('invoices', (table) => {
        table.dropColumn(col);
      });
    }
  }
};
