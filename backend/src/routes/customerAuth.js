/**
 * Customer-side auth routes
 *
 * Mounted at /api/customer/auth (see server.js wiring). Strictly separate
 * from /api/auth/* (admin) and /api/auth/gallery/* (per-event guests).
 *
 * Endpoints:
 *   POST   /login          email + password → customer_token cookie
 *   POST   /logout         revoke + clear cookie
 *   GET    /session        echo current customer for frontend boot
 *   GET    /invite/:token  public, returns invite metadata
 *   POST   /accept-invite  public, completes the invitation
 */

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, param, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { verifyRecaptcha } = require('../services/recaptcha');
const {
  trackFailedAttempt,
  trackSuccessfulLogin,
  checkAccountLockout,
  getGenericAuthError,
} = require('../utils/authSecurity');
const { revokeToken } = require('../utils/tokenRevocation');
const logger = require('../utils/logger');
const {
  setCustomerAuthCookie,
  clearCustomerAuthCookie,
  getCustomerTokenFromRequest,
} = require('../utils/tokenUtils');
const { getClientIp } = require('../utils/requestIp');
const { validatePasswordInContext } = require('../utils/passwordValidation');
const customerAccountsService = require('../services/customerAccountsService');
const { customerAuth } = require('../middleware/customerAuth');

const router = express.Router();

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // mirrors admin tokens

// ---- login -------------------------------------------------------------

router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isString().notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, recaptchaToken } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    // Lockout key includes a `customer:` prefix so admin and customer
    // attempt counters don't share a bucket — an attacker hitting an
    // admin login with the same email should not lock out the customer
    // account or vice versa.
    const lockoutKey = `customer:${email}`;
    const lockoutStatus = await checkAccountLockout(lockoutKey);
    if (lockoutStatus.isLocked) {
      logger.warn('Customer login attempt on locked account', { email, ipAddress });
      return res.status(423).json({
        error: 'Account temporarily locked due to too many failed attempts',
        retryAfter: lockoutStatus.remainingTime,
      });
    }

    const recaptchaValid = await verifyRecaptcha(recaptchaToken);
    if (!recaptchaValid) {
      await trackFailedAttempt(lockoutKey, ipAddress, userAgent);
      return res.status(400).json({ error: 'reCAPTCHA verification failed' });
    }

    const customer = await db('customer_accounts').where('email', email).first();
    // Generic error to prevent user enumeration — same wording as admin login.
    if (!customer || !customer.password_hash || !await bcrypt.compare(password, customer.password_hash)) {
      await trackFailedAttempt(lockoutKey, ipAddress, userAgent);
      return res.status(401).json({ error: getGenericAuthError() });
    }
    if (!customer.is_active) {
      await trackFailedAttempt(lockoutKey, ipAddress, userAgent);
      return res.status(401).json({ error: getGenericAuthError() });
    }

    await trackSuccessfulLogin(lockoutKey, ipAddress, userAgent);
    await db('customer_accounts').where('id', customer.id).update({
      last_login: new Date(),
      last_login_ip: ipAddress,
    });

    const token = jwt.sign({
      customerId: customer.id,
      email: customer.email,
      type: 'customer',
      ip: ipAddress,
      loginTime: Date.now(),
    }, process.env.JWT_SECRET, {
      expiresIn: TOKEN_TTL_SECONDS,
      issuer: 'picpeak-auth',
    });

    setCustomerAuthCookie(res, token);

    await logActivity('customer_login',
      { customerId: customer.id, email: customer.email, ipAddress },
      null,
      { type: 'customer', id: customer.id, name: customer.email }
    );

    res.json({
      customer: {
        id: customer.id,
        email: customer.email,
        displayName: customer.display_name,
        firstName: customer.first_name,
        lastName: customer.last_name,
        preferredLanguage: customer.preferred_language || 'en',
      },
    });
  } catch (error) {
    logger.error('Customer login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ---- logout ------------------------------------------------------------

router.post('/logout', async (req, res) => {
  try {
    const token = getCustomerTokenFromRequest(req);
    if (token) {
      await revokeToken(token, 'user_logout');
    }
    clearCustomerAuthCookie(res);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Customer logout error:', error);
    // Always clear the cookie even if revocation failed — the client must
    // not stay locked into a half-broken session.
    clearCustomerAuthCookie(res);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ---- session echo ------------------------------------------------------

router.get('/session', customerAuth, async (req, res) => {
  res.json({ customer: req.customer });
});

// ---- invitation lifecycle (public) -------------------------------------

router.get('/invite/:token', [
  param('token').isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(404).json({ error: 'Invalid invitation link' });
    }
    const invitation = await customerAccountsService.validateInvitationToken(req.params.token);
    if (!invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }
    res.json({
      invitation: {
        email: invitation.email,
        expiresAt: invitation.expires_at,
        invitedBy: invitation.invited_by_username,
      },
    });
  } catch (error) {
    logger.error('Customer invite lookup error:', error);
    res.status(500).json({ error: 'Failed to load invitation' });
  }
});

router.post('/accept-invite', [
  body('token').isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i),
  body('name').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
  body('password').isString().isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { token, name, password } = req.body;

    // Run the password through the same complexity policy admins are held
    // to. The validator returns { ok, errors[] } so we surface specific
    // failures rather than a generic "weak password".
    const validation = await validatePasswordInContext(password, { username: name || '', email: '' });
    if (!validation.ok) {
      return res.status(400).json({ error: 'Password does not meet complexity requirements', details: validation.errors });
    }

    const result = await customerAccountsService.acceptInvitation({ token, name, password });
    res.json({ message: 'Invitation accepted', email: result.email });
  } catch (error) {
    if (error.code === 'CONFLICT' || error.statusCode === 409) {
      return res.status(409).json({ error: error.message });
    }
    if (error.code === 'VALIDATION' || error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('Customer invite accept error:', error);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

module.exports = router;
