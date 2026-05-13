/**
 * Migration: business_profile — PDF layout customisation
 *
 * Adds three new columns that let admins tweak the PDF letterhead
 * without touching code:
 *
 *   pdf_folding_marks       'none' | 'half' | 'third' | 'both'
 *                           DIN 5008 folding-mark indicators at the
 *                           left edge of every PDF page. 'half' adds
 *                           one mark at 148.5mm (C5 envelopes), 'third'
 *                           adds one at 105mm (DL / C5-6 envelopes),
 *                           'both' adds both. Default 'none'.
 *
 *   pdf_logo_height         INTEGER (pt) — height of the logo banner.
 *                           Width auto-scales to preserve aspect
 *                           ratio. Defaults to 56pt (was previously
 *                           hard-coded). Sensible range: 24-120pt.
 *
 *   pdf_company_name_inline BOOLEAN — when true, the company name
 *                           renders as plain text immediately above
 *                           the street address, same size + weight
 *                           as the address lines. When false (default),
 *                           it renders bold underneath the logo as a
 *                           visual title.
 *
 * Defaults preserve existing PDF appearance per the project's
 * "migrations should preserve existing visual state" rule.
 *
 * Idempotent — checks each column before adding.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;

  if (!(await knex.schema.hasColumn('business_profile', 'pdf_folding_marks'))) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.string('pdf_folding_marks', 16).notNullable().defaultTo('none');
    });
    await knex('business_profile').update({ pdf_folding_marks: 'none' });
  }

  if (!(await knex.schema.hasColumn('business_profile', 'pdf_logo_height'))) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.integer('pdf_logo_height').notNullable().defaultTo(56);
    });
    await knex('business_profile').update({ pdf_logo_height: 56 });
  }

  if (!(await knex.schema.hasColumn('business_profile', 'pdf_company_name_inline'))) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.boolean('pdf_company_name_inline').notNullable().defaultTo(false);
    });
    await knex('business_profile').update({ pdf_company_name_inline: false });
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  for (const col of ['pdf_folding_marks', 'pdf_logo_height', 'pdf_company_name_inline']) {
    if (await knex.schema.hasColumn('business_profile', col)) {
      await knex.schema.alterTable('business_profile', (table) => {
        table.dropColumn(col);
      });
    }
  }
};
