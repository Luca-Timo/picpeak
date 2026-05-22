/**
 * Migration: add the columns the admin calendar feature needs.
 *
 * Two surfaces are extended:
 *
 *   1. `events`: a calendar that draws timed blocks needs HH:MM start/end
 *      on the event itself. Quotes/contracts/invoices already snapshot
 *      these via the migration-123 columns, but the `events` table — the
 *      authoritative source for "this event exists, with this date" —
 *      only carried `event_date` (DATE, no time-of-day). Adding three
 *      columns:
 *        - event_time_start  VARCHAR(5)  NULL    "HH:MM"
 *        - event_time_end    VARCHAR(5)  NULL    "HH:MM"
 *        - is_full_day       BOOLEAN     NOT NULL DEFAULT TRUE
 *      `is_full_day` is the durable invariant (per
 *      feedback_invariant_in_schema_not_path.md: encode it as a column,
 *      not via "are the time fields null?"). Existing rows backfill to
 *      `is_full_day=TRUE` so behavior is unchanged on upgrade.
 *
 *   2. `business_profile`: the admin calendar renders timed blocks in
 *      the operator's working timezone. We add an admin-only IANA
 *      timezone string (e.g. "Europe/Zurich"). When NULL the frontend
 *      falls back to the browser's `Intl.DateTimeFormat().resolvedOptions()
 *      .timeZone`. Not exposed via publicSettings — it's admin-only
 *      configuration.
 *
 * Idempotent. Mirrors the explicit-hasColumn pattern of migration 123
 * (a swallowed dup-column error in Postgres aborts the surrounding
 * transaction and crash-loops the migration).
 */

exports.up = async function (knex) {
  // -- events: event_time_start, event_time_end, is_full_day -----------
  if (await knex.schema.hasTable('events')) {
    if (!(await knex.schema.hasColumn('events', 'event_time_start'))) {
      await knex.schema.alterTable('events', (table) => {
        table.string('event_time_start', 5); // "HH:MM"
      });
    }
    if (!(await knex.schema.hasColumn('events', 'event_time_end'))) {
      await knex.schema.alterTable('events', (table) => {
        table.string('event_time_end', 5);
      });
    }
    if (!(await knex.schema.hasColumn('events', 'is_full_day'))) {
      await knex.schema.alterTable('events', (table) => {
        // NOT NULL with default TRUE so existing rows backfill cleanly.
        // SQLite + Postgres both accept the literal default.
        table.boolean('is_full_day').notNullable().defaultTo(true);
      });
    }
    // Defensive backfill: any rows that have a NULL is_full_day (could
    // happen if a prior dev install added the column without the default
    // before we shipped this migration) get set to true. Knex's
    // `whereNull` plus an explicit UPDATE — idempotent.
    await knex('events').whereNull('is_full_day').update({ is_full_day: true });
  }

  // -- business_profile: timezone --------------------------------------
  if (await knex.schema.hasTable('business_profile')) {
    if (!(await knex.schema.hasColumn('business_profile', 'timezone'))) {
      await knex.schema.alterTable('business_profile', (table) => {
        table.string('timezone', 64); // nullable; e.g. "Europe/Zurich"
      });
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('events')) {
    for (const col of ['is_full_day', 'event_time_end', 'event_time_start']) {
      if (await knex.schema.hasColumn('events', col)) {
        await knex.schema.alterTable('events', (table) => {
          table.dropColumn(col);
        });
      }
    }
  }
  if (await knex.schema.hasTable('business_profile')) {
    if (await knex.schema.hasColumn('business_profile', 'timezone')) {
      await knex.schema.alterTable('business_profile', (table) => {
        table.dropColumn('timezone');
      });
    }
  }
};
