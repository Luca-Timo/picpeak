/**
 * Migration: add `business_profile.tax_id` (Steuernummer) so DE/AT
 * invoices satisfy §14 UStG.
 *
 * `vat_id` (USt-IdNr.) already exists on the table. Many German
 * businesses — especially Kleinunternehmer under §19 UStG — don't
 * have a VAT-ID but DO have a Steuernummer assigned by the local
 * Finanzamt. §14 UStG requires *either* on every invoice, so the
 * issuer block needs both columns.
 *
 * Idempotent, hasColumn-guarded. Mirrors migration 137.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  if (await knex.schema.hasColumn('business_profile', 'tax_id')) return;
  await knex.schema.alterTable('business_profile', (table) => {
    // Free-text. Capped at 64 chars to match `vat_id`.
    table.string('tax_id', 64);
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  if (!(await knex.schema.hasColumn('business_profile', 'tax_id'))) return;
  await knex.schema.alterTable('business_profile', (table) => {
    table.dropColumn('tax_id');
  });
};
