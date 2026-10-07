/**
 * Review of team members' uploads (issue 743, migration 269).
 *
 * With `events.review_contributor_uploads` on, a photo uploaded by an admin
 * who reaches the event only through an assignment (a contributor, see
 * ownership.ownsEvent) is stored hidden with moderation_status 'pending'. The
 * owner approves it (visible, no longer under review) or rejects it (stays
 * hidden as 'rejected', can still be approved or deleted later). Visibility
 * routes leave photos under review alone; this is the only way out.
 */

const { db } = require('../database/db');
const { ownsEvent } = require('../middleware/ownership');
const { parseBooleanInput } = require('../utils/parsers');

const MODERATION_STATUSES = ['pending', 'rejected'];
const MAX_MODERATION_IDS = 500;

/** Whether an upload by `admin` to `event` waits for the owner's review. */
function holdsForReview(admin, event) {
  return parseBooleanInput(event?.review_contributor_uploads, false) && !ownsEvent(admin, event);
}

/**
 * The photo columns an admin upload is inserted with: which account ran it,
 * and, for a contributor under review, hidden + pending.
 */
function adminUploadColumns(admin, event) {
  return {
    uploaded_by_admin_id: admin.id,
    ...(holdsForReview(admin, event) ? { visibility: 'hidden', moderation_status: 'pending' } : {}),
  };
}

/**
 * Approve or reject photos of one event. Only rows under review move:
 * approving publishes them, rejecting keeps them hidden.
 *
 * @returns {Promise<number>} rows changed
 */
async function moderatePhotos(eventId, photoIds, action) {
  const rows = db('photos')
    .where('event_id', eventId)
    .whereIn('id', photoIds)
    .whereNotNull('moderation_status');
  if (action === 'approve') {
    return rows.update({ visibility: 'visible', moderation_status: null });
  }
  return rows.whereNot('moderation_status', 'rejected').update({ moderation_status: 'rejected' });
}

/** Photos of an event under review, by status, for the grid's banner. */
async function moderationCounts(eventId) {
  const rows = await db('photos')
    .where('event_id', eventId)
    .whereNotNull('moderation_status')
    .groupBy('moderation_status')
    .select('moderation_status')
    .count('id as count');
  const counts = { pending: 0, rejected: 0 };
  for (const row of rows) {
    if (MODERATION_STATUSES.includes(row.moderation_status)) counts[row.moderation_status] = Number(row.count) || 0;
  }
  return counts;
}

module.exports = {
  MODERATION_STATUSES,
  MAX_MODERATION_IDS,
  holdsForReview,
  adminUploadColumns,
  moderatePhotos,
  moderationCounts,
};
