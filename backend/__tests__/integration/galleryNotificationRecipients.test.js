/**
 * Who hears that a gallery is ready.
 *
 * The inline customer email gets the standard gallery email; every assigned
 * customer account gets its portal email — on create, publish, send later and
 * resend alike. One person entered in both places is told once, through the
 * portal. A gallery announced only to accounts gets a generated password
 * (migration 264), and adding an inline email to it later needs a real one.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-gallery-recipients-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'gallery-recipients-test-secret';

jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
}));
// Whether the caller holds customers.view; flipped by the identity test.
let mockCanViewCustomers = true;
// Whether the caller holds customers.events (assigning customer accounts).
let mockCanAssignCustomers = true;
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
  userHasAnyPermission: async (_id, perms) => (perms.includes('customers.view')
    ? mockCanViewCustomers
    : perms.includes('customers.events') ? mockCanAssignCustomers : true),
  userHasAllPermissions: async (_id, perms) => (perms.includes('customers.events') ? mockCanAssignCustomers : true),
}));
jest.mock('../../src/middleware/ownership', () => ({
  requireEventOwnership: (_req, _res, next) => next(),
  scopeEventsQuery: (query) => query,
  scopeEventsListQuery: (query) => query,
  withoutForeignEventSecrets: (event) => event,
}));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db;
let cleanup;
let app;
let adminId;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  app = express();
  app.use(express.json());
  app.use('/admin/events', require('../../src/routes/adminEvents'));
}, 180000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

async function setPortal(enabled) {
  const existing = await db('feature_flags').where({ key: 'customerPortal' }).first();
  if (existing) await db('feature_flags').where({ key: 'customerPortal' }).update({ value: enabled });
  else await db('feature_flags').insert({ key: 'customerPortal', value: enabled });
}

beforeEach(async () => {
  await db('email_queue').del();
  await db('event_customer_assignments').del();
  await db('activity_logs').whereNotNull('event_id').del();
  await db('events').del();
  await db('customer_accounts').where('email', 'like', '%@recipients.test').del();
  await setPortal(true);
  mockCanViewCustomers = true;
  mockCanAssignCustomers = true;
});

const idOf = (row) => (typeof row === 'object' ? row.id : row);

async function seedEvent({
  slug, customerEmail = null, isDraft = false, passwordGenerated = false, welcome = null,
  expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
} = {}) {
  const [row] = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: `Event ${slug}`,
    event_date: '2026-09-01',
    host_email: customerEmail || '',
    admin_email: 'admin@example.com',
    customer_email: customerEmail,
    password_hash: 'original-hash',
    password_generated: passwordGenerated ? 1 : 0,
    require_password: 1,
    share_link: `/gallery/${slug}/share`,
    share_token: `${slug}-token`,
    expires_at: expiresAt,
    is_active: 1,
    is_archived: 0,
    is_draft: isDraft ? 1 : 0,
    welcome_message: welcome,
    created_at: new Date().toISOString(),
  }).returning('id');
  return idOf(row);
}

async function seedAccount(email, displayName, { passive = false } = {}) {
  const [row] = await db('customer_accounts').insert({
    email,
    display_name: displayName,
    password_hash: passive ? null : 'hash',
    is_active: 1,
    created_at: new Date().toISOString(),
  }).returning('id');
  return idOf(row);
}

async function assign(eventId, ...customerIds) {
  for (const customerId of customerIds) {
    await db('event_customer_assignments').insert({ event_id: eventId, customer_account_id: customerId });
  }
}

const queued = (type) => db('email_queue').where({ email_type: type }).orderBy('recipient_email');
const recipientsOf = async (type) => (await queued(type)).map((r) => r.recipient_email);

describe('publish and send later reach every recipient', () => {
  it('sends the gallery email to the inline address AND the portal email to each account', async () => {
    const id = await seedEvent({ slug: 'both', customerEmail: 'client@recipients.test', isDraft: true });
    await assign(id,
      await seedAccount('anna@recipients.test', 'Anna Muster'),
      await seedAccount('ben@recipients.test', 'Ben Beispiel'));

    const res = await request(app).post(`/admin/events/${id}/publish`).send({ password: 'Sunrise-Lake-42' });
    expect(res.status).toBe(200);

    expect(await recipientsOf('gallery_created')).toEqual(['client@recipients.test']);
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['anna@recipients.test', 'ben@recipients.test']);
    expect(res.body.recipients.email).toBe('client@recipients.test');
    expect(res.body.recipients.accounts.map((a) => a.name)).toEqual(['Anna Muster', 'Ben Beispiel']);
  });

  it('names the accounts only to an admin who may view customers', async () => {
    const id = await seedEvent({ slug: 'identities', customerEmail: 'client@recipients.test' });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));
    mockCanViewCustomers = false;

    const res = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({ password: 'Sunrise-Lake-42' });
    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual({ email: 'client@recipients.test', account_count: 1, accounts: [] });
    expect(res.body.recipient).toBe('client@recipients.test, 1 customer account(s)');
    expect(JSON.stringify(res.body)).not.toContain('anna@recipients.test');
    // The mail still went out — only the response is narrowed.
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['anna@recipients.test']);
  });

  it('tells one person in both fields once, through the portal', async () => {
    const id = await seedEvent({ slug: 'same-person', customerEmail: 'Anna@Recipients.test' });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));

    const res = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({ password: 'Sunrise-Lake-42' });
    expect(res.status).toBe(200);

    expect(await queued('gallery_created')).toHaveLength(0);
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['anna@recipients.test']);
    // The password only travels in the standard email, which did not go out.
    const row = await db('events').where({ id }).first();
    expect(row.password_hash).toBe('original-hash');
  });

  it('…but by the gallery email when it carries a welcome message the portal email would drop', async () => {
    const id = await seedEvent({ slug: 'same-person-welcome', customerEmail: 'anna@recipients.test', welcome: 'Willkommen!' });
    await assign(id,
      await seedAccount('anna@recipients.test', 'Anna Muster'),
      await seedAccount('ben@recipients.test', 'Ben Beispiel'));

    const res = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({ password: 'Sunrise-Lake-42' });
    expect(res.status).toBe(200);
    expect(await recipientsOf('gallery_created')).toEqual(['anna@recipients.test']);
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['ben@recipients.test']);
  });

  it('mails accounts only for an admin with customers.events — on publish and send alike', async () => {
    mockCanAssignCustomers = false;
    const id = await seedEvent({ slug: 'no-assign-perm', customerEmail: 'client@recipients.test', isDraft: true });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));

    expect((await request(app).post(`/admin/events/${id}/publish`).send({ password: 'Sunrise-Lake-42' })).status).toBe(200);
    expect((await request(app).post(`/admin/events/${id}/send-gallery-email`).send({})).status).toBe(200);
    expect(await recipientsOf('gallery_created')).toEqual(['client@recipients.test', 'client@recipients.test']);
    expect(await queued('customer_gallery_assigned')).toHaveLength(0);

    // With nobody else to tell, an accounts-only gallery has no recipient.
    const accountsOnly = await seedEvent({ slug: 'no-assign-perm-only' });
    await assign(accountsOnly, await seedAccount('ben@recipients.test', 'Ben Beispiel'));
    expect((await request(app).post(`/admin/events/${accountsOnly}/send-gallery-email`).send({})).status).toBe(400);
  });

  it('resend falls back to the gallery email when the folded-in account notice is skipped (draft)', async () => {
    const id = await seedEvent({ slug: 'resend-draft-same', customerEmail: 'anna@recipients.test', isDraft: true });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));

    const res = await request(app).post(`/admin/events/${id}/resend-email`).send({});
    expect(res.status).toBe(200);
    expect(await recipientsOf('gallery_created')).toEqual(['anna@recipients.test']);
    expect(await queued('customer_gallery_assigned')).toHaveLength(0);
    const [row] = await queued('gallery_created');
    const data = typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
    expect(data.customer_email).toBe('anna@recipients.test');
  });

  it('resend answers 400 when nothing at all could be queued', async () => {
    const id = await seedEvent({ slug: 'resend-draft-accounts', isDraft: true });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));

    const res = await request(app).post(`/admin/events/${id}/resend-email`).send({});
    expect(res.status).toBe(400);
    expect(await db('email_queue')).toHaveLength(0);
  });

  // SQLite only: Postgres stores expires_at as a timestamp, so there is no
  // epoch-ms shape to sort below text.
  (process.env.DATABASE_CLIENT === 'pg' ? it.skip : it)('still notifies accounts of a gallery whose expiry is stored as epoch ms (an extended one)', async () => {
    const id = await seedEvent({ slug: 'epoch-expiry', expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));

    const res = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({});
    expect(res.status).toBe(200);
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['anna@recipients.test']);
  });

  it('refuses to mail "(set at creation)" for a password nobody was shown', async () => {
    const id = await seedEvent({ slug: 'generated-publish', customerEmail: 'client@recipients.test', isDraft: true, passwordGenerated: true });

    const refused = await request(app).post(`/admin/events/${id}/publish`).send({});
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('GALLERY_PASSWORD_REQUIRED');
    expect(Number((await db('events').where({ id }).first()).is_draft)).toBe(1);

    const ok = await request(app).post(`/admin/events/${id}/publish`).send({ password: 'Sunrise-Lake-42' });
    expect(ok.status).toBe(200);
    expect(Number((await db('events').where({ id }).first()).password_generated)).toBe(0);
    // Publishing quietly needs no password: nothing carries it.
    const quiet = await seedEvent({ slug: 'generated-quiet', customerEmail: 'client@recipients.test', isDraft: true, passwordGenerated: true });
    expect((await request(app).post(`/admin/events/${quiet}/publish`).send({ notify_customer: false })).status).toBe(200);
  });

  it('publishes a generated-password gallery whose customer email is folded into an account, without a password', async () => {
    // The dialog shows no password field here: the person gets the portal
    // email, which needs none. The server must not refuse what the dialog
    // could not ask for (review round 2).
    const id = await seedEvent({ slug: 'folded-generated', customerEmail: 'anna@recipients.test', isDraft: true, passwordGenerated: true });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));

    const res = await request(app).post(`/admin/events/${id}/publish`).send({});
    expect(res.status).toBe(200);
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['anna@recipients.test']);
    expect(await queued('gallery_created')).toHaveLength(0);

    await db('email_queue').del();
    const sent = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({});
    expect(sent.status).toBe(200);
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['anna@recipients.test']);
  });

  it('withholds the fallback rather than mailing the "(set at creation)" sentinel', async () => {
    const id = await seedEvent({ slug: 'folded-withheld', customerEmail: 'anna@recipients.test', isDraft: true, passwordGenerated: true });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));
    const event = await db('events').where({ id }).first();
    const { notifyGalleryRecipients, resolveGalleryRecipients, galleryCreatedEmailData } = require('../../src/services/galleryNotificationService');
    const recipients = await resolveGalleryRecipients(event);
    expect(recipients.fallbackFor).toBeTruthy();

    // A draft: the portal notice is skipped, so only the fallback could tell her.
    const sent = await notifyGalleryRecipients(event, {
      recipients,
      allowFallback: false,
      buildInlineEmailData: () => galleryCreatedEmailData(event, { requirePassword: true }),
    });
    expect(sent).toEqual({ inlineEmail: null, accounts: [] });
    expect(await db('email_queue')).toHaveLength(0);
  });

  it('gives every admin the notice counts, without the account identities', async () => {
    mockCanViewCustomers = false;
    const id = await seedEvent({ slug: 'notice-counts', customerEmail: 'anna@recipients.test' });
    await assign(id,
      await seedAccount('anna@recipients.test', 'Anna Muster'),
      await seedAccount('ben@recipients.test', 'Ben Beispiel'));

    const res = await request(app).get(`/admin/events/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.gallery_notice).toEqual({ account_count: 2, folds_inline: true });
    expect(res.body.customer_accounts).toEqual([]);
  });

  it('sends no standard gallery email when only accounts are assigned', async () => {
    const id = await seedEvent({ slug: 'accounts-only' });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));

    const res = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({});
    expect(res.status).toBe(200);
    expect(await queued('gallery_created')).toHaveLength(0);
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['anna@recipients.test']);
  });

  it('does not mail accounts while the customer portal is off — the link would lead nowhere', async () => {
    await setPortal(false);
    const id = await seedEvent({ slug: 'portal-off', customerEmail: 'client@recipients.test' });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));

    const res = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({});
    expect(res.status).toBe(200);
    expect(await recipientsOf('gallery_created')).toEqual(['client@recipients.test']);
    expect(await queued('customer_gallery_assigned')).toHaveLength(0);
  });

  it('resend reaches the accounts too, and never queues a mail without an address', async () => {
    const id = await seedEvent({ slug: 'resend-accounts' });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));

    const res = await request(app).post(`/admin/events/${id}/resend-email`).send({});
    expect(res.status).toBe(200);
    expect(await queued('gallery_created')).toHaveLength(0);
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['anna@recipients.test']);
    expect(await db('email_queue').whereNull('recipient_email')).toHaveLength(0);
  });

  it('a password reset on an accounts-only gallery mails nobody', async () => {
    const id = await seedEvent({ slug: 'reset-accounts', passwordGenerated: true });
    await assign(id, await seedAccount('anna@recipients.test', 'Anna Muster'));

    const res = await request(app).post(`/admin/events/${id}/reset-password`).send({ sendEmail: true });
    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(false);
    expect(await db('email_queue')).toHaveLength(0);
    // The admin has now seen the new password.
    expect(Number((await db('events').where({ id }).first()).password_generated)).toBe(0);
  });
});

describe('drafts are announced once, at publish', () => {
  it('assigning a draft from the customer page sends nothing; publishing sends it', async () => {
    const id = await seedEvent({ slug: 'draft-assign', isDraft: true });
    const customerId = await seedAccount('anna@recipients.test', 'Anna Muster');

    const customerAccountsService = require('../../src/services/customerAccountsService');
    await customerAccountsService.setAssignmentsForCustomer(customerId, [id], adminId);
    // The notice is fire-and-forget; give it a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await queued('customer_gallery_assigned')).toHaveLength(0);

    await request(app).post(`/admin/events/${id}/publish`).send({});
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['anna@recipients.test']);
  });
});

describe('accounts-only galleries get a generated password', () => {
  const createEvent = (input) => require('../../src/services/eventCreationService')
    .createEvent(input, { actor: { id: adminId, username: 'tester' } });
  const base = {
    event_type: 'wedding',
    event_name: 'Portal only',
    event_date: '2030-06-15',
    customer_name: 'Anna',
    admin_email: 'admin@example.test',
    require_password: true,
    is_draft: false,
    expires_at: '2030-07-15T00:00:00.000Z',
  };

  it('creates without a password or customer email, and announces through the portal', async () => {
    const customerId = await seedAccount('anna@recipients.test', 'Anna Muster');

    const created = await createEvent({ ...base, customer_account_ids: [customerId] });
    const row = await db('events').where({ id: created.id }).first();

    expect(Number(row.password_generated)).toBe(1);
    expect(Number(row.require_password)).toBe(1);
    expect(row.password_hash).toBeTruthy();
    expect(await queued('gallery_created')).toHaveLength(0);
    expect(await recipientsOf('customer_gallery_assigned')).toEqual(['anna@recipients.test']);
  });

  it('does not count an account the portal email cannot reach — a passive one', async () => {
    const customerId = await seedAccount('passive@recipients.test', 'Passive Person', { passive: true });
    // No customer email, no password, and the only account cannot sign in:
    // a generated password here would lock everyone out.
    await expect(createEvent({ ...base, customer_account_ids: [customerId] })).rejects.toBeTruthy();
    expect(await db('events').where({ event_name: base.event_name })).toHaveLength(0);
  });

  it('without customers.events, accounts neither replace the password nor get mailed', async () => {
    mockCanAssignCustomers = false;
    const customerId = await seedAccount('anna@recipients.test', 'Anna Muster');

    await expect(createEvent({ ...base, customer_account_ids: [customerId] })).rejects.toBeTruthy();

    const created = await createEvent({
      ...base, customer_email: 'client@recipients.test', password: 'Sunrise-Lake-42', customer_account_ids: [customerId],
    });
    expect(Number((await db('events').where({ id: created.id }).first()).password_generated)).toBe(0);
    expect(await recipientsOf('gallery_created')).toEqual(['client@recipients.test']);
    expect(await queued('customer_gallery_assigned')).toHaveLength(0);
  });

  it('still requires a customer email or a password when no account is picked', async () => {
    await expect(createEvent({ ...base })).rejects.toBeTruthy();
  });

  it('uses the typed password when the admin gives one anyway', async () => {
    const customerId = await seedAccount('anna@recipients.test', 'Anna Muster');
    const created = await createEvent({ ...base, password: 'Sunrise-Lake-42', customer_account_ids: [customerId] });
    expect(Number((await db('events').where({ id: created.id }).first()).password_generated)).toBe(0);
  });

  it('asks for a real password before an inline customer email is added', async () => {
    const id = await seedEvent({ slug: 'add-email', passwordGenerated: true });

    const refused = await request(app).put(`/admin/events/${id}`).send({ customer_email: 'client@recipients.test' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('GALLERY_PASSWORD_REQUIRED');

    const accepted = await request(app).put(`/admin/events/${id}`)
      .send({ customer_email: 'client@recipients.test', password: 'Sunrise-Lake-42' });
    expect(accepted.status).toBe(200);
    const row = await db('events').where({ id }).first();
    expect(row.customer_email).toBe('client@recipients.test');
    expect(Number(row.password_generated)).toBe(0);
  });

  it('clearing the email of a generated-password gallery is not adding one', async () => {
    // Clearing is only allowed while the email is optional (issue 1733).
    await db('app_settings').insert({ setting_key: 'event_require_customer_email', setting_value: 'false', setting_type: 'boolean' })
      .onConflict('setting_key').merge({ setting_value: 'false' });
    try {
      const id = await seedEvent({ slug: 'clear-email', passwordGenerated: true });
      const res = await request(app).put(`/admin/events/${id}`).send({ customer_email: null });
      expect(res.status).toBe(200);
    } finally {
      await db('app_settings').where({ setting_key: 'event_require_customer_email' }).del();
    }
  });

  it('does not ask galleries whose password an admin typed', async () => {
    const id = await seedEvent({ slug: 'typed-password' });
    const res = await request(app).put(`/admin/events/${id}`).send({ customer_email: 'client@recipients.test' });
    expect(res.status).toBe(200);
  });
});
