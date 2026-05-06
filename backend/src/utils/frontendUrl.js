const { db } = require('../database/db');

/**
 * Resolve the public-facing frontend base URL used in outbound emails
 * (invitations, password resets, etc.).
 *
 * Precedence (most specific first):
 *   1. Settings → General → Site URL (`general_site_url` in app_settings)
 *      — this is what the admin actually configured for their deployment.
 *   2. `FRONTEND_URL` environment variable — historical bootstrap default,
 *      typically baked to `http://localhost:3000` in the dev container.
 *   3. `null` (caller decides the fallback, usually the historical
 *      `'http://localhost:3000'` literal).
 *
 * Earlier the env var won unconditionally, which meant invite/reset links
 * went out as `http://localhost:3000/...` even on properly-configured
 * deployments. The DB setting is the source of truth for production
 * URLs; the env var stays as a fallback for installs where the admin
 * never opened Settings.
 */
const getFrontendBaseUrl = async () => {
  // Prefer the admin-configured Site URL.
  try {
    const setting = await db('app_settings')
      .where('setting_key', 'general_site_url')
      .select('setting_value')
      .first();

    if (setting && setting.setting_value) {
      let val = setting.setting_value;
      if (typeof val === 'string') {
        try { val = JSON.parse(val); } catch (_) {}
      }
      if (typeof val === 'string' && val.trim()) {
        return val.trim().replace(/\/$/, '');
      }
    }
  } catch (_) {
    // DB lookup failed (early bootstrap, table missing, etc.) — fall
    // through to env var instead of failing the email send.
  }

  // Env-var fallback for installs where Site URL hasn't been set yet.
  const envBase = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  return envBase || '';
};

module.exports = { getFrontendBaseUrl };
