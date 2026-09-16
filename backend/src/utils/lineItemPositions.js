/**
 * Line-item display order, shared by the quote and invoice editors.
 *
 * `LineItemsTable` treats `position` as a stable row id and only reorders the
 * array, so the payload's array order is the order the user arranged: store
 * that order by renumbering `position` 1..n and rewriting every
 * `parent_position` through the same old -> new map, so a moved parent keeps
 * its sub-items.
 *
 * Renumbering happens only when the payload's own numbers are unambiguous.
 * Duplicate positions, or a `parent_position` naming a position the payload
 * doesn't contain, come back untouched so `validateLineItemHierarchy` still
 * rejects them instead of this helper attaching a sub-item to whichever row
 * ends up on that number.
 *
 * @param {Array<object>} items line items in display order
 * @returns {Array<object>} new items, `position` 1..n and `parent_position`
 *   remapped; unambiguous input only, and the input array is never mutated
 */
const { ensureInt } = require('./numericHelpers');

/** A row without a position takes the one its array order implies. */
const positionsOf = (items) => items.map((item, index) => (
  item.position == null || item.position === '' ? index + 1 : ensureInt(item.position)
));

const parentOf = (item) => (
  item.parent_position == null || item.parent_position === '' ? null : ensureInt(item.parent_position)
);

function renumberLineItemPositions(items) {
  if (!Array.isArray(items)) return items;

  // ensureInt everywhere, so the helper and validateLineItemHierarchy read
  // the same numbers out of a payload.
  const oldPositions = positionsOf(items);
  const unambiguous = new Set(oldPositions).size === oldPositions.length
    && items.every((item) => {
      const parent = parentOf(item);
      return parent == null || oldPositions.includes(parent);
    });
  if (!unambiguous) return items;

  const renumberedByOldPosition = new Map(oldPositions.map((old, index) => [old, index + 1]));
  return items.map((item, index) => ({
    ...item,
    position: index + 1,
    parent_position: renumberedByOldPosition.get(parentOf(item)) ?? null,
  }));
}

module.exports = { renumberLineItemPositions };
