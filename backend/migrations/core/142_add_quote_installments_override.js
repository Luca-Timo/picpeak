/**
 * Migration: add `payment_term_installments_override` column on
 * quotes to support per-quote ad-hoc installment plans (commit #6 of
 * the deal_uuid PR).
 *
 * Today the snapshot of installments comes from the picked payment-
 * timing template — same plan reused across every quote on that
 * template. The ad-hoc panel in the Quote editor lets admin override
 * the installment shape for ONE quote without editing the template.
 *
 * This column stores the override as a JSON array of
 * `{ label, percent, trigger, offset_days }` rows. When NULL the
 * quote uses the template's installments as-is (existing behaviour).
 * When set, composeSnapshotFromSplitFks substitutes the override
 * into the snapshot so the spawn-on-convert path (quoteService
 * .convertToInvoiceOnly / convertToEvent) sees the admin's chosen
 * plan, not the template's.
 *
 * Idempotent. Cross-dialect: knex.json() maps to JSONB on Postgres
 * and TEXT on SQLite, both transparent to the service-layer reads
 * (the existing snapshot fields use the same approach).
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('quotes'))) return;
  if (await knex.schema.hasColumn('quotes', 'payment_term_installments_override')) return;
  await knex.schema.alterTable('quotes', (table) => {
    table.json('payment_term_installments_override');
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('quotes'))) return;
  if (!(await knex.schema.hasColumn('quotes', 'payment_term_installments_override'))) return;
  await knex.schema.alterTable('quotes', (table) => {
    table.dropColumn('payment_term_installments_override');
  });
};
