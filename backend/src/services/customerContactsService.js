/**
 * Customer contacts (migration 340).
 *
 * The additional people of a customer, each with an own login and own rights.
 * The account holder stays on customer_accounts and always has every right,
 * so a customer without contacts behaves exactly as one did before.
 *
 * A contact never owns anything. Documents, galleries and invoices stay on the
 * customer account, and a contact's session carries that account's id, so the
 * portal's ownership checks hold without knowing about contacts. Rights only
 * narrow what that session may do.
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { getBcryptRounds } = require('../utils/passwordValidation');
const { queueEmail } = require('./emailProcessor');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');
const { capabilityTokenColumns } = require('../utils/capabilityToken');
const { PROTECTED_PENDING_STATUS } = require('../utils/emailQueueEncryption');

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Area -> the levels it offers, lowest first. `act` is what changes something:
// choosing an album, accepting a quote, signing a contract, uploading a
// document, editing the company's data.
const RIGHTS = {
  galleries: ['none', 'view', 'act'],
  quotes: ['none', 'view', 'act'],
  contracts: ['none', 'view', 'act'],
  bills: ['none', 'view'],
  documents: ['none', 'view', 'act'],
  company: ['none', 'act'],
};

const AREAS = Object.keys(RIGHTS);
const HOLDER_RIGHTS = Object.freeze(
  Object.fromEntries(AREAS.map((area) => [area, RIGHTS[area][RIGHTS[area].length - 1]])),
);

const PERSON_FIELDS = ['salutation', 'first_name', 'last_name', 'display_name', 'phone', 'preferred_language'];

const asFlag = (value) => value === true || value === 1 || value === '1' || value === 't';
const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

/** A stored value that is not a level of its area grants nothing. */
function rightsOf(contact) {
  return Object.fromEntries(AREAS.map((area) => {
    const level = contact[`right_${area}`];
    return [area, RIGHTS[area].includes(level) ? level : 'none'];
  }));
}

function hasRight(rights, area, level = 'view') {
  const levels = RIGHTS[area];
  if (!levels || !rights) return false;
  return levels.indexOf(rights[area]) >= Math.max(levels.indexOf(level), 1);
}

/** A customer's effective features, narrowed to what this login may see. */
function applyRights(features, rights) {
  return {
    ...features,
    calendar: !!features.calendar && hasRight(rights, 'galleries'),
    quotes: !!features.quotes && hasRight(rights, 'quotes'),
    bills: !!features.bills && hasRight(rights, 'bills'),
    hoursLogging: !!features.hoursLogging && hasRight(rights, 'bills'),
    contracts: !!features.contracts && hasRight(rights, 'contracts'),
    documents: !!features.documents && hasRight(rights, 'documents'),
  };
}

function rightColumns(rights) {
  const out = {};
  for (const area of AREAS) {
    if (rights?.[area] === undefined) continue;
    if (!RIGHTS[area].includes(rights[area])) {
      throw new ValidationError(`Invalid right for ${area}`);
    }
    out[`right_${area}`] = rights[area];
  }
  return out;
}

function personColumns(input) {
  const out = {};
  for (const field of PERSON_FIELDS) {
    if (input?.[field] === undefined) continue;
    const value = typeof input[field] === 'string' ? input[field].trim().normalize('NFC') : input[field];
    out[field] = value || null;
  }
  return out;
}

/**
 * One address is one login: it may be neither another contact nor a customer's
 * own address, or login could not tell who is meant.
 */
async function assertEmailFree(email, { exceptContactId = null, trx = db } = {}) {
  const taken = await trx('customer_accounts').whereRaw('LOWER(email) = ?', [email]).first('id');
  const contact = await trx('customer_contacts').whereRaw('LOWER(email) = ?', [email])
    .modify((q) => { if (exceptContactId) q.whereNot('id', exceptContactId); })
    .first('id');
  // An open invitation becomes a customer with this address once accepted.
  const invited = await trx('customer_invitations')
    .whereRaw('LOWER(email) = ?', [email])
    .whereNull('contact_id').whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .first('id');
  if (taken || contact || invited) throw new ConflictError('This email is already in use', 'email');
}

/** For the customer side of the same rule. */
async function isContactEmail(email, trx = db) {
  return !!(await trx('customer_contacts').whereRaw('LOWER(email) = ?', [normaliseEmail(email)]).first('id'));
}

async function findLoginByEmail(email) {
  return db('customer_contacts').whereRaw('LOWER(email) = ?', [normaliseEmail(email)]).first();
}

function shape(contact, openInvitation = null) {
  return {
    id: contact.id,
    customerAccountId: contact.customer_account_id,
    email: contact.email,
    salutation: contact.salutation,
    firstName: contact.first_name,
    lastName: contact.last_name,
    displayName: contact.display_name,
    phone: contact.phone,
    preferredLanguage: contact.preferred_language,
    isActive: asFlag(contact.is_active),
    receivesMail: asFlag(contact.receives_mail),
    hasLogin: !!contact.password_hash,
    invitationPending: !!openInvitation,
    lastLogin: contact.last_login || null,
    rights: rightsOf(contact),
  };
}

async function loadContact(customerId, contactId) {
  const contact = await db('customer_contacts')
    .where({ id: contactId, customer_account_id: customerId }).first();
  if (!contact) throw new NotFoundError('Contact', contactId);
  return contact;
}

async function listContacts(customerId) {
  const contacts = await db('customer_contacts')
    .where('customer_account_id', customerId)
    .orderBy('created_at', 'asc').orderBy('id', 'asc');
  if (contacts.length === 0) return [];
  const open = await db('customer_invitations')
    .whereIn('contact_id', contacts.map((c) => c.id))
    .whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .select('contact_id');
  const pending = new Set(open.map((row) => row.contact_id));
  return contacts.map((c) => shape(c, pending.has(c.id)));
}

/**
 * A contact without a login is a person named on the customer; `invite` sends
 * them the link to set a password. A login needs a customer with portal access:
 * "passive" is decided by the account's own password_hash in many places, and
 * a passive customer with working logins would contradict all of them.
 */
async function createContact(customerId, input, adminId) {
  const email = normaliseEmail(input.email);
  if (!email) throw new ValidationError('Email is required');
  const customer = await db('customer_accounts').where('id', customerId).first();
  if (!customer) throw new NotFoundError('Customer', customerId);
  if (!asFlag(customer.is_active)) throw new ValidationError('This customer is inactive');
  await assertEmailFree(email);

  const [inserted] = await db('customer_contacts').insert({
    customer_account_id: customerId,
    email,
    ...personColumns(input),
    ...rightColumns(input.rights),
    receives_mail: formatBoolean(input.receivesMail !== false),
    is_active: formatBoolean(true),
    created_by_admin_id: adminId || null,
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id');
  const id = inserted?.id || inserted;

  await logActivity('customer_contact_created',
    { customerId, contactId: id, email }, null, { type: 'admin', id: adminId });
  if (input.invite) await sendInvitation(customerId, id, adminId);
  return shape(await loadContact(customerId, id));
}

async function updateContact(customerId, contactId, input, adminId) {
  const contact = await loadContact(customerId, contactId);
  const updates = { ...personColumns(input), ...rightColumns(input.rights) };
  if (input.receivesMail !== undefined) updates.receives_mail = formatBoolean(!!input.receivesMail);

  if (input.email !== undefined) {
    const email = normaliseEmail(input.email);
    if (!email) throw new ValidationError('Email is required');
    if (email !== contact.email) {
      await assertEmailFree(email, { exceptContactId: contactId });
      updates.email = email;
      updates.password_changed_at = new Date();
      // The old address must not be able to finish setting up this login.
      await db('customer_invitations').where('contact_id', contactId).whereNull('accepted_at').del();
      await db('customer_password_resets').where('contact_id', contactId).whereNull('used_at').del();
    }
  }
  if (input.isActive !== undefined) {
    updates.is_active = formatBoolean(!!input.isActive);
    if (!input.isActive) updates.password_changed_at = new Date();
  }
  updates.updated_at = new Date();
  await db('customer_contacts').where('id', contactId).update(updates);

  await logActivity('customer_contact_updated',
    { customerId, contactId, fields: Object.keys(updates).filter((k) => k !== 'updated_at') },
    null, { type: 'admin', id: adminId });
  return shape(await loadContact(customerId, contactId));
}

// A removed person's unsent mail must not go out anymore. What was already sent
// stays in the log until the customer is erased.
async function cancelQueuedMail(trx, email) {
  await trx('email_queue')
    .whereRaw('LOWER(recipient_email) = ?', [email])
    .whereIn('status', ['pending', PROTECTED_PENDING_STATUS])
    .update({ status: 'cancelled' });
  // Invoice mail reaches a contact as a CC on the customer's own row.
  const copied = await trx('email_queue')
    .where('status', 'pending')
    .whereRaw('LOWER(CAST(email_data AS TEXT)) LIKE ?', [`%${email}%`])
    .select('id', 'email_data');
  for (const row of copied) {
    let data;
    try {
      data = typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
    } catch (_) {
      continue;
    }
    if (!Array.isArray(data?.cc)) continue;
    const cc = data.cc.filter((address) => String(address).toLowerCase() !== email);
    if (cc.length === data.cc.length) continue;
    await trx('email_queue').where('id', row.id)
      .update({ email_data: JSON.stringify({ ...data, cc }) });
  }
}

// Foreign keys do not run on SQLite, so a link would outlive its contact.
async function deleteContactLinks(trx, contactIds) {
  if (contactIds.length === 0) return;
  await trx('customer_invitations').whereIn('contact_id', contactIds).del();
  await trx('customer_password_resets').whereIn('contact_id', contactIds).del();
}

async function deleteContact(customerId, contactId, adminId) {
  const contact = await loadContact(customerId, contactId);
  await db.transaction(async (trx) => {
    await cancelQueuedMail(trx, contact.email.toLowerCase());
    await deleteContactLinks(trx, [contactId]);
    await trx('customer_contacts').where('id', contactId).del();
  });
  await logActivity('customer_contact_deleted',
    { customerId, contactId }, null, { type: 'admin', id: adminId });
}

async function sendInvitation(customerId, contactId, adminId) {
  const contact = await loadContact(customerId, contactId);
  if (contact.password_hash) throw new ConflictError('This contact already has a login', 'email');
  if (!asFlag(contact.is_active)) throw new ValidationError('This contact is inactive');
  const customer = await db('customer_accounts').where('id', customerId).first();
  if (!customer || !customer.password_hash) {
    const err = new ValidationError('Invite the customer to the portal first');
    err.code = 'CUSTOMER_PASSIVE';
    throw err;
  }

  await db('customer_invitations').where('contact_id', contactId).whereNull('accepted_at').del();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  await db('customer_invitations').insert({
    email: contact.email,
    ...capabilityTokenColumns(token),
    contact_id: contactId,
    invited_by: adminId,
    expires_at: expiresAt,
    created_at: new Date(),
    prefill_data: JSON.stringify(personColumns(contact)),
  });

  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  await queueEmail(null, contact.email, 'customer_invitation', {
    invite_link: `${frontendUrl}/customer/invite/${token}`,
    expires_at: expiresAt.toISOString(),
    __language: contact.preferred_language || customer.preferred_language || undefined,
  });
  await logActivity('customer_invitation_created',
    { email: contact.email, customerId, contactId }, null, { type: 'admin', id: adminId });
  return { email: contact.email, expiresAt };
}

/** An invitation row whose contact_id is set; called from acceptInvitation. */
async function acceptInvitation(invitation, { name, password, profile }) {
  const passwordHash = await bcrypt.hash(password, getBcryptRounds());
  const person = personColumns(profile);
  if (name && !person.display_name) person.display_name = String(name).trim().normalize('NFC') || null;

  const contact = await db.transaction(async (trx) => {
    const claimed = await trx('customer_invitations')
      .where('id', invitation.id).whereNull('accepted_at')
      .update({ accepted_at: new Date() });
    if (claimed !== 1) throw new ValidationError('Invalid or expired invitation');

    // Only the invited person of a live customer, whose address still is the
    // invited one, and only once.
    const row = await trx('customer_contacts')
      .where({ id: invitation.contact_id, email: invitation.email, is_active: formatBoolean(true) })
      .whereNull('password_hash').first();
    const customer = row && await trx('customer_accounts')
      .where({ id: row.customer_account_id, is_active: formatBoolean(true) }).first('id');
    if (!customer) throw new ValidationError('Invalid or expired invitation');

    await trx('customer_contacts').where('id', row.id).update({
      ...person,
      password_hash: passwordHash,
      // Stays null: a login in the same second as this write must not be
      // read as predating it.
      password_changed_at: null,
      updated_at: new Date(),
    });
    await trx('customer_invitations').where('id', invitation.id)
      .update({ accepted_customer_id: row.customer_account_id });
    return row;
  });

  await logActivity('customer_invitation_accepted',
    { customerId: contact.customer_account_id, contactId: contact.id, email: contact.email },
    null, { type: 'customer', id: contact.customer_account_id, name: contact.email });
  return { id: contact.customer_account_id, email: contact.email };
}

async function createPasswordReset(customerId, contactId, adminId) {
  const contact = await loadContact(customerId, contactId);
  if (!asFlag(contact.is_active)) throw new ValidationError('Cannot reset password for an inactive contact');
  if (!contact.password_hash) throw new ValidationError('This contact has no login yet');

  await db('customer_password_resets').where('contact_id', contactId).whereNull('used_at').del();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
  await db('customer_password_resets').insert({
    ...capabilityTokenColumns(token),
    customer_account_id: customerId,
    contact_id: contactId,
    requested_by_admin_id: adminId || null,
    expires_at: expiresAt,
    created_at: new Date(),
  });

  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  await queueEmail(null, contact.email, 'customer_password_reset', {
    reset_link: `${frontendUrl}/customer/reset-password/${token}`,
    expires_at: expiresAt.toISOString(),
    __language: contact.preferred_language || undefined,
  });
  await logActivity('customer_password_reset_requested',
    { customerId, contactId, email: contact.email }, null, { type: 'admin', id: adminId });
  return { email: contact.email, expiresAt };
}

/** The contact a reset row belongs to, if it can still be used. */
async function contactForReset(row) {
  const contact = await db('customer_contacts')
    .where({ id: row.contact_id, is_active: formatBoolean(true) }).first();
  return contact || null;
}

/** A session's right, read fresh: a gallery token does not carry rights. */
async function sessionMayAct(session, area) {
  if (session?.contactId === undefined) return true;
  const contact = await db('customer_contacts').where('id', session.contactId).first();
  return !!contact && hasRight(rightsOf(contact), area, 'act');
}

/** Called from applyPasswordReset for a reset row whose contact_id is set. */
async function applyPasswordReset(row, password) {
  const contact = await contactForReset(row);
  if (!contact) throw new ValidationError('Invalid or expired reset link');
  const passwordHash = await bcrypt.hash(password, getBcryptRounds());
  await db.transaction(async (trx) => {
    const claimed = await trx('customer_password_resets')
      .where('id', row.id).whereNull('used_at').where('expires_at', '>', new Date())
      .update({ used_at: new Date().toISOString() });
    if (claimed !== 1) throw new ValidationError('Invalid or expired reset link');
    const updated = await trx('customer_contacts')
      .where({ id: contact.id, is_active: formatBoolean(true) })
      .update({ password_hash: passwordHash, password_changed_at: new Date(), updated_at: new Date() });
    if (updated !== 1) throw new ValidationError('Invalid or expired reset link');
  });
  await logActivity('customer_password_reset_applied',
    { customerId: contact.customer_account_id, contactId: contact.id, email: contact.email },
    null, { type: 'system', id: null, name: 'system' });
  return { email: contact.email };
}

/** Ends every contact session of a customer, as a bump does for the holder. */
async function endSessions(trx, customerId) {
  await trx('customer_contacts').where('customer_account_id', customerId)
    .update({ password_changed_at: new Date(), updated_at: new Date() });
}

/**
 * Contacts who get mail about `area`: a working login, mail switched on, and
 * the right for it. Keyed by nothing else, so a caller adds them to what the
 * customer's own addresses already receive.
 */
async function mailRecipients(customerId, area) {
  if (!customerId || !(await db.schema.hasTable('customer_contacts'))) return [];
  const contacts = await db('customer_contacts')
    .where({
      customer_account_id: customerId,
      is_active: formatBoolean(true),
      receives_mail: formatBoolean(true),
    })
    .whereNotNull('password_hash');
  return contacts.filter((c) => hasRight(rightsOf(c), area));
}

/** Erasure of the whole customer: returns the addresses it must also redact. */
async function contactEmailsForErasure(trx, customerId) {
  const rows = await trx('customer_contacts').where('customer_account_id', customerId).select('email');
  return rows.map((row) => row.email.toLowerCase());
}

async function deleteAllForErasure(trx, customerId) {
  const rows = await trx('customer_contacts').where('customer_account_id', customerId).select('id');
  await deleteContactLinks(trx, rows.map((row) => row.id));
  await trx('customer_contacts').where('customer_account_id', customerId).del();
}

module.exports = {
  RIGHTS,
  AREAS,
  HOLDER_RIGHTS,
  rightsOf,
  hasRight,
  applyRights,
  asFlag,
  isContactEmail,
  findLoginByEmail,
  listContacts,
  createContact,
  updateContact,
  deleteContact,
  sendInvitation,
  acceptInvitation,
  createPasswordReset,
  contactForReset,
  applyPasswordReset,
  sessionMayAct,
  endSessions,
  mailRecipients,
  contactEmailsForErasure,
  deleteAllForErasure,
};

