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
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
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
    await db('customer_contacts').where({ id: contact.id }).update({
      password_hash: await bcrypt.hash(PASSWORD, 4),
      ...extra,
    });
    return contact;
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
      const row = await db('customer_contacts').where({ id: contact.id }).first();
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
      const row = await db('customer_contacts').where({ id: contact.id }).first();
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
        email_data: JSON.stringify({ cc: ['Tom@example.test', 'keep@example.test'], name: 'x' }),
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
