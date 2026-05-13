/**
 * Migration: business_profile — quote payment-block visibility
 *
 * Adds two toggles that control which rows of the payment-conditions
 * block render on QUOTE PDFs (invoice PDFs are unaffected — they
 * always show the full block including IBAN):
 *
 *   pdf_quote_show_net_days  BOOLEAN, default FALSE
 *     "30 days from invoice date." informational line on the quote.
 *
 *   pdf_quote_show_skonto    BOOLEAN, default FALSE
 *     The "3% discount if paid within 5 working days." line and the
 *     "Amount with discount: …" line.
 *
 * IBAN / account holder is unconditionally suppressed on quotes
 * (handled in pdfService) — a quote is an offer, not a demand for
 * payment, so wiring money against an unsigned quote shouldn't be
 * encouraged.
 *
 * Defaults false: per the maintainer's design preference, quotes
 * communicate scope + price only. Payment terms get codified in the
 * invoice that follows. Admins can re-enable per-business via the
 * settings UI when they want to set expectations on the quote.
 *
 * Idempotent.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;

  if (!(await knex.schema.hasColumn('business_profile', 'pdf_quote_show_net_days'))) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.boolean('pdf_quote_show_net_days').notNullable().defaultTo(false);
    });
    await knex('business_profile').update({ pdf_quote_show_net_days: false });
  }

  if (!(await knex.schema.hasColumn('business_profile', 'pdf_quote_show_skonto'))) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.boolean('pdf_quote_show_skonto').notNullable().defaultTo(false);
    });
    await knex('business_profile').update({ pdf_quote_show_skonto: false });
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  for (const col of ['pdf_quote_show_net_days', 'pdf_quote_show_skonto']) {
    if (await knex.schema.hasColumn('business_profile', col)) {
      await knex.schema.alterTable('business_profile', (table) => {
        table.dropColumn(col);
      });
    }
  }
};
