/**
 * Customer dashboard routes
 *
 * Mounted at /api/customer (see server.js). Every endpoint here requires
 * a valid 'customer' JWT — see middleware/customerAuth.js.
 *
 * Endpoints:
 *   GET  /events                       list assigned events for dashboard
 *   GET  /events/:slug/access-token    mint a gallery JWT so the customer
 *                                      can browse the event without going
 *                                      through the per-event password gate
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { param, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const logger = require('../utils/logger');
const { getClientIp } = require('../utils/requestIp');
const { customerAuth } = require('../middleware/customerAuth');
const customerAccountsService = require('../services/customerAccountsService');

const router = express.Router();

const GALLERY_TOKEN_TTL_SECONDS = 24 * 60 * 60;

// ---- list assigned events ---------------------------------------------

router.get('/events', customerAuth, async (req, res) => {
  try {
    const events = await customerAccountsService.listEventsForCustomer(req.customer.id);
    res.json({
      events: events.map((e) => ({
        id: e.id,
        slug: e.slug,
        eventName: e.event_name,
        eventType: e.event_type,
        eventDate: e.event_date,
        expiresAt: e.expires_at,
        coverPhotoId: e.cover_photo_id,
        isActive: e.is_active,
        assignedAt: e.assigned_at,
      })),
    });
  } catch (error) {
    logger.error('Customer event list error:', error);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

// ---- access-token exchange --------------------------------------------

/**
 * Customer JWT → Gallery JWT exchange.
 *
 * The gallery API and frontend already expect a 'gallery' token in the
 * gallery_token / gallery_token_{slug} cookie. Rather than teach every
 * gallery code path about a third token type, we mint a fresh gallery
 * token here when the customer is assigned to the event. The frontend
 * stores it in the slug-specific cookie via the existing
 * storeGalleryToken() utility, and from that point on the gallery loads
 * exactly as if the per-event password had been entered.
 *
 * Returns 403 if the customer is not assigned, 404 if the event slug is
 * unknown, 410 if the event is archived/expired (so the dashboard can
 * surface a useful "this gallery has expired" message rather than just
 * an opaque 403).
 */
router.get('/events/:slug/access-token', [
  customerAuth,
  param('slug').isString().notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { slug } = req.params;
    const event = await db('events').where('slug', slug).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (event.is_archived) {
      return res.status(410).json({ error: 'This gallery has been archived' });
    }
    if (event.expires_at && new Date(event.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This gallery has expired' });
    }

    const hasAccess = await customerAccountsService.customerHasAccessToEvent(
      req.customer.id,
      event.id
    );
    if (!hasAccess) {
      logger.warn('Customer attempted to access unassigned event', {
        customerId: req.customer.id,
        eventId: event.id,
        slug,
      });
      return res.status(403).json({ error: 'You do not have access to this gallery' });
    }

    const ipAddress = getClientIp(req);
    // Same shape as /api/auth/gallery/verify — keep them in sync so the
    // gallery middleware (verifyGalleryAccess) doesn't need a code change.
    const token = jwt.sign({
      eventId: event.id,
      eventSlug: event.slug,
      type: 'gallery',
      ip: ipAddress,
      loginTime: Date.now(),
      // Optional bookkeeping claim — surfaces the originating customer in
      // logs when the token is later used. Doesn't affect authorization.
      via: 'customer',
      customerId: req.customer.id,
    }, process.env.JWT_SECRET, {
      expiresIn: GALLERY_TOKEN_TTL_SECONDS,
      issuer: 'picpeak-auth',
    });

    await db('access_logs').insert({
      event_id: event.id,
      ip_address: ipAddress,
      user_agent: req.headers['user-agent'] || '',
      action: 'login_success',
    });

    await logActivity('customer_event_access',
      { customerId: req.customer.id, eventId: event.id, slug },
      event.id,
      { type: 'customer', id: req.customer.id, name: req.customer.email }
    );

    res.json({
      token,
      event: {
        id: event.id,
        slug: event.slug,
        eventName: event.event_name,
      },
    });
  } catch (error) {
    logger.error('Customer access-token exchange error:', error);
    res.status(500).json({ error: 'Failed to issue access token' });
  }
});

module.exports = router;
