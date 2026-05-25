/**
 * Migration: pre-event customer reminder emails.
 *
 * Adds:
 *   - 4 columns on `events` for per-event overrides + idempotency
 *   - 2 `app_settings` rows for global enable + days-before default
 *   - 1 seed `email_templates` row: `event_reminder_default`
 *     (catch-all template — admin can add per-event-type rows later
 *     keyed `event_reminder_<slug_prefix>` via the existing template
 *     editor, no schema change needed)
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

  // ---- seed catch-all template ------------------------------------------
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const existingTemplate = await knex('email_templates')
    .where({ template_key: 'event_reminder_default' })
    .first();
  if (existingTemplate) return;

  const cols = await knex('email_templates').columnInfo();
  const hasTranslations = await knex.schema.hasTable('email_template_translations');

  // Empty starter content — admin writes the real subject/body via the
  // Settings → Reminder emails page (no hard-coded copy in the
  // migration). Variables stay declared on the master row so the
  // editor knows which `{{tokens}}` are available.
  const en = { subject: '', body_text: '', body_html: '' };
  const de = { subject: '', body_text: '', body_html: '' };

  const masterRow = {
    template_key: 'event_reminder_default',
    variables: JSON.stringify([
      'customer_name', 'event_name', 'event_date',
      'event_type', 'days_before', 'business_name',
    ]),
  };
  if ('category' in cols)     masterRow.category = 'crm';
  if ('subcategory' in cols)  masterRow.subcategory = 'event_reminder';
  if ('feature_flag' in cols) masterRow.feature_flag = 'crm_event_reminders_enabled';
  if ('created_at' in cols)   masterRow.created_at = new Date();
  if ('updated_at' in cols)   masterRow.updated_at = new Date();
  for (const colName of Object.keys(cols)) {
    if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
      masterRow[colName] = en.subject;
    } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
      masterRow[colName] = en.body_html;
    } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
      masterRow[colName] = en.body_text;
    }
  }

  const inserted = await knex('email_templates').insert(masterRow).returning('id');
  const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  if (hasTranslations && templateId) {
    for (const [lang, content] of [['en', en], ['de', de]]) {
      await knex('email_template_translations').insert({
        template_id: templateId,
        language: lang,
        subject: content.subject,
        body_html: content.body_html,
        body_text: content.body_text,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }
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
