/**
 * requireFeatureFlag(key, code?) — 403 when the named `feature_flags` row is off.
 *
 * Belt-and-braces gate for admin routes whose feature can be toggled in
 * Settings → Features. The frontend hides disabled surfaces, but a direct API
 * hit must still be refused so a disabled feature is never actable. Mirrors the
 * truthy logic feature_flags uses everywhere (true | 1 | '1').
 *
 * Several route files (adminLedger, adminExpenses) predate this and define an
 * identical local `requireFlag`; new gates should import this instead.
 */
const { db } = require('../database/db');

function requireFeatureFlag(key, code) {
  return async (req, res, next) => {
    try {
      const row = await db('feature_flags').where({ key }).first();
      const enabled = row && (row.value === true || row.value === 1 || row.value === '1');
      if (!enabled) {
        return res.status(403).json({
          error: `${key} feature is disabled`,
          code: code || `${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_DISABLED`,
        });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireFeatureFlag };
