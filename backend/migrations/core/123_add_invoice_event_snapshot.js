/**
 * Migration: inline event snapshot on invoices.
 *
 * Invoices previously linked to events only via `event_id` (FK). The
 * admin invoice editor exposed no event fields and emails / list views
 * had no event reference — `sendInvoice` was passing
 * `event_name: ''` hardcoded into the `invoice_sent` template. Quotes
 * already carry an inline snapshot (event_name / event_date /
 * event_time_start / event_time_end, added in migration 102) for two
 * reasons:
 *   1. A quote can be authored before the `events` row exists.
 *   2. A snapshot doesn't silently mutate if the event is later
 *      renamed — a customer's archived invoice must keep its original
 *      event label for audit / accounting.
 *
 * Mirror that pattern on invoices. The `event_id` FK stays — it's
 * still authoritative for portal access and dunning queries that
 * filter by event — but rendering surfaces (PDF emails, admin lists,
 * tax report, customer portal) now read from the inline snapshot.
 *
 * Backfill: existing invoices with `event_id` set get their snapshot
 * populated from the linked event so the admin/customer UI doesn't
 * regress on existing data. Only `event_name` and `event_date` are
 * backfilled — the `events` table doesn't carry HH:MM start/end times,
 * so those stay NULL for historical rows.
 *
 * Idempotent. Pattern lifted from migration 114 (explicit hasColumn
 * guards rather than .catch on alterTable — a swallowed dup-column
 * error in Postgres aborts the surrounding transaction and crash-loops
 * the migration).
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;

  if (!(await knex.schema.hasColumn('invoices', 'event_name'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.string('event_name', 255);
    });
  }

  if (!(await knex.schema.hasColumn('invoices', 'event_date'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.date('event_date');
    });
  }

  if (!(await knex.schema.hasColumn('invoices', 'event_time_start'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.string('event_time_start', 8);   // "HH:MM"
    });
  }

  if (!(await knex.schema.hasColumn('invoices', 'event_time_end'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.string('event_time_end', 8);
    });
  }

  // Backfill from the linked event for existing rows. Subquery form
  // (rather than UPDATE ... FROM) so the same SQL works on both
  // Postgres and SQLite. `IS NULL` guard keeps it idempotent — re-runs
  // after the user has manually edited event_name on an invoice won't
  // overwrite the edit.
  if (await knex.schema.hasTable('events')) {
    await knex('invoices')
      .whereNull('event_name')
      .whereNotNull('event_id')
      .update({
        event_name: knex.raw('(SELECT event_name FROM events WHERE events.id = invoices.event_id)'),
      });
    await knex('invoices')
      .whereNull('event_date')
      .whereNotNull('event_id')
      .update({
        event_date: knex.raw('(SELECT event_date FROM events WHERE events.id = invoices.event_id)'),
      });
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  for (const col of ['event_time_end', 'event_time_start', 'event_date', 'event_name']) {
    if (await knex.schema.hasColumn('invoices', col)) {
      await knex.schema.alterTable('invoices', (table) => {
        table.dropColumn(col);
      });
    }
  }
};
