/**
 * Customer Accounts Service
 *
 * Recurring user logins (the third user tier alongside admin and guest).
 * See discussion the-luap/picpeak#354 and migration 087 for context.
 *
 * Mirrors userManagementService.js for invitation lifecycle but operates
 * on customer_accounts / customer_invitations / event_customer_assignments
 * — separate token type ('customer'), simpler permission model (a customer
 * either has access to a given event or doesn't, no RBAC).
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { getBcryptRounds } = require('../utils/passwordValidation');
const { queueEmail } = require('./emailProcessor');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const logger = require('../utils/logger');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches admin invites

/**
 * Whitelist of customer profile fields the admin is allowed to pre-fill on
 * an invitation (and that the customer can then edit on accept). Centralised
 * so both invite-create and accept paths agree on what survives the round
 * trip.
 */
const PREFILLABLE_FIELDS = [
  'salutation',
  'first_name',
  'last_name',
  'display_name',
  'phone',
  'company_name',
  'vat_id',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'state',
  'country_code',
];

/**
 * Sanitise a free-form prefill payload coming from the admin UI. Trims
 * whitespace, drops anything not in the whitelist, uppercases ISO country
 * codes, and returns null if the result is effectively empty so we don't
 * litter the DB with `{}` rows.
 */
function sanitisePrefill(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const field of PREFILLABLE_FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    if (field === 'country_code') {
      out[field] = trimmed.toUpperCase().slice(0, 2);
    } else {
      out[field] = trimmed;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Decode the prefill_data column. Postgres returns it pre-parsed; SQLite /
 * older drivers may hand back a JSON string. Tolerate both, fail soft.
 */
function decodePrefill(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Create a new customer invitation.
 *
 * Idempotency: rejects if an active customer with this email already
 * exists, OR if a non-expired pending invitation is already in flight.
 * The latter is intentional — re-sending an invite while one is open
 * would mint two valid tokens, doubling the attack surface. Admins must
 * cancel the open invitation first if they want to re-send.
 *
 * @returns {Promise<{ id, email, token, expiresAt }>}
 */
async function createInvitation({ email, invitedById, prefill }) {
  const normalisedEmail = String(email || '').trim().toLowerCase();
  if (!normalisedEmail) {
    throw new ValidationError('Email is required');
  }

  const existingCustomer = await db('customer_accounts')
    .where('email', normalisedEmail)
    .first();
  if (existingCustomer) {
    throw new ConflictError('A customer account with this email already exists', 'email');
  }

  const pendingInvite = await db('customer_invitations')
    .where('email', normalisedEmail)
    .whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .first();
  if (pendingInvite) {
    throw new ConflictError('A pending invitation already exists for this email', 'email');
  }

  // 64-char hex = 32 bytes = 256 bits of entropy. Same as admin invites.
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const sanitisedPrefill = sanitisePrefill(prefill);

  const [insertedId] = await db('customer_invitations').insert({
    email: normalisedEmail,
    token,
    invited_by: invitedById,
    expires_at: expiresAt,
    created_at: new Date(),
    // Stringify so SQLite (TEXT-typed json column) and Postgres (JSONB)
    // both store the same shape. Skip the column entirely on null so
    // databases predating migration 088 don't reject the insert.
    ...(sanitisedPrefill ? { prefill_data: JSON.stringify(sanitisedPrefill) } : {}),
  }).returning('id');
  const id = insertedId?.id || insertedId;

  // Queue invitation email. The customer-facing accept page lives at
  // /customer/invite/:token (see CustomerAcceptInvitePage.tsx).
  //
  // Resolve the frontend base URL through the shared helper so the link
  // honours Site Settings → Site URL (general_site_url) rather than the
  // local FRONTEND_URL env var. The helper still falls back to
  // FRONTEND_URL → 'http://localhost:3000' if the setting isn't set, but
  // a configured deployment will always use its real domain. (Admin
  // invites in userManagementService use the env-only fallback — that's
  // a separate bug to be fixed alongside this PR or after.)
  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  await queueEmail(null, normalisedEmail, 'customer_invitation', {
    invite_link: `${frontendUrl}/customer/invite/${token}`,
    expires_at: expiresAt.toISOString(),
  });

  await logActivity('customer_invitation_created',
    { email: normalisedEmail },
    null,
    { type: 'admin', id: invitedById, name: 'system' }
  );

  logger.info('Customer invitation created', { email: normalisedEmail, invitedById });
  return { id, email: normalisedEmail, token, expiresAt };
}

/**
 * Accept an invitation. Creates the customer_accounts row in a transaction
 * and marks the invitation accepted, so a partial failure can't leave a
 * dangling account or a re-usable token.
 */
async function acceptInvitation({ token, name, password, profile }) {
  const invitation = await db('customer_invitations')
    .where('token', token)
    .whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .first();

  if (!invitation) {
    throw new ValidationError('Invalid or expired invitation');
  }

  // Race-condition guard: an admin may have created the customer manually
  // (future flow) between the invite link being generated and clicked.
  const existing = await db('customer_accounts')
    .where('email', invitation.email)
    .first();
  if (existing) {
    throw new ConflictError('Email already registered', 'email');
  }

  const passwordHash = await bcrypt.hash(password, getBcryptRounds());

  // Merge the admin's prefill with whatever the customer typed on the accept
  // form. Customer-supplied values win on every key — the accept page shows
  // the prefill values pre-populated but the customer is allowed to correct
  // anything (e.g. an admin's typo in the company name).
  const adminPrefill = decodePrefill(invitation.prefill_data) || {};
  const customerProfile = sanitisePrefill(profile) || {};
  const merged = { ...adminPrefill, ...customerProfile };
  // The legacy single-name field still wins over a separately-typed
  // display_name only if the merged record didn't carry one. Keeps backwards
  // compatibility with clients that haven't been updated to send the
  // structured profile.
  if (name && !merged.display_name) {
    merged.display_name = String(name).trim();
  }

  const customerId = await db.transaction(async (trx) => {
    const [inserted] = await trx('customer_accounts').insert({
      email: invitation.email,
      // Profile fields land directly on the customer row. Anything the user
      // didn't set stays null.
      salutation: merged.salutation || null,
      first_name: merged.first_name || null,
      last_name: merged.last_name || null,
      display_name: merged.display_name || null,
      phone: merged.phone || null,
      company_name: merged.company_name || null,
      vat_id: merged.vat_id || null,
      address_line1: merged.address_line1 || null,
      address_line2: merged.address_line2 || null,
      postal_code: merged.postal_code || null,
      city: merged.city || null,
      state: merged.state || null,
      country_code: merged.country_code || null,
      password_hash: passwordHash,
      is_active: formatBoolean(true),
      must_change_password: formatBoolean(false),
      // Leave password_changed_at NULL on initial accept. Setting it here
      // creates a millisecond/second-rounding race with the JWT issued
      // by the immediate /login call: stored timestamp X.500ms can floor
      // to X+1 in postgres while the JWT's iat lands at X, causing the
      // customerAuth middleware's `iat < password_changed_at` check to
      // reject perfectly valid tokens on the very next page reload. We
      // populate password_changed_at only when an actual password change
      // happens later (deactivate / reset flows).
      password_changed_at: null,
      created_by_admin_id: invitation.invited_by,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    const id = inserted?.id || inserted;

    await trx('customer_invitations')
      .where('id', invitation.id)
      .update({ accepted_at: new Date(), accepted_customer_id: id });

    return id;
  });

  await logActivity('customer_invitation_accepted',
    { customerId, email: invitation.email, invitationId: invitation.id },
    null,
    { type: 'system', id: null, name: 'system' }
  );

  logger.info('Customer invitation accepted', { customerId, email: invitation.email });
  return { customerId, email: invitation.email };
}

/**
 * Look up an invitation token without consuming it. Used by the accept
 * page so it can render the email + expiry before the user submits.
 */
async function validateInvitationToken(token) {
  const invitation = await db('customer_invitations')
    .leftJoin('admin_users', 'admin_users.id', 'customer_invitations.invited_by')
    .where('customer_invitations.token', token)
    .whereNull('customer_invitations.accepted_at')
    .where('customer_invitations.expires_at', '>', new Date())
    .select(
      'customer_invitations.email',
      'customer_invitations.expires_at',
      'customer_invitations.prefill_data',
      'admin_users.username as invited_by_username'
    )
    .first();
  if (!invitation) return null;
  return {
    ...invitation,
    prefill: decodePrefill(invitation.prefill_data),
  };
}

/**
 * Customer roster for the admin Customers page. Includes a count of how
 * many events each customer has access to, so the admin can spot orphaned
 * accounts at a glance.
 */
async function listCustomers({ search } = {}) {
  let q = db('customer_accounts')
    .leftJoin('event_customer_assignments', 'event_customer_assignments.customer_account_id', 'customer_accounts.id')
    .groupBy('customer_accounts.id')
    .select(
      'customer_accounts.id',
      'customer_accounts.email',
      'customer_accounts.display_name',
      'customer_accounts.first_name',
      'customer_accounts.last_name',
      'customer_accounts.salutation',
      'customer_accounts.company_name',
      'customer_accounts.is_active',
      'customer_accounts.last_login',
      'customer_accounts.created_at',
      db.raw('COUNT(event_customer_assignments.id) as event_count')
    )
    .orderBy('customer_accounts.created_at', 'desc');

  if (search && String(search).trim()) {
    const term = `%${String(search).trim().toLowerCase()}%`;
    q = q.where(function () {
      this.whereRaw('LOWER(customer_accounts.email) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(customer_accounts.display_name, \'\')) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(customer_accounts.last_name, \'\')) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(customer_accounts.company_name, \'\')) LIKE ?', [term]);
    });
  }

  return q;
}

/**
 * Single customer record + their event assignments. Used by the admin
 * detail view; the customer's own dashboard uses listEventsForCustomer.
 */
async function getCustomerById(id) {
  const customer = await db('customer_accounts').where('id', id).first();
  if (!customer) {
    throw new NotFoundError('Customer', id);
  }
  const events = await db('event_customer_assignments')
    .join('events', 'events.id', 'event_customer_assignments.event_id')
    .where('event_customer_assignments.customer_account_id', id)
    .select(
      'events.id',
      'events.slug',
      'events.event_name',
      'events.event_date',
      'events.expires_at',
      'events.is_archived',
      'event_customer_assignments.assigned_at'
    )
    .orderBy('event_customer_assignments.assigned_at', 'desc');
  return { ...customer, events };
}

/**
 * Update customer profile. Admins can edit any field except auth-related
 * columns (password_hash, password_changed_at, must_change_password) which
 * are mutated by deactivate / reset / accept paths only.
 *
 * email changes deliberately allowed — the admin may need to correct a
 * typo before the customer accepts. Uniqueness is enforced.
 */
async function updateCustomer(id, updates, updatedByAdminId) {
  const customer = await db('customer_accounts').where('id', id).first();
  if (!customer) {
    throw new NotFoundError('Customer', id);
  }

  const allowed = {};
  const fields = [
    'email', 'salutation', 'first_name', 'last_name', 'display_name',
    'phone', 'company_name', 'billing_email', 'vat_id',
    'address_line1', 'address_line2', 'postal_code', 'city', 'state',
    'country_code', 'preferred_language', 'notes'
  ];
  for (const f of fields) {
    if (updates[f] !== undefined) {
      // Trim+lowercase email; everything else passes through. country_code
      // is uppercased to match ISO 3166-1 alpha-2 convention.
      if (f === 'email') {
        allowed[f] = String(updates[f] || '').trim().toLowerCase();
      } else if (f === 'country_code' && updates[f]) {
        allowed[f] = String(updates[f]).trim().toUpperCase().slice(0, 2);
      } else {
        allowed[f] = updates[f];
      }
    }
  }

  if (allowed.email && allowed.email !== customer.email) {
    const conflict = await db('customer_accounts')
      .where('email', allowed.email)
      .whereNot('id', id)
      .first();
    if (conflict) {
      throw new ConflictError('Email already in use', 'email');
    }
  }

  if (updates.is_active !== undefined) {
    allowed.is_active = formatBoolean(updates.is_active);
  }

  allowed.updated_at = new Date();
  await db('customer_accounts').where('id', id).update(allowed);

  await logActivity('customer_updated',
    { customerId: id, fields: Object.keys(allowed) },
    null,
    { type: 'admin', id: updatedByAdminId, name: 'system' }
  );

  return getCustomerById(id);
}

/**
 * Soft-delete: is_active=false. Existing JWTs become invalid because the
 * customerAuth middleware re-checks is_active on every request. Junction
 * rows are kept for audit (event history shows who had access historically).
 */
async function deactivateCustomer(id, deactivatedByAdminId) {
  const customer = await db('customer_accounts').where('id', id).first();
  if (!customer) {
    throw new NotFoundError('Customer', id);
  }

  await db('customer_accounts').where('id', id).update({
    is_active: formatBoolean(false),
    // Bumping password_changed_at invalidates any outstanding tokens
    // immediately — same trick adminAuth uses.
    password_changed_at: new Date(),
    updated_at: new Date(),
  });

  await logActivity('customer_deactivated',
    { customerId: id, email: customer.email },
    null,
    { type: 'admin', id: deactivatedByAdminId, name: 'system' }
  );

  logger.info('Customer deactivated', { customerId: id, deactivatedByAdminId });
}

/**
 * Autocomplete for the event-form picker. Returns up to `limit` rows
 * matching the email/name prefix. Active customers only — deactivated
 * accounts shouldn't show up as assignable options.
 */
async function searchCustomers(query, { limit = 10 } = {}) {
  const term = `%${String(query || '').trim().toLowerCase()}%`;
  if (!term || term === '%%') return [];
  return db('customer_accounts')
    .where('is_active', formatBoolean(true))
    .andWhere(function () {
      this.whereRaw('LOWER(email) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(display_name, \'\')) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(last_name, \'\')) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(company_name, \'\')) LIKE ?', [term]);
    })
    .select('id', 'email', 'display_name', 'first_name', 'last_name', 'company_name')
    .orderBy('email', 'asc')
    .limit(limit);
}

// ---- assignments ---------------------------------------------------------

/**
 * Replace the entire assignment set for one event. Used by the admin
 * event create/update endpoints when they receive `customer_account_ids`
 * — diff-and-apply inside one transaction so the event row and its
 * assignments either both update or neither does.
 *
 * `targetCustomerIds` may be empty to clear all assignments.
 */
async function setAssignmentsForEvent(eventId, targetCustomerIds, adminId, trx = db) {
  const wanted = new Set((targetCustomerIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  const existing = await trx('event_customer_assignments')
    .where('event_id', eventId)
    .select('id', 'customer_account_id');
  const existingIds = new Set(existing.map((r) => r.customer_account_id));

  const toAdd = [...wanted].filter((id) => !existingIds.has(id));
  const toRemove = existing.filter((r) => !wanted.has(r.customer_account_id));

  if (toRemove.length > 0) {
    await trx('event_customer_assignments')
      .whereIn('id', toRemove.map((r) => r.id))
      .del();
  }

  if (toAdd.length > 0) {
    // Validate the customers exist + are active before inserting. Cheaper
    // than catching FK errors and gives the admin a clear error message.
    const valid = await trx('customer_accounts')
      .whereIn('id', toAdd)
      .where('is_active', formatBoolean(true))
      .pluck('id');
    const validSet = new Set(valid);
    const ignored = toAdd.filter((id) => !validSet.has(id));
    if (ignored.length > 0) {
      logger.warn('Ignoring inactive/missing customer ids in assignment', {
        eventId, ignored,
      });
    }
    const rows = [...validSet].map((customerId) => ({
      event_id: eventId,
      customer_account_id: customerId,
      assigned_by_admin_id: adminId,
      assigned_at: new Date(),
    }));
    if (rows.length > 0) {
      await trx('event_customer_assignments').insert(rows);
    }
  }

  return { added: toAdd.length, removed: toRemove.length };
}

/**
 * Fetch the customers currently assigned to an event. Returned by the
 * admin event-detail endpoint so the picker can hydrate.
 */
async function getAssignmentsForEvent(eventId) {
  return db('event_customer_assignments')
    .join('customer_accounts', 'customer_accounts.id', 'event_customer_assignments.customer_account_id')
    .where('event_customer_assignments.event_id', eventId)
    .select(
      'customer_accounts.id',
      'customer_accounts.email',
      'customer_accounts.display_name',
      'customer_accounts.first_name',
      'customer_accounts.last_name',
      'customer_accounts.is_active'
    )
    .orderBy('customer_accounts.email', 'asc');
}

/**
 * Events visible to a logged-in customer. Filters out archived events
 * since those galleries are no longer browsable. Expired events are
 * deliberately included so customers can see "your gallery has expired"
 * messaging in the dashboard rather than just disappearing silently.
 *
 * is_draft filter intentionally NOT applied: a customer assigned to a
 * draft gallery should still see it on their dashboard (the photographer
 * may want them to preview before publish). is_archived stays as the
 * single hard-exclude — those galleries are gone.
 *
 * is_archived has a NOT NULL DEFAULT false from migration 029, so a
 * plain typed filter is safe — no need for a COALESCE-via-whereRaw
 * dance (which itself caused a 500 on postgres because the parameter
 * placeholders weren't accepting the boolean cleanly).
 */
async function listEventsForCustomer(customerId) {
  return db('event_customer_assignments')
    .join('events', 'events.id', 'event_customer_assignments.event_id')
    .where('event_customer_assignments.customer_account_id', customerId)
    .where('events.is_archived', formatBoolean(false))
    .select(
      'events.id',
      'events.slug',
      'events.event_name',
      'events.event_type',
      'events.event_date',
      'events.expires_at',
      'events.is_active',
      'event_customer_assignments.assigned_at'
    )
    .orderBy('events.event_date', 'desc');
}

/**
 * True iff this customer is assigned to this event. Used by the
 * access-token exchange endpoint in customer.js to decide whether to
 * mint a gallery token.
 */
async function customerHasAccessToEvent(customerId, eventId) {
  const row = await db('event_customer_assignments')
    .where('customer_account_id', customerId)
    .where('event_id', eventId)
    .first('id');
  return !!row;
}

// ---- pending invitations -----------------------------------------------

async function getPendingInvitations() {
  return db('customer_invitations')
    .leftJoin('admin_users', 'admin_users.id', 'customer_invitations.invited_by')
    .whereNull('customer_invitations.accepted_at')
    .where('customer_invitations.expires_at', '>', new Date())
    .select(
      'customer_invitations.id',
      'customer_invitations.email',
      'customer_invitations.expires_at',
      'customer_invitations.created_at',
      'admin_users.username as invited_by'
    )
    .orderBy('customer_invitations.created_at', 'desc');
}

async function cancelInvitation(id, cancelledByAdminId) {
  const invitation = await db('customer_invitations').where('id', id).first();
  if (!invitation) {
    throw new NotFoundError('Invitation', id);
  }
  await db('customer_invitations').where('id', id).del();

  await logActivity('customer_invitation_cancelled',
    { invitationId: id, email: invitation.email },
    null,
    { type: 'admin', id: cancelledByAdminId, name: 'system' }
  );
  logger.info('Customer invitation cancelled', { invitationId: id, cancelledByAdminId });
}

module.exports = {
  createInvitation,
  acceptInvitation,
  validateInvitationToken,
  listCustomers,
  getCustomerById,
  updateCustomer,
  deactivateCustomer,
  searchCustomers,
  setAssignmentsForEvent,
  getAssignmentsForEvent,
  listEventsForCustomer,
  customerHasAccessToEvent,
  getPendingInvitations,
  cancelInvitation,
};
