/**
 * Migration: pre-event customer reminder emails.
 *
 * Adds:
 *   - 4 columns on `events` for per-event overrides + idempotency
 *   - 2 `app_settings` rows for global enable + days-before default
 *
 * Template content (`event_reminder_default` + per-type variants) is
 * NOT seeded here — see `backend/src/services/eventReminderTemplates.js`
 * for the definitions, and `ensureEventReminderTemplatesSeeded()` for
 * the runtime self-heal that creates / backfills them. Reasons:
 *   - The migration ran on dev installs while we iterated on the
 *     template body; in-migration seeding cannot be re-run, so dev DBs
 *     ended up with empty `event_reminder_default` rows.
 *   - Per-event-type variants are added by an admin via the Reminder
 *     Emails settings tab, but pre-seeding the four system event_types
 *     (wedding/birthday/corporate/other) gives them an editable starting
 *     point. Runtime self-heal lets us ship that content here.
 *
 * Per-event override semantics:
 *   - `event_reminder_disabled` — boolean, default false. Admin
 *     toggles to suppress reminder for THIS event without flipping
 *     the global setting.
 *   - `event_reminder_offset_days` — nullable int. Overrides the
 *     global `crm_event_reminders_days_before` when set.
 *   - `event_reminder_body_override` — nullable text. When set,
 *     replaces the resolved template body for THIS event. Admin uses
 *     this to add event-specific instructions ("the venue has no
 *     loading zone; arrive via the rear door").
 *   - `event_reminder_sent_at` — timestamp, NULL until the scheduler
 *     fires. Idempotency guard so the cron can't double-send.
 *
 * Recipient: events.customer_account_id (primary). Multi-customer
 * assignments via event_customer_assignments are NOT in scope —
 * confirmed with maintainer 2026-05-25.
 *
 * Cron: piggybacks on the existing scheduler tick (≈5 min). Picks
 * events where `event_date - offset_days <= NOW() AND
 * event_reminder_sent_at IS NULL AND not disabled AND has customer
 * email`. Idempotent because of the sent_at guard.
 *
 * Idempotent end-to-end; hasColumn / row-existence guards everywhere.
 */

exports.up = async function (knex) {
  // ---- events columns ----------------------------------------------------
  if (await knex.schema.hasTable('events')) {
    if (!(await knex.schema.hasColumn('events', 'event_reminder_disabled'))) {
      await knex.schema.alterTable('events', (t) => {
        t.boolean('event_reminder_disabled').notNullable().defaultTo(false);
      });
    }
    if (!(await knex.schema.hasColumn('events', 'event_reminder_offset_days'))) {
      await knex.schema.alterTable('events', (t) => {
        t.integer('event_reminder_offset_days'); // nullable; null = inherit global
      });
    }
    if (!(await knex.schema.hasColumn('events', 'event_reminder_body_override'))) {
      await knex.schema.alterTable('events', (t) => {
        t.text('event_reminder_body_override');
      });
    }
    if (!(await knex.schema.hasColumn('events', 'event_reminder_sent_at'))) {
      await knex.schema.alterTable('events', (t) => {
        t.timestamp('event_reminder_sent_at');
        t.index('event_reminder_sent_at', 'events_event_reminder_sent_at_idx');
      });
    }
  }

  // ---- app_settings (global toggles) -------------------------------------
  if (await knex.schema.hasTable('app_settings')) {
    const seeds = [
      { key: 'crm_event_reminders_enabled',     value: false, type: 'crm' },
      { key: 'crm_event_reminders_days_before', value: 2,     type: 'crm' },
    ];
    for (const s of seeds) {
      const existing = await knex('app_settings').where({ setting_key: s.key }).first();
      if (existing) continue;
      await knex('app_settings').insert({
        setting_key: s.key,
        setting_value: JSON.stringify(s.value),
        setting_type: s.type,
      });
    }
  }

  // Template content is seeded by ensureEventReminderTemplatesSeeded()
  // at runtime — see header comment.
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('events')) {
    for (const col of [
      'event_reminder_sent_at',
      'event_reminder_body_override',
      'event_reminder_offset_days',
      'event_reminder_disabled',
    ]) {
      if (await knex.schema.hasColumn('events', col)) {
        await knex.schema.alterTable('events', (t) => {
          if (col === 'event_reminder_sent_at') {
            t.dropIndex('event_reminder_sent_at', 'events_event_reminder_sent_at_idx');
          }
          t.dropColumn(col);
        });
      }
    }
  }
  // app_settings + email_templates seeds are left in place on down —
  // matches the pattern in migration 105.
};
