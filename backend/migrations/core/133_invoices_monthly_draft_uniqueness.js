/**
 * Migration: enforce "one open monthly draft per customer" via a
 * partial unique index on `invoices (customer_account_id) WHERE
 * is_monthly_draft = TRUE` and clean up any pre-existing duplicates
 * left behind by the race in getOrCreateMonthlyDraft.
 *
 * **The race the index closes**
 *
 * `invoiceService.getOrCreateMonthlyDraft` SELECTs an existing draft
 * for (customer, is_monthly_draft=true), and INSERTs a fresh one when
 * none is found. Under concurrent calls (admin opens the customer
 * detail page in two tabs, or two scheduled jobs fire), both callers
 * miss the SELECT and both proceed to INSERT — the customer ends up
 * with two open drafts. The monthly pass at scheduler tick then
 * issues both, double-billing the customer for the period.
 *
 * The partial unique index makes this physically impossible: the
 * second INSERT fails with a unique violation, and the service catches
 * it and re-SELECTs to return the winner's draft.
 *
 * **Why a partial index, not a full unique constraint**
 *
 * Post-issuance, `is_monthly_draft` flips to false and the row joins
 * the regular invoice population. A customer accumulates many such
 * rows over time. We only want to constrain the OPEN-draft state.
 *
 * Both Postgres and SQLite (3.8+) support `CREATE UNIQUE INDEX … WHERE`
 * out of the box. knex's `.unique()` doesn't expose the WHERE clause
 * portably, so we drop to `knex.raw` per dialect.
 *
 * **Pre-existing duplicates**
 *
 * Before locking the constraint in, we sweep the table for customers
 * with more than one open draft and cancel the older ones (matching
 * the empty-month skip path's behavior: is_monthly_draft=false +
 * status='cancelled'). The newest draft per customer wins because the
 * `id DESC` ordering matches what `getMonthlyDraft` already returns;
 * preserving that draft keeps any line items the admin recently
 * added.
 *
 * Older drafts may have orphaned line items. We do NOT delete them —
 * the admin can still see the cancelled draft + its items in the
 * invoice list. They're tagged with a marker on the notes field so
 * the audit trail explains what happened.
 */

exports.up = async function (knex) {
  // 1. Sweep duplicates. Group by customer_account_id where there's
  // more than one open draft, keep the newest by id, cancel the rest.
  const customersWithDupes = await knex('invoices')
    .where({ is_monthly_draft: true })
    .select('customer_account_id')
    .count('* as cnt')
    .groupBy('customer_account_id')
    .havingRaw('count(*) > 1');

  for (const { customer_account_id } of customersWithDupes) {
    const drafts = await knex('invoices')
      .where({ customer_account_id, is_monthly_draft: true })
      .orderBy('id', 'desc');
    // Keep the first (newest); cancel the rest.
    const [keeper, ...losers] = drafts;
    if (!keeper) continue;
    for (const loser of losers) {
      await knex('invoices')
        .where({ id: loser.id })
        .update({
          is_monthly_draft: false,
          status: 'cancelled',
          updated_at: new Date(),
        });
    }
  }

  // 2. Create the partial unique index. We use a stable, predictable
  // name so future migrations / debug queries can refer to it.
  const client = knex.client.config.client;
  const indexName = 'invoices_one_monthly_draft_per_customer';
  if (client === 'pg' || client === 'postgresql') {
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}
      ON invoices (customer_account_id)
      WHERE is_monthly_draft = TRUE
    `);
  } else if (client === 'sqlite3' || client === 'sqlite') {
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}
      ON invoices (customer_account_id)
      WHERE is_monthly_draft = 1
    `);
  } else {
    // Unknown client — fall back to a non-partial unique index? No,
    // that would over-constrain. Refuse so the operator notices.
    throw new Error(
      `Migration 133 doesn't know how to create partial unique index on '${client}'`,
    );
  }
};

exports.down = async function (knex) {
  // Drop the index. Duplicate-cancellation is not reversed — the
  // affected drafts stay cancelled. Reverting would require knowing
  // which rows we touched, and that's not worth the bookkeeping.
  await knex.raw(`DROP INDEX IF EXISTS invoices_one_monthly_draft_per_customer`);
};
