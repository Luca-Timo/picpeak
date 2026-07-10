/**
 * Category order resolution (#782).
 *
 * Resolves an event's categories into their effective display order, layering:
 *   1. per-event override — event_category_order.position, when the event has
 *      been customised;
 *   2. the global default — photo_categories.display_order (migration 158);
 *   3. name.
 *
 * Globals and event-specific categories are ordered together so a custom order
 * can interleave them into the flow of the day. Shared by the admin event view
 * and the public gallery so the two never diverge.
 */
const { db } = require('../database/db');
const { formatBoolean } = require('./dbCompat');
const { hasColumnCached } = require('./schemaCache');

/**
 * @param {number|string} eventId
 * @param {object} [opts]
 * @param {number[]|null} [opts.onlyIds] restrict to these category ids (the
 *   public gallery only shows categories that actually have photos).
 * @param {string[]|null} [opts.select] qualified columns to select (default
 *   `c.*`). Always aliased to the `photo_categories as c` table.
 * @returns rows with an added `override_position` (null when not customised).
 */
async function getEventCategoriesOrdered(eventId, { onlyIds = null, select = null } = {}) {
  const eid = parseInt(eventId, 10);

  const base = db('photo_categories as c').where(function () {
    this.where('c.is_global', formatBoolean(true)).orWhere('c.event_id', eid);
  });
  if (onlyIds) base.whereIn('c.id', onlyIds);

  // Fail safe: if the override table isn't present yet (half-applied migration),
  // fall back to the global-default order so the public gallery never 500s.
  const overrideReady = await hasColumnCached('event_category_order', 'position');
  if (!overrideReady) {
    return base
      .select(select || 'c.*')
      .orderBy('c.is_global', 'desc')
      .orderBy('c.display_order', 'asc')
      .orderBy('c.name', 'asc');
  }

  const cols = select ? [...select] : ['c.*'];
  cols.push('o.position as override_position');

  return base
    .leftJoin('event_category_order as o', function () {
      this.on('o.category_id', 'c.id').andOnVal('o.event_id', '=', eid);
    })
    .select(cols)
    // Overridden categories first (in their pinned order), then the rest by the
    // global default. CASE keeps NULL-ordering portable across SQLite + Postgres.
    .orderByRaw('CASE WHEN o.position IS NULL THEN 1 ELSE 0 END ASC')
    .orderBy('o.position', 'asc')
    .orderBy('c.is_global', 'desc')
    .orderBy('c.display_order', 'asc')
    .orderBy('c.name', 'asc');
}

module.exports = { getEventCategoriesOrdered };
