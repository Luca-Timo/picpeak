/**
 * Editing an invoice that is awaiting delivery.
 *
 * An `after_delivery` installment sits in `pending_delivery` until the admin
 * clicks "Mark delivered & send". Nothing has left the system in that state —
 * no PDF is rendered and the scheduler only picks up `scheduled` rows — so a
 * wrong date on it has to stay fixable. The PUT gate used to accept
 * `scheduled` only, which locked those rows with no way out short of cancel +
 * reissue. This pins both halves of the gate: pre-send rows save, issued rows
 * stay locked, and an edit never releases the invoice by accident.
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
let token;
let invoiceApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function enableFlag(key) {
  const updated = await db('feature_flags').where({ key }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key, value: true });
}

async function makeInvoice(status) {
  const created = await request(invoiceApp).post('/api/admin/invoices').set(auth).send({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    eventDate: '2026-10-03',
    lineItems: [{ position: 1, quantity: 1, description: 'Wedding coverage', unitPriceMinor: 200000, discountPercent: 0 }],
  });
  expect(created.status).toBe(201);
  const invoiceId = created.body.invoice.id;
  await db('invoices').where({ id: invoiceId }).update({ status, scheduled_send_at: null });
  return invoiceId;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  let adminId;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await enableFlag('bills');
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
}, 120000);

test('the activity feed resolves numbers the log entry only has as ids', async () => {
  const invoiceId = await makeInvoice('sent');
  const { invoice_number: invoiceNumber } = await db('invoices').where({ id: invoiceId }).first();
  const { withDocumentNumbers } = require('../../src/services/activityDocumentNumbers');

  const entries = await withDocumentNumbers([
    { metadata: { invoiceId } },
    { metadata: { originalInvoiceId: 1, newInvoiceId: invoiceId } },
    { metadata: { stornoId: invoiceId, stornoNumber: 'S-1' } },
    { metadata: { invoiceId, invoiceNumber: 'KEPT' } },
    { metadata: { quoteId: 999999 } },
    { metadata: { email: 'a@example.com' } },
  ]);

  expect(entries[0].metadata.invoiceNumber).toBe(invoiceNumber);
  expect(entries[1].metadata.invoiceNumber).toBe(invoiceNumber);
  expect(entries[2].metadata.invoiceNumber).toBe(invoiceNumber);
  expect(entries[3].metadata.invoiceNumber).toBe('KEPT');
  expect(entries[4].metadata.quoteNumber).toBe('#999999');
  expect(entries[5].metadata).toEqual({ email: 'a@example.com' });
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a pending_delivery invoice can still be edited and stays pending', async () => {
  const invoiceId = await makeInvoice('pending_delivery');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    eventDate: '2026-11-14',
    issueDate: '2026-11-14',
  });
  expect(saved.status).toBe(200);

  const after = await db('invoices').where({ id: invoiceId }).first();
  // The date landed...
  expect(String(after.event_date).slice(0, 10)).toBe('2026-11-14');
  // ...and the edit did not release the invoice: it is still waiting on the
  // admin, with no send date for the scheduler to act on.
  expect(after.status).toBe('pending_delivery');
  expect(after.scheduled_send_at).toBeFalsy();
});

test('a delivery invoice cannot pick up a send date', async () => {
  const invoiceId = await makeInvoice('pending_delivery');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    scheduledSendAt: '2026-12-01T09:00',
  });
  expect(saved.status).toBe(200);

  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(after.status).toBe('pending_delivery');
  expect(after.scheduled_send_at).toBeFalsy();
});

test('skonto can be disabled while awaiting delivery', async () => {
  const invoiceId = await makeInvoice('pending_delivery');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({ skontoDisabled: true });
  expect(saved.status).toBe(200);
  expect(saved.body.invoice.skontoDisabled).toBe(true);
});

test('a delivery invoice with a payment on it stays locked', async () => {
  const invoiceId = await makeInvoice('pending_delivery');
  await db('invoices').where({ id: invoiceId }).update({ paid_amount_minor: 50000 });

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    eventDate: '2026-11-14',
  });
  expect(saved.status).toBe(409);
  expect(saved.body.code).toBe('INVOICE_LOCKED');
});

test('an issued invoice stays locked', async () => {
  const invoiceId = await makeInvoice('sent');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    eventDate: '2026-11-14',
  });
  expect(saved.status).toBe(409);
  expect(saved.body.code).toBe('INVOICE_LOCKED');

  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(String(after.event_date).slice(0, 10)).toBe('2026-10-03');
});
