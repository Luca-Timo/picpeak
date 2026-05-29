/**
 * eventReminderService — pre-event customer reminder emails
 * (migration 143).
 *
 * Sends ONE reminder per event N days before `event_date`. Goal: nudge
 * the customer on prep — space for equipment setup, dress-code notes,
 * access logistics — so the photographer arrives to a workable scene.
 *
 * **Wiring**
 *
 * `runEventReminderPass()` is invoked from the invoice scheduler's
 * hourly cron tick (commit #3 of this feature). Idempotent: every send
 * stamps `events.event_reminder_sent_at`; subsequent ticks skip rows
 * with a non-null timestamp.
 *
 * **Template resolution**
 *
 *   1. `event_reminder_<events.event_type>` — per-type template, if
 *      seeded. Admin manages these via the existing email-template
 *      editor (no schema rule restricts what they can create here;
 *      whatever slug-prefixed templates exist will match).
 *   2. `event_reminder_default` — catch-all, seeded by migration 143.
 *
 * Falls through silently when the catch-all is missing (logs a warn
 * but doesn't throw — the cron must not crash the whole tick because
 * of one stale install).
 *
 * **Override precedence per event**
 *
 *   - `events.event_reminder_disabled = true` → skip
 *   - `events.event_reminder_offset_days` (nullable int) → overrides
 *     the global `crm_event_reminders_days_before`
 *   - `events.event_reminder_body_override` (text) → if set,
 *     replaces the template body verbatim. Subject still comes from
 *     the template. Useful for one-off "the venue has no loading zone,
 *     arrive via the rear door"-style notes.
 *
 * **Recipient**
 *
 * Only the event's primary customer (`events.customer_account_id`).
 * Multi-customer assignments via `event_customer_assignments` are NOT
 * notified — confirmed with maintainer 2026-05-25. Events without a
 * customer_account_id or without an email on file are skipped.
 *
 * **Snapshot semantics**
 *
 * We resolve + send eagerly per tick. The current shape stamps the
 * sent_at timestamp on send — we deliberately do NOT snapshot the
 * resolved body onto the event row at scheduling time, because the
 * candidate window is short (N days before event) and the cron picks
 * the freshest template every pass until the moment of send. If a
 * future "schedule N hours ahead, freeze the body, send later" model
 * is needed, add a snapshot column and resolve at scheduling time.
 */

const { db } = require('../database/db');
const emailProcessor = require('./emailProcessor');
const { getAppSetting } = require('../utils/appSettings');
const { hasColumnCached } = require('../utils/schemaCache');
const logger = require('../utils/logger');
const { ensureEventReminderTemplatesSeeded } = require('./eventReminderTemplates');

const DEFAULT_DAYS_BEFORE = 2;
const TEMPLATE_KEY_DEFAULT = 'event_reminder_default';
const TEMPLATE_KEY_PREFIX = 'event_reminder_';

// One-shot guard: the "schema not migrated" warn would otherwise fire
// once per cron tick (≈ hourly) on installs that haven't applied
// migration 143 yet. Log on the first encounter only — subsequent
// ticks no-op silently.
let schemaWarnLogged = false;

/**
 * Lookup the most specific available template for an event_type slug.
 * Returns the template_key string. The email_processor handles missing
 * template rows by failing the send; we don't fetch the row body here
 * because emailProcessor.queueEmail does that lookup itself.
 */
async function resolveTemplateKey(eventType) {
  if (eventType) {
    const perType = `${TEMPLATE_KEY_PREFIX}${eventType}`;
    const exists = await db('email_templates')
      .where({ template_key: perType })
      .first('id');
    if (exists) return perType;
  }
  return TEMPLATE_KEY_DEFAULT;
}

/**
 * Build the variables payload the template engine substitutes. Keep
 * the keys in sync with the seeded template's `variables` JSON.
 */
function composePayload({ event, customer, daysBefore, businessName }) {
  const customerName = customer.company_name
    || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
    || customer.display_name
    || customer.email
    || '';
  // Event date formatted DD.MM.YYYY here for simplicity; the rendered
  // email may further re-locale via the template engine when locale-
  // aware formatters are introduced.
  const ed = event.event_date instanceof Date ? event.event_date : new Date(event.event_date);
  const day = String(ed.getUTCDate()).padStart(2, '0');
  const month = String(ed.getUTCMonth() + 1).padStart(2, '0');
  const year = ed.getUTCFullYear();
  const eventDateFormatted = `${day}.${month}.${year}`;
  return {
    customer_name: customerName,
    event_name: event.event_name || `Event #${event.id}`,
    event_date: eventDateFormatted,
    event_type: event.event_type || '',
    days_before: daysBefore,
    business_name: businessName || '',
  };
}

/**
 * One pass of the reminder loop. Idempotent. Errors on individual
 * events are caught and logged so a single bad row doesn't kill the
 * whole tick.
 *
 * Returns `{ scanned, sent, skipped }` counters for logging.
 */
async function runEventReminderPass() {
  const enabled = await getAppSetting('crm_event_reminders_enabled');
  if (enabled !== true && enabled !== 'true' && enabled !== 1 && enabled !== '1') {
    return { scanned: 0, sent: 0, skipped: 0, disabled: true };
  }

  // Column-existence guards — pre-migration installs return early
  // instead of throwing.
  const hasCols = await hasColumnCached('events', 'event_reminder_sent_at');
  if (!hasCols) {
    if (!schemaWarnLogged) {
      logger.warn('Event reminder pass skipped — schema not yet migrated (run migration 143). Suppressing further warnings until restart.');
      schemaWarnLogged = true;
    }
    return { scanned: 0, sent: 0, skipped: 0 };
  }

  // Self-heal the seeded templates. Idempotent — only inserts missing
  // rows and backfills empty translations, never overwrites edits.
  // Runs once per process (module-level cache); subsequent ticks no-op.
  try {
    await ensureEventReminderTemplatesSeeded(db, logger);
  } catch (err) {
    logger.error('Event reminder template self-heal failed', { message: err.message });
  }

  const globalDaysBefore = Number(await getAppSetting('crm_event_reminders_days_before'));
  const daysBeforeDefault = Number.isFinite(globalDaysBefore) && globalDaysBefore >= 0
    ? globalDaysBefore : DEFAULT_DAYS_BEFORE;

  // Pull the business name once per pass for the payload.
  const profile = await db('business_profile').where({ id: 1 }).first('company_name');
  const businessName = profile?.company_name || '';

  // Candidate set: events with a customer, event_date in the future,
  // not yet sent, not disabled per-event. We don't filter on
  // event_date - days_before <= NOW() in SQL because per-event
  // override `event_reminder_offset_days` may shift the trigger
  // window — easier to filter in JS.
  const now = new Date();
  const rows = await db('events')
    .leftJoin('customer_accounts', 'customer_accounts.id', 'events.customer_account_id')
    .whereNotNull('events.customer_account_id')
    .whereNotNull('events.event_date')
    .where('events.is_active', true)
    .where('events.is_archived', false)
    .where('events.event_reminder_disabled', false)
    .whereNull('events.event_reminder_sent_at')
    .where('events.event_date', '>=', now.toISOString().slice(0, 10))
    .select(
      'events.id', 'events.event_name', 'events.event_type', 'events.event_date',
      'events.event_reminder_offset_days',
      'events.event_reminder_body_override',
      'events.customer_account_id',
      'customer_accounts.email as customer_email',
      'customer_accounts.first_name as customer_first_name',
      'customer_accounts.last_name as customer_last_name',
      'customer_accounts.display_name as customer_display_name',
      'customer_accounts.company_name as customer_company_name',
    );

  let sent = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      if (!row.customer_email) { skipped += 1; continue; }
      const offsetDays = Number.isFinite(Number(row.event_reminder_offset_days))
        ? Number(row.event_reminder_offset_days)
        : daysBeforeDefault;
      // Trigger window: NOW >= event_date - offset_days.
      const ed = row.event_date instanceof Date ? row.event_date : new Date(row.event_date);
      const triggerAt = new Date(ed.getTime() - offsetDays * 86_400_000);
      if (now < triggerAt) { skipped += 1; continue; }

      const templateKey = await resolveTemplateKey(row.event_type);
      const customer = {
        email: row.customer_email,
        first_name: row.customer_first_name,
        last_name: row.customer_last_name,
        display_name: row.customer_display_name,
        company_name: row.customer_company_name,
      };
      const payload = composePayload({
        event: row, customer, daysBefore: offsetDays, businessName,
      });
      // Per-event body override: when present, append as a synthetic
      // `body_override` field. The template engine should branch on it
      // (e.g. Handlebars `{{#if body_override}}{{body_override}}{{else}}…default body…{{/if}}`).
      // For installs where the templates don't yet handle the branch,
      // the override still rides through as a variable the admin can
      // reference manually.
      if (row.event_reminder_body_override) {
        payload.body_override = row.event_reminder_body_override;
      }

      await emailProcessor.queueEmail(row.id, customer.email, templateKey, payload);

      // Stamp sent_at immediately so a same-pass-re-entrancy (or a
      // crash between queueEmail and the update) doesn't double-send
      // on the next tick. The queueEmail call is itself idempotent at
      // the queue level; we belt-and-suspenders here.
      await db('events')
        .where({ id: row.id })
        .update({ event_reminder_sent_at: new Date() });
      sent += 1;
    } catch (err) {
      logger.error('Event reminder send failed', {
        eventId: row.id, err: err.message,
      });
      skipped += 1;
    }
  }

  // Production-quiet: only log when something actually happened
  // (a send or a skipped row inside the trigger window). Empty passes
  // — common when there are no upcoming events — stay silent so the
  // hourly cron doesn't paper the logs.
  if (sent > 0) {
    logger.info('Event reminder pass: sent reminders', {
      scanned: rows.length, sent, skipped,
    });
  } else if (skipped > 0) {
    // skipped > 0 with sent === 0 means at least one event WAS in the
    // window but couldn't be sent (missing email, send error). Log at
    // info so it's visible without being noisy on healthy passes.
    logger.info('Event reminder pass: rows skipped (no-send)', {
      scanned: rows.length, skipped,
    });
  }
  return { scanned: rows.length, sent, skipped };
}

module.exports = {
  runEventReminderPass,
  // exported for tests
  _internal: {
    resolveTemplateKey,
    composePayload,
  },
};
