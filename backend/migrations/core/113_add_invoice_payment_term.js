/**
 * Migration: invoices payment-term selection
 *
 *   invoices.payment_term_template_id   FK → payment_term_templates
 *   invoices.payment_term_snapshot      JSON copy of the template
 *
 * Today invoices only carry payment-term info when they were created
 * from a quote — the renderer pulls the snapshot from the source
 * quote's `payment_term_snapshot`. Standalone invoices (created via
 * the New Invoice button) fall back to the global crm_invoices_*
 * defaults, which means admins can't choose alternate terms per
 * invoice.
 *
 * This migration adds the same two columns the `quotes` table
 * already has, so the invoice editor can offer a payment-term
 * dropdown. The renderer prefers `invoices.payment_term_snapshot`
 * when present, then falls back to the source quote's snapshot,
 * then to the global defaults.
 *
 * Idempotent.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;

  if (!(await knex.schema.hasColumn('invoices', 'payment_term_template_id'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.integer('payment_term_template_id').unsigned()
        .references('id').inTable('payment_term_templates').onDelete('SET NULL');
    });
  }

  if (!(await knex.schema.hasColumn('invoices', 'payment_term_snapshot'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.json('payment_term_snapshot');
    });
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  for (const col of ['payment_term_snapshot', 'payment_term_template_id']) {
    if (await knex.schema.hasColumn('invoices', col)) {
      await knex.schema.alterTable('invoices', (table) => {
        table.dropColumn(col);
      });
    }
  }
};
