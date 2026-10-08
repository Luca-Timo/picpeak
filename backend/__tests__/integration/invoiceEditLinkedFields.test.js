/**
 * A scheduled invoice is edited on its own page, and the form offers its
 * customer, VAT code and linked event. PUT used to drop all three while the
 * editor said "saved"; they now save, with the checks createInvoice makes:
 * the customer must be billable, the event must be one the admin owns (the
 * rule CRM code uses for events, filterOwnedEventIds), and an event with
 * customer assignments must belong to the invoice's customer. Creating an
 * invoice applies the same event rule.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let customerId;
let otherCustomerId;
let editorToken;
let ownEventId;
let foreignEventId;
let invoiceApp;

const prevCwd = process.cwd();
const id = (rows) => (typeof rows[0] === 'object' ? rows[0].id : rows[0]);

async function insertEvent(slug, createdBy) {
  return id(await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: slug,
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `${slug}-share`,
    expires_at: new Date().toISOString(),
    created_by: createdBy,
  }).returning('id'));
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  let ownerId;
  ({ adminId: ownerId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, ownerId, 'super_admin');

  // The editor: a studio admin with bills.manage who owns only their events.
  const editorId = id(await db('admin_users').insert({
    username: 'editor', email: 'editor@example.com', password_hash: 'x',
    must_change_password: false, created_at: new Date(),
  }).returning('id'));
  await assignAdminRole(db, editorId, 'admin');
  editorToken = mintAdminToken(editorId);

  otherCustomerId = id(await db('customer_accounts').insert({
    email: 'second@example.com', display_name: 'Second Customer', password_hash: 'x',
    preferred_language: 'de', is_active: 1, created_at: new Date(),
  }).returning('id'));

  ownEventId = await insertEvent('editor-own', editorId);
  foreignEventId = await insertEvent('someone-elses', ownerId);

  const updated = await db('feature_flags').where({ key: 'bills' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'bills', value: true });
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const as = (req) => req.set('Authorization', `Bearer ${editorToken}`);

async function scheduledInvoice() {
  const created = await as(request(invoiceApp).post('/api/admin/invoices')).send({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Shooting', unitPriceMinor: 100000, discountPercent: 0 }],
  });
  expect(created.status).toBe(201);
  return created.body.invoice.id;
}

test('customer, VAT code and an owned event save on a scheduled invoice', async () => {
  const invoiceId = await scheduledInvoice();
  const saved = await as(request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`)).send({
    customerAccountId: otherCustomerId, vatCode: 'UN81', vatRate: 8.1, eventId: ownEventId,
  });
  expect(saved.status).toBe(200);
  const row = await db('invoices').where({ id: invoiceId }).first();
  expect(Number(row.customer_account_id)).toBe(otherCustomerId);
  expect(Number(row.event_id)).toBe(ownEventId);
  expect(row.vat_code).toBe('UN81');
});

test('an event the admin does not own is refused, on update and on create', async () => {
  const invoiceId = await scheduledInvoice();
  const put = await as(request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`)).send({ eventId: foreignEventId });
  expect(put.status).toBe(403);
  expect((await db('invoices').where({ id: invoiceId }).first()).event_id).toBeNull();

  const post = await as(request(invoiceApp).post('/api/admin/invoices')).send({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, eventId: foreignEventId,
    lineItems: [{ position: 1, quantity: 1, description: 'Shooting', unitPriceMinor: 100000, discountPercent: 0 }],
  });
  expect(post.status).toBe(403);
});

test('an event assigned to another customer is refused', async () => {
  const invoiceId = await scheduledInvoice();
  await db('event_customer_assignments').insert({ event_id: ownEventId, customer_account_id: otherCustomerId });
  const put = await as(request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`)).send({ eventId: ownEventId });
  expect(put.status).toBe(422);
  await db('event_customer_assignments').where({ event_id: ownEventId }).del();
});

test('the VAT code can be cleared back to a custom rate', async () => {
  const invoiceId = await scheduledInvoice();
  await db('invoices').where({ id: invoiceId }).update({ vat_code: 'UN81' });
  const cleared = await as(request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`)).send({ vatCode: null });
  expect(cleared.status).toBe(200);
  expect((await db('invoices').where({ id: invoiceId }).first()).vat_code).toBeNull();
});
