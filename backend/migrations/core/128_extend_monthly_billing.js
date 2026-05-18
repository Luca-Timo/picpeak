/**
 * Migration: extend invoices for monthly-billing accumulators.
 *
 * `customer_accounts.billing_cadence` ('per_event' | 'monthly' |
 * 'quarterly') and `billing_cycle_day` have existed since migration
 * 102 but were dormant — no codepath actually accumulated items into
 * a monthly bundle.  This migration adds three columns to `invoices`
 * so the new monthly flow can:
 *
 *   - `is_monthly_draft` (boolean, default false) — marks the running
 *      accumulator for a monthly-mode customer.  Multiple admin saves
 *      against the same customer in the same period APPEND line items
 *      to this single draft instead of minting fresh invoices.  The
 *      scheduler flips it to false + status='scheduled' on the
 *      customer's cadence day, after which the existing flush-pass
 *      sends it like any other scheduled invoice.
 *
 *   - `monthly_period_start` / `monthly_period_end` (date, nullable) —
 *      stamped on the draft when items first land.  Drives the
 *      "Billing period: 2026-04-15 → 2026-05-15" line on the PDF and
 *      the period banner on the customer detail page.  Null on every
 *      non-monthly row, never read for them.
 *
 * Idempotent (hasColumn guards) — follows the migration-114 pattern
 * so a Postgres rerun doesn't crash-loop on duplicate-column.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;

  if (!(await knex.schema.hasColumn('invoices', 'is_monthly_draft'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.boolean('is_monthly_draft').notNullable().defaultTo(false);
    });
  }

  if (!(await knex.schema.hasColumn('invoices', 'monthly_period_start'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.date('monthly_period_start');
    });
  }

  if (!(await knex.schema.hasColumn('invoices', 'monthly_period_end'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.date('monthly_period_end');
    });
  }

  // Partial index for the scheduler's monthly-pass lookup. SQLite +
  // Postgres both support `CREATE INDEX IF NOT EXISTS`. Limited to
  // is_monthly_draft=true rows so the index stays small even when the
  // invoices table grows.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS invoices_monthly_draft_idx '
    + 'ON invoices (customer_account_id, monthly_period_end) '
    + 'WHERE is_monthly_draft = true',
  ).catch(async () => {
    // SQLite versions before 3.8.0 don't support partial indexes; fall
    // back to a regular index. Postgres always takes the WHERE-clause
    // path above.
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS invoices_monthly_draft_idx '
      + 'ON invoices (customer_account_id, monthly_period_end)',
    );
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  await knex.raw('DROP INDEX IF EXISTS invoices_monthly_draft_idx').catch(() => {});
  for (const col of ['monthly_period_end', 'monthly_period_start', 'is_monthly_draft']) {
    if (await knex.schema.hasColumn('invoices', col)) {
      await knex.schema.alterTable('invoices', (table) => {
        table.dropColumn(col);
      });
    }
  }
};
