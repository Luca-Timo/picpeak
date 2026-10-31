/**
 * Customer contacts (migration 340): several logins on one customer, each with
 * own rights. The holder of a customer without contacts must not notice any of
 * it, so that is pinned first.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-customer-contacts-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');
const { capabilityTokenColumns } = require('../../src/utils/capabilityToken');

const PASSWORD = 'Sicher12345';
const HOLDER_EMAIL = 'holder@example.test';
const MARKETING = { galleries: 'view', documents: 'act' };
const ACCOUNTING = { bills: 'view', quotes: 'view', contracts: 'view', documents: 'act', company: 'act' };

describe('customer contacts', () => {
  let db;
  let cleanup;
  let adminId;
  let customerId;
  let app;
  let contacts;
  let accounts;
  let sessions;

  const insertId = async (table, row) => {
    const inserted = await db(table).insert(row).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };

  /** A contact with a working login, the way an accepted invitation leaves one. */
  const makeContact = async (email, rights, extra = {}) => {
    const contact = await contacts.createContact(customerId, { email, first_name: 'Mia', rights }, adminId);
    await db('customer_logins').where({ email }).del();
    await db('customer_logins').insert({ email, password_hash: await bcrypt.hash(PASSWORD, 4) });
    if (Object.keys(extra).length > 0) await db('customer_contacts').where({ id: contact.id }).update(extra);
    return { ...contact, hasLogin: true };
  };

  const login = async (email) => {
    const agent = request.agent(app);
    const res = await agent.post('/api/customer/auth/login').send({ email, password: PASSWORD });
    return { agent, res };
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    // Under Jest the sqlite3 binding does not recognise sandbox-created Dates,
    // so `expires_at > new Date()` would never match. Bound as epoch
    // milliseconds, which is what the binding does in production.
    if (db.client.config.client !== 'pg') {
      const proto = db.client.constructor.prototype;
      const { prepBindings } = proto;
      proto.prepBindings = function bindDates(bindings) {
        const prepared = prepBindings.call(this, bindings);
        if (!Array.isArray(prepared)) return prepared;
        return prepared.map((v) => (Object.prototype.toString.call(v) === '[object Date]' ? v.getTime() : v));
      };
    }
    ({ adminId, customerId } = await seedMinimal(db));
    await db('app_settings').whereIn('setting_key', ['customer_feature_quotes_enabled', 'customer_feature_bills_enabled'])
      .update({ setting_value: 'true' });
    await db('customer_accounts').where({ id: customerId }).update({
      email: HOLDER_EMAIL,
      password_hash: await bcrypt.hash(PASSWORD, 4),
      first_name: 'Anna',
      company_name: 'Firma XYZ',
      is_active: true,
      feature_quotes: true,
      feature_bills: true,
    });
    for (const key of ['contracts', 'documents', 'customerPortal']) {
      const flag = await db('feature_flags').where({ key }).first();
      if (flag) await db('feature_flags').where({ key }).update({ value: true });
      else await db('feature_flags').insert({ key, value: true });
    }
    contacts = require('../../src/services/customerContactsService');
    accounts = require('../../src/services/customerAccountsService');
    sessions = require('../../src/services/sessionAccessService');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/customer/auth', require('../../src/routes/customerAuth'));
    app.use('/api/customer', require('../../src/routes/customer'));
  }, 120000);

  afterAll(async () => {
    await cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await db('customer_contacts').del();
    await db('customer_logins').del();
  });

  describe('the account holder', () => {
    it('logs in as before, with every right and no contact claim', async () => {
      const { agent, res } = await login(HOLDER_EMAIL);
      expect(res.status).toBe(200);
      expect(res.body.customer.contactId).toBeNull();
      expect(res.body.customer.rights).toEqual(contacts.HOLDER_RIGHTS);
      const session = await agent.get('/api/customer/auth/session');
      expect(session.status).toBe(200);
      expect(session.body.customer.email).toBe(HOLDER_EMAIL);
      expect(session.body.features.documents).toBe(true);
    });

    it('still reads and writes the company row through /profile', async () => {
      const { agent } = await login(HOLDER_EMAIL);
      const res = await agent.put('/api/customer/profile').send({ city: 'Vaduz', firstName: 'Anna' });
      expect(res.status).toBe(200);
      expect(res.body.profile.city).toBe('Vaduz');
      expect((await db('customer_accounts').where({ id: customerId }).first()).city).toBe('Vaduz');
    });
  });

  describe('login', () => {
    it('logs a contact in on their own identity, owning the customer\'s data', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      const { agent, res } = await login('mia@example.test');
      expect(res.status).toBe(200);
      expect(res.body.customer.id).toBe(customerId);
      expect(res.body.customer.contactId).toBe(contact.id);
      const session = await agent.get('/api/customer/auth/session');
      expect(session.body.customer.email).toBe('mia@example.test');
    });

    it('refuses a wrong password, a contact without login and an inactive contact', async () => {
      await makeContact('off@example.test', MARKETING, { is_active: false });
      await contacts.createContact(customerId, { email: 'nologin@example.test', rights: MARKETING }, adminId);
      expect((await login('off@example.test')).res.status).toBe(401);
      expect((await login('nologin@example.test')).res.status).toBe(401);
      await makeContact('wrong@example.test', MARKETING);
      const agent = request.agent(app);
      const res = await agent.post('/api/customer/auth/login').send({ email: 'wrong@example.test', password: 'Nope12345' });
      expect(res.status).toBe(401);
    });

    it('refuses a contact of an inactive customer', async () => {
      await makeContact('mia@example.test', MARKETING);
      await db('customer_accounts').where({ id: customerId }).update({ is_active: false });
      expect((await login('mia@example.test')).res.status).toBe(401);
      await db('customer_accounts').where({ id: customerId }).update({ is_active: true });
    });
  });

  describe('one address, one login', () => {
    it('does not hand out an address an open customer invitation is waiting for', async () => {
      await db('customer_invitations').where({ email: 'x@example.test' }).del();
      await accounts.createInvitation({ email: 'x@example.test', invitedById: adminId });
      await expect(contacts.createContact(customerId, { email: 'x@example.test' }, adminId))
        .rejects.toMatchObject({ statusCode: 409 });
      await db('customer_invitations').where({ email: 'x@example.test' }).del();
    });

    it('keeps contact and customer addresses apart, both ways', async () => {
      await expect(contacts.createContact(customerId, { email: HOLDER_EMAIL }, adminId))
        .rejects.toMatchObject({ statusCode: 409 });
      await expect(contacts.createContact(customerId, { email: HOLDER_EMAIL.toUpperCase() }, adminId))
        .rejects.toMatchObject({ statusCode: 409 });
      await makeContact('mia@example.test', MARKETING);
      await expect(contacts.createContact(customerId, { email: 'mia@example.test' }, adminId))
        .rejects.toMatchObject({ statusCode: 409 });
      await expect(accounts.createDirect({ email: 'mia@example.test', createdByAdminId: adminId }))
        .rejects.toMatchObject({ statusCode: 409 });
      await expect(accounts.createInvitation({ email: 'mia@example.test', invitedById: adminId }))
        .rejects.toMatchObject({ statusCode: 409 });
      await expect(accounts.updateCustomer(customerId, { email: 'mia@example.test' }, adminId))
        .rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('sessions', () => {
    it('one contact logging out leaves the others and the holder signed in', async () => {
      await makeContact('mia@example.test', MARKETING);
      await makeContact('tom@example.test', ACCOUNTING);
      const mia = await login('mia@example.test');
      const tom = await login('tom@example.test');
      const holder = await login(HOLDER_EMAIL);
      await mia.agent.post('/api/customer/auth/logout');
      expect((await mia.agent.get('/api/customer/auth/session')).status).toBe(401);
      expect((await tom.agent.get('/api/customer/auth/session')).status).toBe(200);
      expect((await holder.agent.get('/api/customer/auth/session')).status).toBe(200);
    });

    it('a contact is ended by their own password change or deactivation, not by the holder\'s', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      const mia = await login('mia@example.test');
      const past = Math.floor(Date.now() / 1000) - 60;
      await db('customer_accounts').where({ id: customerId }).update({ password_changed_at: new Date() });
      const session = { type: 'customer', customerId, contactId: contact.id, iat: past + 30 };
      await expect(sessions.customer(session)).resolves.toMatchObject({ id: customerId });
      await db('customer_accounts').where({ id: customerId }).update({ password_changed_at: null });

      await contacts.updateContact(customerId, contact.id, { isActive: false }, adminId);
      expect((await mia.agent.get('/api/customer/auth/session')).status).toBe(401);
    });

    it('deactivating the customer ends contact sessions for good', async () => {
      await makeContact('mia@example.test', MARKETING);
      const mia = await login('mia@example.test');
      await new Promise((resolve) => { setTimeout(resolve, 1100); });
      await accounts.deactivateCustomer(customerId, adminId);
      expect((await mia.agent.get('/api/customer/auth/session')).status).toBe(401);
      await accounts.reactivateCustomer(customerId, adminId);
      expect((await mia.agent.get('/api/customer/auth/session')).status).toBe(401);
    });

    it('rejects a contact claim of another customer', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      const session = {
        type: 'customer', customerId: customerId + 1000, contactId: contact.id, iat: Math.floor(Date.now() / 1000),
      };
      await expect(sessions.customer(session)).rejects.toMatchObject({ statusCode: 401 });
    });
  });

  describe('rights', () => {
    let invoiceId;
    let quoteId;

    beforeAll(async () => {
      invoiceId = await insertId('invoices', {
        customer_account_id: customerId, invoice_number: 'R-1', status: 'sent', currency: 'CHF',
        issue_date: '2026-01-01', due_date: '2026-02-01', total_amount_minor: 1000,
      });
      quoteId = await insertId('quotes', {
        customer_account_id: customerId, quote_number: 'Q-1', status: 'sent', currency: 'CHF', issue_date: '2026-01-01',
      });
    });

    it('a marketing login sees no invoices anywhere', async () => {
      await makeContact('mia@example.test', MARKETING);
      const { agent, res } = await login('mia@example.test');
      expect(res.body.features.bills).toBe(false);
      expect((await agent.get('/api/customer/invoices')).status).toBe(403);
      expect((await agent.get(`/api/customer/invoices/${invoiceId}/pdf`)).status).toBe(403);
      expect((await agent.get('/api/customer/quotes')).status).toBe(403);
      expect((await agent.get(`/api/customer/quotes/${quoteId}`)).status).toBe(403);
      const dashboard = await agent.get('/api/customer/dashboard');
      expect(dashboard.status).toBe(200);
      expect(dashboard.body.needsAction.invoices || []).toEqual([]);
      expect((dashboard.body.recent || []).filter((item) => /invoice/.test(item.type))).toEqual([]);
    });

    it('the same invoice is there for an accounting login', async () => {
      await makeContact('tom@example.test', ACCOUNTING);
      const { agent } = await login('tom@example.test');
      const res = await agent.get('/api/customer/invoices');
      expect(res.status).toBe(200);
      expect(res.body.invoices.map((row) => row.id)).toContain(invoiceId);
    });

    it('view may read a quote but not answer it', async () => {
      await makeContact('tom@example.test', ACCOUNTING);
      const { agent } = await login('tom@example.test');
      const res = await agent.post(`/api/customer/quotes/${quoteId}/respond`).send({ action: 'accept' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CUSTOMER_RIGHT_MISSING');
      expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('sent');
    });

    it('view may not open a contract for signing', async () => {
      await makeContact('tom@example.test', ACCOUNTING);
      const { agent } = await login('tom@example.test');
      expect((await agent.post('/api/customer/contracts/1/signing-access')).status).toBe(403);
      expect((await agent.post('/api/customer/contracts/1/sign').send({ name: 'Tom', accepted: true })).status).toBe(403);
      expect((await agent.post('/api/customer/contracts/1/upload-signed-pdf')).status).toBe(403);
    });

    it('a contact with the signing right cannot use the older typed-name flow', async () => {
      await makeContact('anna2@example.test', { contracts: 'act' });
      const { agent } = await login('anna2@example.test');
      const res = await agent.post('/api/customer/contracts/1/sign').send({ name: 'Anna', accepted: true });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SIGNER_NOT_FOUND');
      expect((await agent.post('/api/customer/contracts/1/upload-signed-pdf')).status).toBe(403);
    });

    it('no invoice copy goes out while invoices are off for the customer', async () => {
      await makeContact('tom@example.test', ACCOUNTING);
      await db('customer_accounts').where({ id: customerId }).update({ feature_bills: false });
      expect(await contacts.mailRecipients(customerId, 'bills')).toEqual([]);
      await db('customer_accounts').where({ id: customerId }).update({ feature_bills: true });
      expect(await contacts.mailRecipients(customerId, 'bills')).toHaveLength(1);
    });

    it('galleries take their own right, also behind a gallery token', async () => {
      const contact = await makeContact('tom@example.test', ACCOUNTING);
      const { agent } = await login('tom@example.test');
      expect((await agent.get('/api/customer/events')).status).toBe(403);
      expect((await agent.get('/api/customer/events/any/access-token')).status).toBe(403);
      expect((await agent.get('/api/customer/events/any/overview')).status).toBe(403);
      expect((await agent.get('/api/customer/dashboard')).body.galleries.active).toEqual([]);
      expect(contact.rights.galleries).toBe('none');

      const galleryAccess = require('../../src/services/galleryAccessService');
      const eventId = await insertId('events', {
        slug: 'contact-gallery', event_name: 'Gallery', event_type: 'wedding', event_date: '2026-01-01',
        share_link: 'contact-gallery', password_hash: 'x', created_at: new Date(),
      });
      await db('event_customer_assignments').insert({ event_id: eventId, customer_account_id: customerId });
      const now = Math.floor(Date.now() / 1000);
      const event = await db('events').where({ id: eventId }).first();
      const grant = galleryAccess.grant(event, 'gallery', {
        type: 'gallery', eventId, eventSlug: 'contact-gallery', via: 'customer',
        customerId, contactId: contact.id, iat: now, exp: now + 60, jti: 'gallery-grant',
      });
      expect(grant.session.contactId).toBe(contact.id);
      await expect(galleryAccess.authorize(event, grant))
        .rejects.toMatchObject({ code: 'CUSTOMER_ASSIGNMENT_REVOKED' });
      await db('customer_contacts').where({ id: contact.id }).update({ right_galleries: 'view' });
      await expect(galleryAccess.authorize(event, grant)).resolves.toBeTruthy();
    });

    it('choosing an album takes act on galleries, view only looks', async () => {
      const viewer = await makeContact('mia@example.test', MARKETING);
      const decider = await makeContact('anna2@example.test', { galleries: 'act' });
      expect(await contacts.sessionMayAct({ contactId: viewer.id }, 'galleries')).toBe(false);
      expect(await contacts.sessionMayAct({ contactId: decider.id }, 'galleries')).toBe(true);
      expect(await contacts.sessionMayAct({ customerId }, 'galleries')).toBe(true);
      expect(await contacts.sessionMayAct({ contactId: viewer.id + 9999 }, 'galleries')).toBe(false);
    });

    it('a right starts at none and an unknown level grants nothing', async () => {
      const contact = await makeContact('none@example.test', undefined);
      expect(Object.values(contact.rights).every((level) => level === 'none')).toBe(true);
      await db('customer_contacts').where({ id: contact.id }).update({ right_bills: 'owner' });
      const { res } = await login('none@example.test');
      expect(res.body.customer.rights.bills).toBe('none');
      await expect(contacts.updateContact(customerId, contact.id, { rights: { bills: 'act' } }, adminId))
        .rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('profile', () => {
    it('a contact edits their own person, never the holder\'s', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      const { agent } = await login('mia@example.test');
      const res = await agent.put('/api/customer/profile').send({ firstName: 'Mia', phone: '+423 1' });
      expect(res.status).toBe(200);
      expect((await db('customer_contacts').where({ id: contact.id }).first()).phone).toBe('+423 1');
      const holder = await db('customer_accounts').where({ id: customerId }).first();
      expect(holder.first_name).toBe('Anna');
      expect(holder.phone).not.toBe('+423 1');
    });

    it('company data takes the company right, for reading and writing', async () => {
      await makeContact('mia@example.test', MARKETING);
      await makeContact('tom@example.test', ACCOUNTING);
      const mia = await login('mia@example.test');
      expect((await mia.agent.get('/api/customer/profile')).body.profile.companyName).toBeNull();
      expect((await mia.agent.put('/api/customer/profile').send({ companyName: 'Evil' })).status).toBe(403);
      const tom = await login('tom@example.test');
      expect((await tom.agent.get('/api/customer/profile')).body.profile.companyName).toBe('Firma XYZ');
      expect((await tom.agent.put('/api/customer/profile').send({ city: 'Schaan' })).status).toBe(200);
      expect((await db('customer_accounts').where({ id: customerId }).first()).city).toBe('Schaan');
    });

    it('a contact does not decide the customer\'s newsletter consent', async () => {
      await makeContact('mia@example.test', MARKETING);
      const { agent } = await login('mia@example.test');
      expect((await agent.put('/api/customer/profile/marketing').send({ optOut: true })).status).toBe(403);
    });

    it('a contact changes only their own password', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      const { agent } = await login('mia@example.test');
      const before = (await db('customer_accounts').where({ id: customerId }).first()).password_hash;
      const res = await agent.post('/api/customer/profile/password')
        .send({ currentPassword: PASSWORD, newPassword: 'Neues12345' });
      expect(res.status).toBe(200);
      expect((await db('customer_accounts').where({ id: customerId }).first()).password_hash).toBe(before);
      const row = await db('customer_logins').where({ email: contact.email }).first();
      expect(await bcrypt.compare('Neues12345', row.password_hash)).toBe(true);
    });
  });

  describe('invitations and resets', () => {
    const mailedToken = async (email, type) => {
      const rows = await db('email_queue').where({ recipient_email: email, email_type: type }).orderBy('id', 'desc');
      return rows[0];
    };

    it('a contact needs a customer with portal access', async () => {
      const passiveId = await insertId('customer_accounts', {
        email: 'passive@example.test', is_active: true, created_at: new Date(), updated_at: new Date(),
      });
      await expect(contacts.createContact(passiveId, { email: 'a@example.test', invite: true }, adminId))
        .rejects.toMatchObject({ code: 'CUSTOMER_PASSIVE' });
      await db('customer_accounts').where({ id: passiveId }).del();
    });

    it('an accepted invitation gives the contact a login and leaves the holder alone', async () => {
      const contact = await contacts.createContact(
        customerId, { email: 'new@example.test', rights: MARKETING }, adminId,
      );
      await contacts.sendInvitation(customerId, contact.id, adminId);
      expect(await mailedToken('new@example.test', 'customer_invitation')).toBeTruthy();
      expect(await accounts.getPendingInvitations()).toEqual([]);

      const token = crypto.randomBytes(32).toString('hex');
      await db('customer_invitations').where({ contact_id: contact.id })
        .update(capabilityTokenColumns(token));
      const lookup = await accounts.validateInvitationToken(token);
      expect(lookup?.contact_id).toBe(contact.id);

      await accounts.acceptInvitation({ token, name: 'Neu', password: PASSWORD, profile: { company_name: 'Evil' } });
      expect((await login('new@example.test')).res.status).toBe(200);
      expect((await db('customer_accounts').where({ id: customerId }).first()).company_name).toBe('Firma XYZ');
      await expect(accounts.acceptInvitation({ token, password: PASSWORD })).rejects.toBeTruthy();
    });

    it('changing a contact\'s address drops the open invitation', async () => {
      const contact = await contacts.createContact(customerId, { email: 'old@example.test' }, adminId);
      await contacts.sendInvitation(customerId, contact.id, adminId);
      await contacts.updateContact(customerId, contact.id, { email: 'moved@example.test' }, adminId);
      expect(await db('customer_invitations').where({ contact_id: contact.id })).toEqual([]);
    });

    it('changing the holder\'s address leaves a contact\'s reset link alone', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      await contacts.createPasswordReset(customerId, contact.id, adminId);
      await accounts.updateCustomer(customerId, { email: 'holder2@example.test' }, adminId);
      expect(await db('customer_password_resets').where({ contact_id: contact.id })).toHaveLength(1);
      await accounts.updateCustomer(customerId, { email: HOLDER_EMAIL }, adminId);
    });

    it('a reset changes the contact\'s password and ends their session only', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      const holderBefore = (await db('customer_accounts').where({ id: customerId }).first()).password_hash;
      await contacts.createPasswordReset(customerId, contact.id, adminId);
      const token = crypto.randomBytes(32).toString('hex');
      await db('customer_password_resets').where({ contact_id: contact.id })
        .update(capabilityTokenColumns(token));
      expect((await accounts.validatePasswordResetToken(token)).email).toBe('mia@example.test');
      await accounts.applyPasswordReset({ token, password: 'Neues12345' });
      const row = await db('customer_logins').where({ email: contact.email }).first();
      expect(await bcrypt.compare('Neues12345', row.password_hash)).toBe(true);
      expect((await db('customer_accounts').where({ id: customerId }).first()).password_hash).toBe(holderBefore);
    });
  });

  describe('mail', () => {
    it('reaches only contacts with a login, mail on and the right', async () => {
      await makeContact('tom@example.test', ACCOUNTING);
      await makeContact('mia@example.test', MARKETING);
      await makeContact('quiet@example.test', ACCOUNTING, { receives_mail: false });
      await contacts.createContact(customerId, { email: 'nologin@example.test', rights: ACCOUNTING }, adminId);
      const bills = await contacts.mailRecipients(customerId, 'bills');
      expect(bills.map((c) => c.email)).toEqual(['tom@example.test']);
    });

    it('adds contacts to the billing CC, without touching the To address', () => {
      const { resolveBillingRecipients } = require('../../src/services/_billingRecipients');
      expect(resolveBillingRecipients({ email: 'a@x.test' }, null)).toEqual({ to: 'a@x.test', cc: undefined });
      expect(resolveBillingRecipients({ email: 'a@x.test', billing_email: 'b@x.test' }, null, ['t@x.test', 'B@x.test']))
        .toEqual({ to: 'b@x.test', cc: ['a@x.test', 't@x.test'] });
    });
  });

  describe('one person at several companies', () => {
    let secondId;

    beforeAll(async () => {
      secondId = await insertId('customer_accounts', {
        email: 'zweite@example.test',
        password_hash: await bcrypt.hash('Andere12345', 4),
        company_name: 'Firma ABC',
        is_active: true,
        feature_quotes: true,
        feature_bills: true,
        created_at: new Date(),
        updated_at: new Date(),
      });
    });

    const inBoth = async () => {
      const first = await makeContact('mia@example.test', MARKETING);
      const second = await contacts.createContact(secondId, { email: 'mia@example.test', rights: ACCOUNTING }, adminId);
      return { first, second };
    };

    it('logs in once, with both companies and one set of rights at a time', async () => {
      const { second } = await inBoth();
      expect(second.hasLogin).toBe(true);
      const { agent, res } = await login('mia@example.test');
      expect(res.status).toBe(200);
      expect(res.body.customer.id).toBe(customerId);
      expect(res.body.customer.companies.map((c) => c.id)).toEqual([customerId, secondId]);
      expect(res.body.features.bills).toBe(false);
      expect((await agent.get('/api/customer/invoices')).status).toBe(403);

      const switched = await agent.post('/api/customer/auth/switch-company').send({ customerId: secondId });
      expect(switched.status).toBe(200);
      expect(switched.body.customer.id).toBe(secondId);
      expect(switched.body.customer.contactId).toBe(second.id);
      expect(switched.body.features.bills).toBe(true);
      expect((await agent.get('/api/customer/invoices')).status).toBe(200);
      const session = await agent.get('/api/customer/auth/session');
      expect(session.body.customer.id).toBe(secondId);
      expect(session.body.customer.rights).toEqual(second.rights);
    });

    it('ends the old session on a switch, and switching back works in the same second', async () => {
      await inBoth();
      const { agent, res } = await login('mia@example.test');
      expect((await agent.post('/api/customer/auth/switch-company').send({ customerId: secondId })).status).toBe(200);
      expect((await agent.post('/api/customer/auth/switch-company').send({ customerId: res.body.customer.id })).status).toBe(200);
      expect((await agent.get('/api/customer/auth/session')).status).toBe(200);
    });

    it('refuses a company this person does not belong to', async () => {
      await makeContact('mia@example.test', MARKETING);
      const { agent } = await login('mia@example.test');
      const res = await agent.post('/api/customer/auth/switch-company').send({ customerId: secondId });
      expect(res.status).toBe(404);
      expect((await agent.get('/api/customer/auth/session')).body.customer.id).toBe(customerId);
    });

    it('refuses a company the person was removed from since logging in', async () => {
      const { second } = await inBoth();
      const { agent } = await login('mia@example.test');
      await contacts.updateContact(secondId, second.id, { isActive: false }, adminId);
      const res = await agent.post('/api/customer/auth/switch-company').send({ customerId: secondId });
      expect(res.status).toBe(404);
    });

    it('lets a holder of one company be a contact at another, on the one password', async () => {
      const contact = await contacts.createContact(secondId, { email: HOLDER_EMAIL, rights: ACCOUNTING }, adminId);
      expect(contact.hasLogin).toBe(true);
      const { agent, res } = await login(HOLDER_EMAIL);
      expect(res.body.customer.contactId).toBeNull();
      expect(res.body.customer.rights).toEqual(contacts.HOLDER_RIGHTS);
      expect(res.body.customer.companies).toHaveLength(2);
      const switched = await agent.post('/api/customer/auth/switch-company').send({ customerId: secondId });
      expect(switched.body.customer.contactId).toBe(contact.id);
      expect(switched.body.customer.rights.quotes).toBe('view');
      const back = await agent.post('/api/customer/auth/switch-company').send({ customerId });
      expect(back.body.customer.contactId).toBeNull();
    });

    it('a holder\'s address change takes their contact rows along', async () => {
      const contact = await contacts.createContact(secondId, { email: HOLDER_EMAIL, rights: ACCOUNTING }, adminId);
      await accounts.updateCustomer(customerId, { email: 'holder3@example.test' }, adminId);
      expect((await db('customer_contacts').where({ id: contact.id }).first()).email).toBe('holder3@example.test');
      await accounts.updateCustomer(customerId, { email: HOLDER_EMAIL }, adminId);
    });

    it('one company\'s rights never apply at the other, and a contact is once per company', async () => {
      await inBoth();
      await expect(contacts.createContact(secondId, { email: 'mia@example.test' }, adminId))
        .rejects.toMatchObject({ statusCode: 409 });
      const lists = await Promise.all([contacts.listContacts(customerId), contacts.listContacts(secondId)]);
      expect(lists[0][0].rights.bills).toBe('none');
      expect(lists[1][0].rights.bills).toBe('view');
    });

    it('sends no invitation to someone who already has a login', async () => {
      await makeContact('mia@example.test', MARKETING);
      const added = await contacts.createContact(secondId, { email: 'mia@example.test', invite: true }, adminId);
      expect(await db('customer_invitations').where({ contact_id: added.id })).toEqual([]);
      await expect(contacts.sendInvitation(secondId, added.id, adminId)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('a second invitation accepted after the first finds the login made', async () => {
      const first = await contacts.createContact(customerId, { email: 'twice@example.test' }, adminId);
      const second = await contacts.createContact(secondId, { email: 'twice@example.test' }, adminId);
      await contacts.sendInvitation(customerId, first.id, adminId);
      await contacts.sendInvitation(secondId, second.id, adminId);
      const tokens = ['a'.repeat(64), 'b'.repeat(64)];
      await db('customer_invitations').where({ contact_id: first.id }).update(capabilityTokenColumns(tokens[0]));
      await db('customer_invitations').where({ contact_id: second.id }).update(capabilityTokenColumns(tokens[1]));
      await accounts.acceptInvitation({ token: tokens[0], password: PASSWORD });
      await expect(accounts.acceptInvitation({ token: tokens[1], password: 'Anders12345' }))
        .rejects.toMatchObject({ statusCode: 409 });
      expect((await login('twice@example.test')).res.body.customer.companies).toHaveLength(2);
    });

    it('a password change holds at both companies', async () => {
      await inBoth();
      const { agent } = await login('mia@example.test');
      await agent.post('/api/customer/profile/password').send({ currentPassword: PASSWORD, newPassword: 'Neues12345' });
      expect(await db('customer_logins').where({ email: 'mia@example.test' })).toHaveLength(1);
      const fresh = await request.agent(app).post('/api/customer/auth/login')
        .send({ email: 'mia@example.test', password: 'Neues12345' });
      expect(fresh.body.customer.companies).toHaveLength(2);
    });

    it('removing one company leaves the login, the other company and its mail', async () => {
      const { first } = await inBoth();
      await db('email_queue').insert({
        recipient_email: 'mia@example.test', email_type: 'gallery_created', status: 'pending',
        email_data: JSON.stringify({ name: 'Mia' }), created_at: new Date(), scheduled_at: new Date(),
      });
      await contacts.deleteContact(customerId, first.id, adminId);
      expect(await db('customer_logins').where({ email: 'mia@example.test' })).toHaveLength(1);
      const { res } = await login('mia@example.test');
      expect(res.status).toBe(200);
      expect(res.body.customer.id).toBe(secondId);
      expect(await db('email_queue').where({ recipient_email: 'mia@example.test', status: 'pending' })).toHaveLength(1);
      await db('email_queue').where({ recipient_email: 'mia@example.test' }).del();
    });

    it('a holder\'s address change kills a reset link sent to the old address', async () => {
      const contact = await contacts.createContact(secondId, { email: HOLDER_EMAIL, rights: ACCOUNTING }, adminId);
      await contacts.createPasswordReset(secondId, contact.id, adminId);
      await accounts.updateCustomer(customerId, { email: 'holder4@example.test' }, adminId);
      expect(await db('customer_password_resets').where({ contact_id: contact.id })).toEqual([]);
      await accounts.updateCustomer(customerId, { email: HOLDER_EMAIL }, adminId);
    });

    it('moving a contact onto an address with a login leaves no orphaned password', async () => {
      const mia = await makeContact('mia@example.test', MARKETING);
      await makeContact('tom@example.test', MARKETING);
      await contacts.updateContact(customerId, mia.id, { email: 'neu@example.test' }, adminId);
      expect((await db('customer_logins').where({ email: 'neu@example.test' }))).toHaveLength(1);
      const other = await contacts.createContact(secondId, { email: 'tom@example.test' }, adminId);
      await contacts.updateContact(customerId, mia.id, { email: 'tom2@example.test' }, adminId);
      await db('customer_logins').insert({ email: 'tom3@example.test', password_hash: 'x' });
      await contacts.updateContact(customerId, mia.id, { email: 'tom3@example.test' }, adminId);
      expect(await db('customer_logins').where({ email: 'tom2@example.test' })).toEqual([]);
      expect(other.hasLogin).toBe(true);
    });

    it('removing a person from one company cancels only the mail queued about it', async () => {
      const { first } = await inBoth();
      const row = (id) => ({
        recipient_email: 'mia@example.test', email_type: 'customer_gallery_assigned', status: 'pending',
        email_data: JSON.stringify({ gallery_list_text: 'x', __customerAccountId: id }),
        created_at: new Date(), scheduled_at: new Date(),
      });
      await db('email_queue').insert(row(customerId));
      await db('email_queue').insert(row(secondId));
      await contacts.deleteContact(customerId, first.id, adminId);
      const rows = await db('email_queue').where({ recipient_email: 'mia@example.test' });
      const dataOf = (r) => (typeof r.email_data === 'string' ? JSON.parse(r.email_data) : r.email_data);
      const stateOf = (id) => rows.find((r) => dataOf(r).__customerAccountId === id).status;
      expect(stateOf(customerId)).toBe('cancelled');
      expect(stateOf(secondId)).toBe('pending');
      await db('email_queue').where({ recipient_email: 'mia@example.test' }).del();
    });

    it('erasing a company redacts what was queued about it to someone who stays elsewhere', async () => {
      const erasedId = await insertId('customer_accounts', {
        email: 'erase4@example.test', password_hash: 'x', is_active: true, created_at: new Date(), updated_at: new Date(),
      });
      await makeContact('mia@example.test', MARKETING);
      await contacts.createContact(erasedId, { email: 'mia@example.test' }, adminId);
      await db('email_queue').insert({
        recipient_email: 'mia@example.test', email_type: 'customer_gallery_assigned', status: 'pending',
        email_data: JSON.stringify({ gallery_list_text: 'Secret', __customerAccountId: erasedId }),
        created_at: new Date(), scheduled_at: new Date(),
      });
      await accounts.eraseCustomer(erasedId, adminId);
      const [row] = await db('email_queue').where({ recipient_email: 'mia@example.test' });
      expect(row.status).toBe('cancelled');
      expect(JSON.stringify(row.email_data)).not.toContain('Secret');
      await db('email_queue').where({ recipient_email: 'mia@example.test' }).del();
    });

    it('removing the last company removes the login', async () => {
      const { first, second } = await inBoth();
      await contacts.deleteContact(customerId, first.id, adminId);
      await contacts.deleteContact(secondId, second.id, adminId);
      expect(await db('customer_logins').where({ email: 'mia@example.test' })).toEqual([]);
    });

    it('erasing one company leaves a person who stays at another', async () => {
      const erasedId = await insertId('customer_accounts', {
        email: 'erase3@example.test', password_hash: 'x', is_active: true, created_at: new Date(), updated_at: new Date(),
      });
      await makeContact('mia@example.test', MARKETING);
      await contacts.createContact(erasedId, { email: 'mia@example.test' }, adminId);
      await accounts.eraseCustomer(erasedId, adminId);
      expect(await db('customer_contacts').where({ customer_account_id: erasedId })).toEqual([]);
      expect((await login('mia@example.test')).res.status).toBe(200);
    });

    it('a contact at a passive customer does not open that customer', async () => {
      const passiveId = await insertId('customer_accounts', {
        email: 'passive2@example.test', is_active: true, created_at: new Date(), updated_at: new Date(),
      });
      await makeContact('mia@example.test', MARKETING);
      await contacts.createContact(passiveId, { email: 'mia@example.test' }, adminId);
      const { agent, res } = await login('mia@example.test');
      expect(res.body.customer.companies.map((c) => c.id)).toEqual([customerId]);
      expect((await agent.post('/api/customer/auth/switch-company').send({ customerId: passiveId })).status).toBe(404);
    });
  });

  describe('admin routes', () => {
    let adminApp;
    let token;
    let otherCustomerId;

    const call = (method, url) => request(adminApp)[method](url).set('Authorization', `Bearer ${token}`);

    beforeAll(async () => {
      adminApp = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
      token = mintAdminToken(adminId);
      otherCustomerId = await insertId('customer_accounts', {
        email: 'other@example.test', password_hash: 'x', is_active: true, created_at: new Date(), updated_at: new Date(),
      });
    });

    it('need an admin, and the permission of the route', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      const url = `/api/admin/customers/${customerId}/contacts`;
      expect((await request(adminApp).get(url)).status).toBe(401);
      expect((await request(adminApp).post(url).send({ email: 'a@example.test' })).status).toBe(401);
      for (const [method, path] of [
        ['get', url],
        ['post', url],
        ['put', `${url}/${contact.id}`],
        ['delete', `${url}/${contact.id}`],
        ['post', `${url}/${contact.id}/send-invite`],
        ['post', `${url}/${contact.id}/password-reset`],
      ]) {
        const res = await call(method, path).send({ email: 'a@example.test' });
        expect(res.status).toBe(403);
      }
      await assignAdminRole(db, adminId, 'super_admin');
    });

    it('reach a contact only through its own customer', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      const url = `/api/admin/customers/${otherCustomerId}/contacts/${contact.id}`;
      expect((await call('put', url).send({ first_name: 'X', rights: { bills: 'view' } })).status).toBe(404);
      expect((await call('post', `${url}/password-reset`)).status).toBe(404);
      expect((await call('post', `${url}/send-invite`)).status).toBe(404);
      expect((await call('delete', url)).status).toBe(404);
      const row = await db('customer_contacts').where({ id: contact.id }).first();
      expect(row.first_name).toBe('Mia');
      expect(row.right_bills).toBe('none');
      const list = await call('get', `/api/admin/customers/${otherCustomerId}/contacts`);
      expect(list.body.contacts).toEqual([]);
    });

    it('never return a password hash', async () => {
      await makeContact('mia@example.test', MARKETING);
      const res = await call('get', `/api/admin/customers/${customerId}/contacts`);
      expect(res.status).toBe(200);
      expect(res.body.contacts[0].hasLogin).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/password_hash|\$2[aby]\$/);
    });

    it('keep a contact removable while the portal is off, but hand out no login', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      const url = `/api/admin/customers/${customerId}/contacts`;
      await db('feature_flags').where({ key: 'customerPortal' }).update({ value: false });
      await new Promise((resolve) => { setTimeout(resolve, 10100); });
      try {
        expect((await call('post', url).send({ email: 'new@example.test' })).status).toBe(403);
        expect((await call('post', `${url}/${contact.id}/password-reset`)).status).toBe(403);
        expect((await call('put', `${url}/${contact.id}`).send({ isActive: false })).status).toBe(200);
        expect((await call('delete', `${url}/${contact.id}`)).status).toBe(200);
      } finally {
        await db('feature_flags').where({ key: 'customerPortal' }).update({ value: true });
      }
    }, 20000);
  });

  describe('schema', () => {
    it('leaves the account-recovery write guards in place on SQLite', async () => {
      if (db.client.config.client === 'pg') return;
      const triggers = await db('sqlite_master').where({ type: 'trigger' }).select('name');
      const names = triggers.map((row) => row.name);
      for (const table of ['customer_invitations', 'customer_password_resets']) {
        expect(names).toContain(`picpeak_recovery_${table}_insert_guard`);
        expect(names).toContain(`picpeak_recovery_${table}_update_guard`);
      }
    });
  });

  describe('removal', () => {
    it('takes open links and personal data with the contact, on every engine', async () => {
      const contact = await contacts.createContact(
        customerId, { email: 'mia@example.test', first_name: 'Mia', phone: '123' }, adminId,
      );
      await contacts.sendInvitation(customerId, contact.id, adminId);
      await contacts.deleteContact(customerId, contact.id, adminId);
      expect(await db('customer_invitations').where({ email: 'mia@example.test' })).toEqual([]);
      await expect(accounts.createInvitation({ email: 'mia@example.test', invitedById: adminId }))
        .resolves.toBeTruthy();
      await db('customer_invitations').where({ email: 'mia@example.test' }).del();
    });

    it('drops a deleted contact from the CC of queued mail', async () => {
      const contact = await makeContact('tom@example.test', ACCOUNTING);
      const inserted = await db('email_queue').insert({
        recipient_email: HOLDER_EMAIL, email_type: 'invoice_sent', status: 'pending',
        email_data: JSON.stringify({ cc: ['Tom@example.test', 'keep@example.test'], name: 'x', __customerAccountId: customerId }),
        created_at: new Date(), scheduled_at: new Date(),
      }).returning('id');
      const id = inserted[0]?.id ?? inserted[0];
      await contacts.deleteContact(customerId, contact.id, adminId);
      const row = await db('email_queue').where({ id }).first();
      const data = typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
      expect(row.status).toBe('pending');
      expect(data.cc).toEqual(['keep@example.test']);
      await db('email_queue').where({ id }).del();
    });

    it('erasing the customer leaves no open contact link behind', async () => {
      const erasedId = await insertId('customer_accounts', {
        email: 'erase2@example.test', password_hash: 'x', is_active: true, created_at: new Date(), updated_at: new Date(),
      });
      const contact = await contacts.createContact(erasedId, { email: 'gone2@example.test', phone: '123' }, adminId);
      await contacts.sendInvitation(erasedId, contact.id, adminId);
      await accounts.eraseCustomer(erasedId, adminId);
      expect(await db('customer_invitations').where({ email: 'gone2@example.test' })).toEqual([]);
    });

    it('deleting a contact cancels their unsent mail', async () => {
      const contact = await makeContact('mia@example.test', MARKETING);
      await contacts.createPasswordReset(customerId, contact.id, adminId);
      await contacts.deleteContact(customerId, contact.id, adminId);
      const rows = await db('email_queue').where({ recipient_email: 'mia@example.test' });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.status === 'cancelled')).toBe(true);
    });

    it('erasing the customer removes the contacts and their queued mail', async () => {
      const erasedId = await insertId('customer_accounts', {
        email: 'erase@example.test', password_hash: 'x', is_active: true, created_at: new Date(), updated_at: new Date(),
      });
      const contact = await contacts.createContact(erasedId, { email: 'gone@example.test', first_name: 'Gone' }, adminId);
      await db('email_queue').insert({
        recipient_email: 'gone@example.test', email_type: 'invoice_sent', status: 'sent',
        email_data: JSON.stringify({ name: 'Gone' }), created_at: new Date(), scheduled_at: new Date(),
      });
      await accounts.eraseCustomer(erasedId, adminId);
      expect(await db('customer_contacts').where({ id: contact.id }).first()).toBeUndefined();
      expect(await db('email_queue').where({ recipient_email: 'gone@example.test' })).toEqual([]);
    });
  });
});
