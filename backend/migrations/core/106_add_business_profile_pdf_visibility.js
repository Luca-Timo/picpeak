/**
 * Migration: business_profile.pdf_show_logo + business_profile.pdf_show_company_name
 *
 * Two boolean toggles for the issuer block at the top-right of every
 * quote/invoice PDF. Both default true to preserve existing visual
 * state on already-deployed installs (per project policy "migrations
 * should preserve existing visual state").
 *
 *   pdf_show_logo          when false, the logo image is suppressed
 *                          even if business_profile.logo_path is set
 *   pdf_show_company_name  when false, the company name line in the
 *                          issuer block is suppressed (logo can still
 *                          carry the brand visually)
 *
 * Idempotent — checks each column before adding.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  await knex.schema.alterTable('business_profile', (table) => {
    // We must build the alterations conditionally OUTSIDE the callback
    // because knex's alterTable can't branch internally per-column on
    // hasColumn. Adding two columns in one call when both are missing
    // is the common path; the two single-column branches handle the
    // partial-state case where only one was previously added by a
    // hand-applied tweak.
  });

  const hasLogo = await knex.schema.hasColumn('business_profile', 'pdf_show_logo');
  if (!hasLogo) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.boolean('pdf_show_logo').notNullable().defaultTo(true);
    });
    // Backfill existing rows so the previously implicit "show logo"
    // behavior is pinned onto every install.
    await knex('business_profile').update({ pdf_show_logo: true });
  }

  const hasName = await knex.schema.hasColumn('business_profile', 'pdf_show_company_name');
  if (!hasName) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.boolean('pdf_show_company_name').notNullable().defaultTo(true);
    });
    await knex('business_profile').update({ pdf_show_company_name: true });
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  for (const col of ['pdf_show_logo', 'pdf_show_company_name']) {
    if (await knex.schema.hasColumn('business_profile', col)) {
      await knex.schema.alterTable('business_profile', (table) => {
        table.dropColumn(col);
      });
    }
  }
};
