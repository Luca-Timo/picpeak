/**
 * Migration: invoices.supersedes_invoice_id
 *
 * Tracks the legally-correct "cancel + reissue" workflow. When an
 * admin clicks "Cancel & reissue" on a sent invoice, the system:
 *   1. Flips the original to status='cancelled'
 *   2. Creates a fresh `scheduled` invoice (new number per
 *      lückenlose-Rechnungsnummer rules), copying line items +
 *      customer + totals + payment terms
 *   3. Stores the original's id on the new row via
 *      `supersedes_invoice_id`
 *
 * The PDF renderer surfaces this on the new invoice as a
 * "Bezug: Ersetzt Rechnung R-XXXX vom DATE" line so the customer
 * (and any future auditor) can trace the chain.
 *
 * Idempotent.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (await knex.schema.hasColumn('invoices', 'supersedes_invoice_id')) return;
  await knex.schema.alterTable('invoices', (table) => {
    // ON DELETE SET NULL — if the original invoice ever gets purged
    // (rare; tax retention typically prevents it) the supersedes
    // link survives as a NULL, which the renderer treats as "no
    // reference line" rather than crashing.
    table.integer('supersedes_invoice_id').unsigned()
      .references('id').inTable('invoices').onDelete('SET NULL');
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'supersedes_invoice_id'))) return;
  await knex.schema.alterTable('invoices', (table) => {
    table.dropColumn('supersedes_invoice_id');
  });
};
