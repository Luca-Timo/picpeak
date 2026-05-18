/**
 * Migration: record Skonto application on the payment log + add a
 * per-invoice Skonto-disabled toggle.
 *
 * Admin marks an invoice "paid with Skonto" when the customer
 * settled the bill within the early-payment-discount window. The
 * recorded `paid_amount_minor` on `invoice_payment_log` is the
 * discounted amount (total minus Skonto %), but until now there was
 * no way to distinguish a Skonto-discounted payment from a regular
 * partial / underpaid one — both look like "paid less than total".
 *
 * Two new nullable columns on `invoice_payment_log`:
 *
 *   - skonto_applied      boolean (default false) — true when the
 *                         admin ticked "Paid with Skonto" on the
 *                         payment dialog or the payment-check
 *                         workflow.
 *   - skonto_amount_minor bigint (nullable)       — the discount in
 *                         minor units (total - paid). Stored
 *                         explicitly so the tax report / admin
 *                         notification email can show the absolute
 *                         amount without re-deriving from the
 *                         Skonto percentage (which can drift on the
 *                         template after-the-fact).
 *
 * One new column on `invoices`:
 *
 *   - skonto_disabled     boolean (default false) — admin can opt
 *                         out of Skonto for a single invoice even
 *                         when the global / template default offers
 *                         it. Useful for Storni / payment-plan
 *                         installments / replacement invoices that
 *                         shouldn't qualify. The Skonto resolver
 *                         honours this before falling back to the
 *                         snapshot/template/global chain.
 *
 * Idempotent (hasColumn guards) — follows the migration-114 pattern
 * to avoid Postgres aborted-transaction crash-loops on rerun.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('invoice_payment_log'))) return;

  if (!(await knex.schema.hasColumn('invoice_payment_log', 'skonto_applied'))) {
    await knex.schema.alterTable('invoice_payment_log', (table) => {
      table.boolean('skonto_applied').notNullable().defaultTo(false);
    });
  }

  if (!(await knex.schema.hasColumn('invoice_payment_log', 'skonto_amount_minor'))) {
    await knex.schema.alterTable('invoice_payment_log', (table) => {
      table.bigInteger('skonto_amount_minor');
    });
  }

  if (await knex.schema.hasTable('invoices')
    && !(await knex.schema.hasColumn('invoices', 'skonto_disabled'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.boolean('skonto_disabled').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function(knex) {
  if (await knex.schema.hasTable('invoices')
    && await knex.schema.hasColumn('invoices', 'skonto_disabled')) {
    await knex.schema.alterTable('invoices', (table) => {
      table.dropColumn('skonto_disabled');
    });
  }
  if (!(await knex.schema.hasTable('invoice_payment_log'))) return;
  for (const col of ['skonto_amount_minor', 'skonto_applied']) {
    if (await knex.schema.hasColumn('invoice_payment_log', col)) {
      await knex.schema.alterTable('invoice_payment_log', (table) => {
        table.dropColumn(col);
      });
    }
  }
};
