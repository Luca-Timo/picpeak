/**
 * Two-stage delivery (issue 1562).
 *
 * An event is `complete` (today's behaviour) or `partial`: a first look is
 * out, the rest is coming by `delivery_due_at`. The guest gallery shows the
 * delivered photos, a banner and placeholder tiles while partial. Completing
 * is always a deliberate admin action — never "count reached" or "date
 * passed", either of which would announce an unfinished gallery.
 *
 * `photos.first_look` is stamped at ingest (the keyword folder of an upload or
 * external import) and stays after completion, so the customer can still find
 * the photos they already shared.
 */

const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');
const { parseBooleanInput } = require('../utils/parsers');
const { whereTimestamp, formatBoolean } = require('../utils/dbCompat');

const DEFAULT_DELIVERY_DAYS = 7;
const REMINDER_LEAD_HOURS = 24;
const MAX_PLACEHOLDER_TILES = 12;

const isPartial = (event) => event && event.delivery_status === 'partial';

/** Event date + N days (Settings → Event defaults), at noon UTC so the date never shifts by timezone. */
async function defaultDueAt(event, conn = db) {
  const days = Number(await getAppSetting('event_default_delivery_days', DEFAULT_DELIVERY_DAYS, conn)) || DEFAULT_DELIVERY_DAYS;
  // Postgres hands a DATE column back as a Date, SQLite as a string.
  const raw = event.event_date instanceof Date && !Number.isNaN(event.event_date.getTime())
    ? event.event_date.toISOString()
    : String(event.event_date || '');
  const base = raw.slice(0, 10);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(base) ? new Date(`${base}T12:00:00Z`) : new Date();
  return new Date(start.getTime() + days * 864e5);
}

/**
 * A first-look batch arrived (keyword folder). Switches the event to partial
 * unless it was already completed once — a late "FirstLook" upload must never
 * re-open a delivered gallery. Returns true when the state changed.
 *
 * Writes outside any transaction and logs after the update, so a SQLite
 * caller never deadlocks on the global activity write.
 */
/**
 * The columns that put an event into the partial state. One helper for both
 * ways in (a keyword folder, the settings PUT), so both start a fresh promise
 * the same way: reminder stamps cleared, and a default due date when none is
 * given and the stored one is missing or already past. ISO strings, not Dates:
 * node-sqlite3 can store a Date as "[object Object]".
 */
async function enterPartialColumns(event, { dueAtGiven = false } = {}) {
  const columns = {
    delivery_status: 'partial',
    delivery_completed_at: null,
    delivery_reminder_sent_at: null,
    delivery_overdue_notified_at: null,
  };
  if (dueAtGiven) return columns;
  const stored = event.delivery_due_at ? Date.parse(event.delivery_due_at) : NaN;
  if (!Number.isFinite(stored) || stored <= Date.now()) {
    columns.delivery_due_at = (await defaultDueAt(event)).toISOString();
    columns.delivery_due_source = 'default';
  }
  return columns;
}

async function markFirstLookArrived(eventId, { actor, source } = {}) {
  const event = await db('events').where('id', eventId).first();
  if (!event || event.delivery_completed_at || isPartial(event)) return false;
  const update = await enterPartialColumns(event);
  const changed = await db('events')
    .where('id', eventId)
    .whereNull('delivery_completed_at')
    .where('delivery_status', 'complete')
    .update(update);
  if (!changed) return false;
  await logActivity('delivery_first_look_started', { eventName: event.event_name, folder: source || null }, eventId, actor || { type: 'system' })
    .catch((err) => logger.warn('delivery: activity log failed', { error: err.message }));
  return true;
}

/** The delivery block of the guest payload, or null for a plain complete gallery. */
function guestDeliveryPayload(event, deliveredCount) {
  const hasState = isPartial(event) || !!event.delivery_completed_at;
  if (!hasState) return null;
  const expected = event.delivery_expected_count == null ? null : Number(event.delivery_expected_count);
  const outstanding = isPartial(event) && expected ? Math.max(0, expected - deliveredCount) : 0;
  return {
    status: isPartial(event) ? 'partial' : 'complete',
    expected_count: expected,
    delivered_count: deliveredCount,
    placeholder_count: Math.min(outstanding, MAX_PLACEHOLDER_TILES),
    due_at: isPartial(event) ? event.delivery_due_at || null : null,
    badge_label: event.delivery_badge_label || null,
  };
}

/**
 * First-look photos that arrived again in the full set: same original
 * filename (case-insensitive), one flagged first_look and one not. Returns
 * [{ first_look_id, full_id }].
 */
async function findFirstLookDuplicates(eventId, conn = db) {
  const rows = await conn('photos')
    .where('event_id', eventId)
    .select('id', 'first_look', 'original_filename', 'source_filename', 'filename');
  const nameOf = (r) => String(r.source_filename || r.original_filename || r.filename || '').toLowerCase();
  const full = new Map();
  rows.filter((r) => !parseBooleanInput(r.first_look, false)).forEach((r) => {
    const n = nameOf(r);
    if (n && !full.has(n)) full.set(n, r.id);
  });
  return rows
    .filter((r) => parseBooleanInput(r.first_look, false) && full.has(nameOf(r)))
    .map((r) => ({ first_look_id: Number(r.id), full_id: Number(full.get(nameOf(r))) }));
}

/**
 * Mark the full gallery as ready. Clears the partial state, moves the badge
 * from first-look duplicates onto their full-set copies (the caller deletes
 * the duplicates through the regular photo delete), and returns what the
 * route needs to notify. Idempotent: a second call on a complete event is a
 * no-op that reports `already: true`.
 */
async function completeDelivery(eventId, { transferBadges = true } = {}) {
  const event = await db('events').where('id', eventId).first();
  if (!event) return null;
  if (!isPartial(event)) return { already: true, event, duplicates: [] };

  const duplicates = await findFirstLookDuplicates(eventId);
  const now = new Date().toISOString();
  // The partial → complete transition is claimed in the UPDATE itself: two
  // clicks (or two admins) racing past the read above must not both mail the
  // customer and fire gallery.completed.
  const claimed = await db.transaction(async (trx) => {
    const changed = await trx('events')
      .where({ id: eventId, delivery_status: 'partial' })
      .update({ delivery_status: 'complete', delivery_completed_at: now });
    if (changed && transferBadges && duplicates.length) {
      await trx('photos').whereIn('id', duplicates.map((d) => d.full_id)).update({ first_look: formatBoolean(true) });
    }
    return changed > 0;
  });
  if (!claimed) return { already: true, event, duplicates: [] };
  return { already: false, event: { ...event, delivery_status: 'complete', delivery_completed_at: now }, duplicates };
}

/**
 * Hourly pass: one reminder per event when the promise is within
 * REMINDER_LEAD_HOURS, one more once it is overdue. Internal mail to the
 * studio (business profile email, else the event's admin_email).
 */
async function runDeliveryReminderPass({ now = new Date() } = {}) {
  const { queueEmail } = require('./emailProcessor');
  const soon = new Date(now.getTime() + REMINDER_LEAD_HOURS * 3600e3);
  const events = await db('events')
    .where('delivery_status', 'partial')
    .whereNotNull('delivery_due_at')
    // whereTimestamp: the column holds ISO strings, and a Date bind compares
    // as epoch milliseconds on SQLite (issue 1733's expiry bug).
    .modify(whereTimestamp, 'delivery_due_at', '<=', soon)
    .where((q) => q.whereNull('is_archived').orWhere('is_archived', formatBoolean(false)))
    .select('*');
  let sent = 0;
  for (const event of events) {
    const overdue = new Date(event.delivery_due_at) <= now;
    const column = overdue ? 'delivery_overdue_notified_at' : 'delivery_reminder_sent_at';
    if (event[column]) continue;
    const claimed = await db('events').where('id', event.id).whereNull(column).update({ [column]: now.toISOString() });
    if (!claimed) continue;
    try {
      const profile = await db.schema.hasTable('business_profile')
        ? await db('business_profile').first('email')
        : null;
      const to = (profile && profile.email) || event.admin_email;
      const delivered = Number((await db('photos').where('event_id', event.id).count('id as c').first()).c) || 0;
      const { getAbsoluteFrontendUrl } = require('../utils/frontendUrl');
      const base = await getAbsoluteFrontendUrl(null, { override: process.env.ADMIN_URL });
      if (!to) {
        // Nobody to tell: no mail and no "reminded" entry in the activity log.
        logger.warn('delivery reminder skipped: no business profile or admin email', { eventId: event.id });
        continue;
      }
      await queueEmail(event.id, to, 'delivery_due_reminder', {
        event_name: event.event_name,
        due_date: event.delivery_due_at,
        delivered_count: delivered,
        expected_count: event.delivery_expected_count || '?',
        admin_link: `${base}/admin/events/${event.id}`,
        overdue: overdue ? 'yes' : '',
        due_soon: overdue ? '' : 'yes',
      });
      await logActivity(overdue ? 'delivery_overdue' : 'delivery_due_soon',
        { eventName: event.event_name, dueAt: event.delivery_due_at }, event.id, { type: 'system' });
      sent += 1;
    } catch (err) {
      // Release the claim so the next hourly pass tries again.
      await db('events').where('id', event.id).update({ [column]: null }).catch(() => {});
      logger.warn('delivery reminder failed', { eventId: event.id, error: err.message });
    }
  }
  return { sent };
}

module.exports = {
  DEFAULT_DELIVERY_DAYS,
  MAX_PLACEHOLDER_TILES,
  isPartial,
  defaultDueAt,
  enterPartialColumns,
  markFirstLookArrived,
  guestDeliveryPayload,
  findFirstLookDuplicates,
  completeDelivery,
  runDeliveryReminderPass,
};
