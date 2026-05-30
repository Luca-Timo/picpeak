/**
 * Boot-time self-heal for restore-meta settings.
 *
 * **Why this exists**
 *
 * `restore_allow_force` gates whether the Restore wizard accepts a
 * `force: true` payload. The flag exists to add admin friction
 * before letting a restore override safety warnings (e.g. "1 active
 * admin user — restoring would clobber the current install").
 *
 * In practice the friction lands at the worst possible moment: a
 * fresh install (no app_settings row yet OR `restore_allow_force =
 * false` by default) hits the wall on its very FIRST restore. The
 * admin is mid disaster-recovery, panicked, and gets:
 *
 *   "Force restore is not allowed by system settings"
 *
 * They then have to hand-craft SQL like
 *
 *   INSERT INTO app_settings (setting_key, setting_value, ...)
 *   VALUES ('restore_allow_force', 'true', 'restore', NOW())
 *   ON CONFLICT ... SET setting_value = 'true';
 *
 * before they can recover their data. This isn't security — the
 * admin who could run that SQL could also flip the setting via the
 * UI. It's just a sharp edge that bites every new install once.
 *
 * Cure: seed the default ON at boot via `INSERT ... ON CONFLICT
 * DO NOTHING`. New installs get force-allowed out of the box.
 * Existing installs that have explicitly set the row (true OR
 * false) are NOT overwritten — admin policy wins. Same pattern
 * `_backupPathsBoot.js` uses for the canonical backup_paths rows.
 *
 * **Default-ON rationale (matches Stage A's principle)**
 *
 * Stage A defaulted inline DB dumps to ON because the cost of
 * forgetting was data loss. By the same logic, `restore_allow_force`
 * defaults ON because the cost of forgetting is being unable to
 * recover from a disaster. Audit logging captures every forced
 * restore so the accountability story stays intact.
 *
 * If/when the broader "exclude restore-meta settings from being
 * overwritten by restore" follow-up lands (the second half of this
 * chicken-and-egg), this self-heal becomes the safety net for
 * fresh installs only — existing installs by that point have the
 * row preserved across restores.
 */

const SEEDS = [
  {
    setting_key: 'restore_allow_force',
    setting_value: 'true',
    setting_type: 'restore',
    rationale: 'Default ON so fresh installs can recover from disaster '
      + 'without a SQL incantation. Admins who want to require manual '
      + 'intervention can disable via the admin UI.',
  },
];

let booted = false;

/**
 * Seed the canonical restore-meta settings on fresh installs.
 *
 * @param {object} db      knex instance
 * @param {object} logger  app logger (must expose .info / .warn)
 * @returns {Promise<{ seeded: string[] }>}
 */
async function seedRestoreSettingsAtBoot(db, logger) {
  const log = logger || { info: () => {}, warn: () => {} };
  if (booted) return { seeded: [] };

  if (!(await db.schema.hasTable('app_settings'))) {
    log.warn('app_settings table missing at boot — restore-settings self-heal skipped');
    return { seeded: [] };
  }

  const seeded = [];
  for (const seed of SEEDS) {
    try {
      const existing = await db('app_settings')
        .where('setting_key', seed.setting_key)
        .first();
      if (existing) continue; // admin policy already in effect

      await db('app_settings').insert({
        setting_key: seed.setting_key,
        setting_value: seed.setting_value,
        setting_type: seed.setting_type,
        updated_at: new Date(),
      });
      seeded.push(seed.setting_key);
      log.info(`Seeded restore-meta setting ${seed.setting_key}=${seed.setting_value} (${seed.rationale.slice(0, 80)}...)`);
    } catch (err) {
      log.warn(`Failed to seed restore-meta setting ${seed.setting_key}: ${err.message}`);
    }
  }

  booted = true;
  return { seeded };
}

// Test-only: reset the module-level boot flag so jest can re-exercise
// the seeder against a fresh test DB inside a single worker.
function _resetBootForTests() {
  booted = false;
}

module.exports = { seedRestoreSettingsAtBoot, _resetBootForTests, SEEDS };
