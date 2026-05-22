/**
 * Migration: add `document_sequences` table for atomic gap-free
 * document-number generation across invoices, quotes, contracts.
 *
 * **Why this exists**
 *
 * The previous `nextInvoiceNumber` / `nextQuoteNumber` /
 * `nextContractNumber` helpers all followed the same shape:
 *   1. SELECT MAX(seq) FROM <table> WHERE number LIKE <year-prefix>
 *   2. Construct candidate = year-prefix + (maxSeq + 1)
 *   3. SELECT existing WHERE number = candidate; if found, retry up to
 *      5 times, then fall through to a random hex suffix.
 *
 * Under concurrent admin creates, steps 1+2 race: two callers see the
 * same MAX, both produce the same candidate, both pass the existence
 * check, both insert. The retry loop catches some races but the 6th
 * fallback emits a non-sequential `R-2026-AB12C3` which:
 *   - breaks the "gap-free single sequence per year" promise that
 *     §14 UStG (Germany) / Art. 26 UStG (Austria) / Art. 26 MWSTG
 *     (Switzerland) all require for invoice numbering;
 *   - silently downgrades the audit trail without any operator
 *     warning.
 *
 * **What this table provides**
 *
 * One row per (kind, year). The `current_value` is the last sequence
 * issued; the next claim does `UPDATE … SET current_value = current_value + 1
 * RETURNING current_value` (Postgres) or `UPDATE` inside a `BEGIN
 * IMMEDIATE` transaction (SQLite). Either path is atomic against
 * concurrent writers on the same row.
 *
 * Two callers requesting an invoice number simultaneously serialize
 * on the row lock (Postgres) or transaction lock (SQLite) — the second
 * caller waits, then receives a value strictly higher than the first.
 * No retry loop, no random-suffix fallback.
 *
 * **Initial value backfill**
 *
 * On apply we pre-populate each (kind, year) row with the current MAX
 * sequence found in the existing data, so the next claim continues
 * the existing series rather than starting at 1. Subsequent year
 * rollovers create new rows on demand via UPSERT (handled in the
 * service layer).
 *
 * **Schema-drift note**
 *
 * Subsumes the in-line MAX-then-INSERT logic. The old helpers are
 * rewritten to use this table; the table itself is new and
 * idempotent on apply.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('document_sequences'))) {
    await knex.schema.createTable('document_sequences', (table) => {
      table.increments('id').primary();
      // Discriminator: 'invoice' | 'quote' | 'contract'. Kept open as
      // a string rather than an enum so future doc types (storno,
      // proforma, etc.) can use the same table without a schema change.
      table.string('kind', 32).notNullable();
      table.integer('year').notNullable();
      table.integer('current_value').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      // Uniqueness guarantee: one sequence row per (kind, year).
      // Lookups + atomic increments both go through this index.
      table.unique(['kind', 'year']);
    });
  }

  // Backfill from existing data. We compute MAX(seq) per year for
  // each document type by stripping the numeric suffix, then write
  // the result into document_sequences so the next claim continues
  // the existing series. Idempotent: ON CONFLICT … DO NOTHING via
  // existence check (works on both Postgres + SQLite).
  const seedKind = async (tableName, numberColumn, kind) => {
    if (!(await knex.schema.hasTable(tableName))) return;
    const rows = await knex(tableName).select(numberColumn);
    const byYear = new Map();
    for (const row of rows) {
      const num = row[numberColumn];
      if (!num) continue;
      // Numbers look like LBM-R-2026-0042, R-2026-0042, Q-2026-0007,
      // C-2026-0001, etc. Pull the year + the trailing numeric run.
      const m = String(num).match(/(\d{4}).*?(\d+)\s*$/);
      if (!m) continue;
      const year = parseInt(m[1], 10);
      const seq = parseInt(m[2], 10);
      if (!Number.isFinite(year) || !Number.isFinite(seq)) continue;
      const prev = byYear.get(year) || 0;
      if (seq > prev) byYear.set(year, seq);
    }
    for (const [year, current_value] of byYear) {
      const existing = await knex('document_sequences')
        .where({ kind, year }).first();
      if (existing) continue;
      await knex('document_sequences').insert({
        kind, year, current_value, created_at: new Date(), updated_at: new Date(),
      });
    }
  };

  await seedKind('invoices', 'invoice_number', 'invoice');
  await seedKind('quotes', 'quote_number', 'quote');
  await seedKind('contracts', 'contract_number', 'contract');
};

exports.down = async function (knex) {
  // No state migration on rollback — services fall back to the old
  // MAX-then-INSERT path which still works (just races).
  await knex.schema.dropTableIfExists('document_sequences');
};
