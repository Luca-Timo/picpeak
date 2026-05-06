/**
 * Customer Authentication Middleware
 *
 * Verifies a 'customer' JWT issued by /api/customer/auth/login. Mirrors
 * adminAuth (same revocation, IP-log, password-change invalidation flow)
 * but operates on customer_accounts rather than admin_users — so an
 * admin token cannot pass as a customer and vice versa.
 *
 * Sets `req.customer = { id, email, displayName, isActive }` on success.
 */

const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { isTokenRevoked } = require('../utils/tokenRevocation');
const logger = require('../utils/logger');
const { getCustomerTokenFromRequest } = require('../utils/tokenUtils');

async function customerAuth(req, res, next) {
  try {
    const token = getCustomerTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    let decoded;
    try {
      const verified = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: 'picpeak-auth',
        complete: true,
      });
      decoded = verified.payload;
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (await isTokenRevoked(decoded)) {
      logger.warn('Revoked customer token used', {
        customerId: decoded.customerId,
        tokenType: decoded.type,
      });
      return res.status(401).json({ error: 'Token has been revoked', code: 'TOKEN_REVOKED' });
    }

    if (decoded.type !== 'customer') {
      logger.warn('Non-customer token used for customer endpoint', {
        tokenType: decoded.type,
      });
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // IP drift gets logged but doesn't reject — same lenient policy as
    // adminAuth. Customers may roam between mobile networks frequently.
    const currentIp = req.ip || req.connection.remoteAddress;
    if (decoded.ip && decoded.ip !== currentIp) {
      logger.info('Customer token used from different IP', {
        customerId: decoded.customerId,
        tokenIp: decoded.ip,
        currentIp,
      });
    }

    const customer = await db('customer_accounts')
      .where({ id: decoded.customerId, is_active: formatBoolean(true) })
      .select('id', 'email', 'display_name', 'first_name', 'last_name', 'password_changed_at', 'preferred_language')
      .first();

    if (!customer) {
      // Either deleted, deactivated, or the id was forged. 401 across the
      // board so the frontend session-expiry handler kicks in.
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (customer.password_changed_at) {
      const passwordChangedSeconds = Math.floor(
        new Date(customer.password_changed_at).getTime() / 1000
      );
      if (decoded.iat < passwordChangedSeconds) {
        logger.warn('Customer token used after password change', { customerId: decoded.customerId });
        return res.status(401).json({
          error: 'Token invalid due to password change',
          code: 'PASSWORD_CHANGED',
        });
      }
    }

    req.customer = {
      id: customer.id,
      email: customer.email,
      displayName: customer.display_name,
      firstName: customer.first_name,
      lastName: customer.last_name,
      preferredLanguage: customer.preferred_language || 'en',
    };
    req.token = token;
    next();
  } catch (error) {
    logger.error('Customer auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

module.exports = { customerAuth };
