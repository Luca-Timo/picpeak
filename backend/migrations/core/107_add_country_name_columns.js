/**
 * Migration: add explicit country_name columns
 *
 *   business_profile.country_name      — issuer side
 *   customer_accounts.country_name     — recipient side
 *
 * Today the renderer derives the full country name from the ISO
 * country code via a small COUNTRY_NAMES map. That's fine for the
 * common DACH set, but the maintainer has cases where:
 *
 *   - the "country code" stored in the existing field is the
 *     postal/vehicle abbreviation (e.g. FL for Liechtenstein), not
 *     the ISO code (LI) — the FL prefix is what appears on Swiss /
 *     LI postal addresses ("FL-9494 Schaan")
 *   - they want to type the full country name freehand instead of
 *     relying on the lookup, e.g. for English vs German spelling
 *     mismatches or for rarer destinations
 *
 * Adding country_name as a free-text override keeps the existing
 * country_code in its postal role while letting the issuer/recipient
 * blocks carry the full name verbatim.
 *
 * Idempotent — checks the column before adding on each table.
 */

exports.up = async function(knex) {
  if (await knex.schema.hasTable('business_profile')) {
    const exists = await knex.schema.hasColumn('business_profile', 'country_name');
    if (!exists) {
      await knex.schema.alterTable('business_profile', (table) => {
        table.string('country_name', 120);
      });
    }
  }

  if (await knex.schema.hasTable('customer_accounts')) {
    const exists = await knex.schema.hasColumn('customer_accounts', 'country_name');
    if (!exists) {
      await knex.schema.alterTable('customer_accounts', (table) => {
        table.string('country_name', 120);
      });
    }
  }
};

exports.down = async function(knex) {
  for (const tableName of ['business_profile', 'customer_accounts']) {
    if (!(await knex.schema.hasTable(tableName))) continue;
    if (!(await knex.schema.hasColumn(tableName, 'country_name'))) continue;
    await knex.schema.alterTable(tableName, (table) => {
      table.dropColumn('country_name');
    });
  }
};
