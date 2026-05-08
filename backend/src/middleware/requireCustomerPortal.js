/**
 * Gate middleware for the customer-portal feature (#354 follow-up).
 *
 * When `customer_portal_enabled` is OFF in Settings → Advanced features,
 * every customer-side surface should refuse early with a clear status:
 *
 *   - 410 Gone for endpoints that operate on existing customer state
 *     (login, accept-invite, reset-password). Communicates "this used
 *     to work but the admin disabled it" better than a generic 403.
 *   - 403 Forbidden for admin-side endpoints that create new customer
 *     state (POST /invite, customer-account picker autocomplete, etc.).
 *
 * Mounted as `app.use('/api/customer', requireCustomerPortalEnabled, ...)`
 * for the customer surface, and pasted in front of the relevant admin
 * routes individually since /api/admin/customers is mounted alongside
 * other admin endpoints.
 */

const { isCustomerPortalEnabled } = require('../services/customerAccountsService');
const logger = require('../utils/logger');

function buildGate({ status = 410, code = 'CUSTOMER_PORTAL_DISABLED', message = 'Customer portal is disabled' } = {}) {
  return async function gate(req, res, next) {
    try {
      const enabled = await isCustomerPortalEnabled();
      if (!enabled) {
        // Don't log every probe — debug-level. The customer-side gate
        // fires on every unauthenticated session check.
        logger.debug('[customerPortal] gate refused', { url: req.originalUrl, status });
        return res.status(status).json({ error: message, code });
      }
      return next();
    } catch (err) {
      // If the gate itself errors, fail closed — better to deny a
      // legitimate request than to leak the customer surface during
      // a settings table outage.
      logger.error('[customerPortal] gate error, failing closed', { error: err?.message });
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  };
}

/**
 * 410 Gone variant for customer-facing routes — the customer's account
 * exists but the admin has disabled the surface.
 */
const requireCustomerPortalEnabled = buildGate({
  status: 410,
  code: 'CUSTOMER_PORTAL_DISABLED',
  message: 'Customer portal is currently disabled. Contact your photographer for support.',
});

/**
 * 403 Forbidden variant for admin-side routes that *create* customer
 * state. Mounting these doesn't make sense when the surface is off.
 */
const requireCustomerPortalEnabledAdmin = buildGate({
  status: 403,
  code: 'CUSTOMER_PORTAL_DISABLED',
  message: 'Customer portal is disabled in Settings → Advanced features. Enable it before managing customers.',
});

module.exports = {
  requireCustomerPortalEnabled,
  requireCustomerPortalEnabledAdmin,
};
