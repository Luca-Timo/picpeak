/**
 * Migration: invoices.imported_pdf_path
 *
 * Lets the admin attach a historical PDF (from a previous billing
 * system) directly to an invoice row instead of rebuilding it from
 * line items inside picpeak. Useful when migrating from QuickBooks,
 * Bexio, Xero etc. — the customer sees the imported PDF in their
 * portal alongside system-generated ones.
 *
 * When the column is populated, every PDF endpoint short-circuits
 * the renderer and streams the imported file. Line items + totals
 * on the invoice row are informational only (used for status, due
 * dates, reminders, payment tracking).
 *
 * Idempotent.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (await knex.schema.hasColumn('invoices', 'imported_pdf_path')) return;
  await knex.schema.alterTable('invoices', (table) => {
    // Absolute path or path relative to STORAGE_PATH.
    table.string('imported_pdf_path', 512);
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'imported_pdf_path'))) return;
  await knex.schema.alterTable('invoices', (table) => {
    table.dropColumn('imported_pdf_path');
  });
};
