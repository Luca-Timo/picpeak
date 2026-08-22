/**
 * The photographer's own stars and colour labels (#1044 follow-up).
 *
 * Deliberately separate from photo_feedback — see the migration-181 header for
 * why. Nothing in here is ever read by a guest-facing route: admin marks show
 * on admin surfaces and in exports, and the client's proofing view never sees
 * what the photographer thought.
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { isValidColorLabel } = require('../constants/colorLabels');

/**
 * Set, change or clear an admin's mark on one photo.
 *
 * `rating` and `colorLabel` are tri-state: `undefined` leaves that half of the
 * mark alone, `null` clears it, a value sets it. That is what lets the
 * lightbox's colour keys and star keys write independently without each
 * wiping the other.
 *
 * @param {number} eventId
 * @param {number} photoId
 * @param {number} adminId
 * @param {{rating?: number|null, colorLabel?: string|null}} mark
 * @returns {Promise<{rating: number|null, color_label: string|null}|null>}
 *          the resulting mark, or null when it was cleared entirely
 */
async function setMark(eventId, photoId, adminId, { rating, colorLabel } = {}) {
  if (rating !== undefined && rating !== null) {
    const asInt = Number(rating);
    if (!Number.isInteger(asInt) || asInt < 1 || asInt > 5) {
      throw new Error('Rating must be between 1 and 5');
    }
  }
  if (colorLabel !== undefined && colorLabel !== null && !isValidColorLabel(colorLabel)) {
    throw new Error('Invalid color label');
  }

  const existing = await db('photo_admin_marks')
    .where({ photo_id: photoId, admin_id: adminId })
    .first();

  const next = {
    rating: rating === undefined ? (existing?.rating ?? null) : (rating === null ? null : Number(rating)),
    color_label: colorLabel === undefined ? (existing?.color_label ?? null) : colorLabel,
  };

  // A mark with neither half left is deleted, not kept as an empty row — an
  // empty row would still count as "marked" to anything that tests existence.
  if (next.rating === null && next.color_label === null) {
    if (existing) {
      await db('photo_admin_marks').where('id', existing.id).delete();
    }
    return null;
  }

  const now = new Date().toISOString();
  if (existing) {
    await db('photo_admin_marks')
      .where('id', existing.id)
      .update({ ...next, updated_at: now });
  } else {
    await db('photo_admin_marks').insert({
      photo_id: photoId,
      event_id: eventId,
      admin_id: adminId,
      ...next,
      created_at: now,
      updated_at: now,
    });
  }

  return next;
}

/**
 * One admin's marks across an event, keyed by photo id. Optionally narrowed to
 * the ids on the current page.
 *
 * @returns {Promise<Object>} { [photoId]: { rating, color_label } }
 */
async function getEventMarks(eventId, adminId, photoIds = null) {
  try {
    const query = db('photo_admin_marks')
      .where({ event_id: eventId, admin_id: adminId })
      .select('photo_id', 'rating', 'color_label');

    if (Array.isArray(photoIds)) {
      if (photoIds.length === 0) return {};
      query.whereIn('photo_id', photoIds);
    }

    const rows = await query;
    const byPhoto = {};
    for (const row of rows) {
      byPhoto[row.photo_id] = {
        rating: row.rating ?? null,
        color_label: row.color_label ?? null,
      };
    }
    return byPhoto;
  } catch (error) {
    logger.error('Error reading admin photo marks:', error);
    return {};
  }
}

/**
 * Per-colour photo counts for one admin's marks — drives the counts on the
 * "My marks" filter chips.
 */
async function getEventMarkColorCounts(eventId, adminId) {
  try {
    const rows = await db('photo_admin_marks')
      .where({ event_id: eventId, admin_id: adminId })
      .whereNotNull('color_label')
      .groupBy('color_label')
      .select('color_label')
      .count('id as count');

    const counts = {};
    for (const row of rows) {
      counts[row.color_label] = parseInt(row.count, 10) || 0;
    }
    return counts;
  } catch (error) {
    logger.error('Error counting admin photo marks:', error);
    return {};
  }
}

module.exports = { setMark, getEventMarks, getEventMarkColorCounts };
