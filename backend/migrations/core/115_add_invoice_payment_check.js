/**
 * Migration: invoice payment-check workflow
 *
 * Adds the pieces needed for the admin-confirmed reminder flow:
 *
 *   invoice_payment_check_tokens
 *     One-shot signed tokens embedded in the email buttons. When
 *     the admin clicks "Paid in full" / "Partially paid" / "Not
 *     paid", the page at /payment-check/<token> exchanges the
 *     token for the invoice context (no login needed). Token is
 *     consumed on use.
 *
 *   invoices.last_payment_check_at
 *     Throttles duplicate emails — we don't queue another check
 *     within 24h of the previous one for the same invoice.
 *
 * Idempotent.
 */

exports.up = async function(knex) {
  const hasTokensTable = await knex.schema.hasTable('invoice_payment_check_tokens');
  if (!hasTokensTable) {
    await knex.schema.createTable('invoice_payment_check_tokens', (table) => {
      table.increments('id').primary();
      table.integer('invoice_id').unsigned().notNullable()
        .references('id').inTable('invoices').onDelete('CASCADE');
      // 64-char hex — same shape quote_action_tokens uses, so any
      // existing rate-limit / format checks can re-use the rule.
      table.string('token', 64).notNullable().unique();
      table.timestamp('expires_at').notNullable();
      table.timestamp('used_at');
      // 'paid_full' | 'partial' | 'unpaid'
      table.string('used_action', 16);
      // For partial payments — minor units.
      table.bigInteger('used_amount_minor');
      table.string('used_ip', 64);
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['invoice_id']);
      table.index(['used_at']);
    });
  }

  if (await knex.schema.hasTable('invoices')) {
    const has = await knex.schema.hasColumn('invoices', 'last_payment_check_at');
    if (!has) {
      await knex.schema.alterTable('invoices', (table) => {
        table.timestamp('last_payment_check_at');
      });
    }
  }
};

exports.down = async function(knex) {
  if (await knex.schema.hasTable('invoices')
    && await knex.schema.hasColumn('invoices', 'last_payment_check_at')) {
    await knex.schema.alterTable('invoices', (table) => {
      table.dropColumn('last_payment_check_at');
    });
  }
  await knex.schema.dropTableIfExists('invoice_payment_check_tokens');
};
