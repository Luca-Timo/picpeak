/**
 * Migration: force-disable the three feature flags whose UI cards are
 * locked behind `NOT_YET_AVAILABLE` (Settings → Features).
 *
 * **Why**
 *
 * F.3 (commit dfb3291) changed `DEFAULT_FLAGS` so `reminderEmails`,
 * `calendarBooking`, and `messaging` default to FALSE on fresh installs
 * — matching their locked-but-off visual state. But DEFAULT_FLAGS only
 * seeds rows that DON'T yet exist; existing installs still have
 * `value = 1` rows for `reminderEmails` (the historical default was
 * true) and any rows that were toggled before the UI lock landed.
 *
 * Admins can't turn these flags off through the Settings tab anymore
 * (the cards are disabled with a "coming soon" hint) — so an install
 * carrying a stale `value = 1` row shows a green "on" toggle that the
 * admin physically can't change. This migration drops those rows to
 * `value = 0` so the UI state matches reality.
 *
 * **Why safe**
 *
 * All three flags gate features that are NOT yet implemented:
 *   - reminderEmails — placeholder card (no backend job runs against it)
 *   - calendarBooking — placeholder card (no customer-facing booking flow)
 *   - messaging      — placeholder card (no message-thread routes)
 *
 * Forcing them to 0 has no functional impact — nothing currently reads
 * them as "true means do something". Once those features ship, the
 * matching feature PR will both unlock the UI card AND seed the row
 * back to true through its own migration.
 *
 * **Idempotent**
 *
 * UPDATE with a WHERE on value = 1 (or its dialect equivalent — SQLite
 * stores booleans as 0/1, Postgres uses true/false). Re-running the
 * migration after the rows are already 0 is a no-op.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;
  const lockedRoadmapFlags = ['reminderEmails', 'calendarBooking', 'messaging'];
  // We use a raw UPDATE so the WHERE matches both SQLite's 1 and
  // Postgres's true (knex's boolean type coerces both directions).
  // Targeting `value` columns whose stored shape may be int(1) /
  // bool(true) / string('1') — the OR chain covers all three.
  await knex('feature_flags')
    .whereIn('key', lockedRoadmapFlags)
    .andWhere(function () {
      this.where('value', 1).orWhere('value', true).orWhere('value', '1');
    })
    .update({ value: 0 });
};

exports.down = async function () {
  // No-op. We don't restore the rows to true because:
  //   (a) the original true was a UI-locked nonsense state
  //   (b) the matching feature PRs will flip them back when each ships
  //   (c) downgrading a deployment shouldn't resurface placeholder
  //       toggles the admin can't operate
};
