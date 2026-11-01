/**
 * Editing an invoice that is awaiting delivery.
 *
 * An `after_delivery` installment sits in `pending_delivery` until the admin
 * clicks "Mark delivered & send". The customer and the books do not see it
 * in that state and the scheduler only picks up `scheduled` rows, so it has
 * to stay fixable without a Storno. This pins the gate (pre-send rows save,
 * issued rows stay locked, an edit never releases the invoice), the
 * visibility that makes it safe, and what marking delivered does to the dates.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { toDateOnly } = require('../../src/utils/dateOnly');
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
let adminId;

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
  expect(toDateOnly(after.event_date)).toBe('2026-11-14');
  // ...and the edit did not release the invoice: it is still waiting on the
  // admin, with no send date for the scheduler to act on.
  expect(after.status).toBe('pending_delivery');
  expect(after.scheduled_send_at).toBeFalsy();
});

test('a delivery invoice refuses a send date instead of dropping it', async () => {
  const invoiceId = await makeInvoice('pending_delivery');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    scheduledSendAt: '2026-12-01T09:00',
  });
  expect(saved.status).toBe(409);
  expect(saved.body.code).toBe('INVOICE_SENDS_ON_DELIVERY');

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

test('marking delivered re-anchors a machine-set due date and mails it unformatted', async () => {
  const invoiceId = await makeInvoice('pending_delivery');
  const issueDate = '2030-01-15';
  await db('invoices').where({ id: invoiceId }).update({ issue_date: issueDate, due_date: '2030-02-14' });

  const released = await request(invoiceApp).post(`/api/admin/invoices/${invoiceId}/release-for-delivery`).set(auth).send({});
  expect(released.status).toBe(200);

  const after = await db('invoices').where({ id: invoiceId }).first();
  const days = Math.round((Date.parse(toDateOnly(after.due_date)) - Date.parse(toDateOnly(after.issue_date))) / 86400000);
  expect(days).toBe(30);
  expect(toDateOnly(after.due_date)).not.toBe('2030-02-14');

  const mail = await db('email_queue').where({ email_type: 'invoice_sent' }).orderBy('id', 'desc').first();
  const data = typeof mail.email_data === 'string' ? JSON.parse(mail.email_data) : mail.email_data;
  expect(data.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('marking delivered keeps a due date an admin set by hand', async () => {
  const invoiceId = await makeInvoice('pending_delivery');
  await db('invoices').where({ id: invoiceId }).update({ issue_date: '2030-01-15', due_date: '2030-06-30' });

  const released = await request(invoiceApp).post(`/api/admin/invoices/${invoiceId}/release-for-delivery`).set(auth).send({});
  expect(released.status).toBe(200);

  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(toDateOnly(after.due_date)).toBe('2030-06-30');
});

test('a scheduled invoice with a payment on it stays locked too', async () => {
  const invoiceId = await makeInvoice('scheduled');
  await db('invoices').where({ id: invoiceId }).update({ paid_amount_minor: 50000 });

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({ skontoDisabled: true });
  expect(saved.status).toBe(409);
  expect(saved.body.code).toBe('INVOICE_LOCKED');
});

test('a plan cannot be reshaped over a payment', async () => {
  const invoiceService = require('../../src/services/invoiceService');
  const invoiceId = await makeInvoice('pending_delivery');
  await db('invoices').where({ id: invoiceId }).update({ paid_amount_minor: 50000, installment_total: 2 });
  const { deal_uuid: dealUuid } = await db('invoices').where({ id: invoiceId }).first();

  await expect(db.transaction((trx) => invoiceService.updateInstallmentPlan({
    trx,
    dealUuid,
    installments: [{ label: 'Full', percent: 100, trigger: 'after_delivery', offset_days: 0 }],
    adminId,
  }))).rejects.toMatchObject({ code: 'INVOICE_LOCKED' });
});

test('cancelling a delivery invoice takes no Storno, since nothing was issued', async () => {
  const invoiceService = require('../../src/services/invoiceService');
  const invoiceId = await makeInvoice('pending_delivery');
  const before = await db('invoices').where({ kind: 'storno' }).count('id as c').first();

  const result = await invoiceService.cancelInvoice(invoiceId, adminId);

  expect(result).toEqual({ cancelled: true, stornoId: null });
  const after = await db('invoices').where({ kind: 'storno' }).count('id as c').first();
  expect(Number(after.c)).toBe(Number(before.c));
});

test('the customer sees a delivery invoice only once it is sent', async () => {
  const jwt = require('jsonwebtoken');
  const customerApp = express();
  customerApp.use(express.json());
  customerApp.use(cookieParser());
  customerApp.use('/api/customer', require('../../src/routes/customer'));
  await db('customer_accounts').where({ id: customerId }).update({ feature_bills: true });
  const billsSwitch = { setting_key: 'customer_feature_bills_enabled' };
  const switched = await db('app_settings').where(billsSwitch).update({ setting_value: 'true' });
  if (!switched) await db('app_settings').insert({ ...billsSwitch, setting_value: 'true', setting_type: 'customer_surface' });
  const session = jwt.sign(
    { type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  const asCustomer = (req) => req.set('Cookie', `customer_token=${session}`);
  const invoiceId = await makeInvoice('pending_delivery');

  const listed = async () => {
    const res = await asCustomer(request(customerApp).get('/api/customer/invoices'));
    expect(res.status).toBe(200);
    return res.body;
  };
  expect(JSON.stringify(await listed())).not.toContain(`"id":${invoiceId},`);
  const pdf = await asCustomer(request(customerApp).get(`/api/customer/invoices/${invoiceId}/pdf`));
  expect(pdf.status).toBe(404);

  await db('invoices').where({ id: invoiceId }).update({ status: 'sent' });
  expect(JSON.stringify(await listed())).toContain(`"id":${invoiceId},`);
});

test('the ledger books a delivery invoice only once it is sent', async () => {
  const ledgerService = require('../../src/services/ledgerService');
  const invoiceId = await makeInvoice('pending_delivery');
  const row = await db('invoices').where({ id: invoiceId }).first();
  const day = toDateOnly(row.issue_date);
  const posted = async () => {
    const postings = await ledgerService.buildPostings({ from: day, to: day, currency: 'CHF' });
    return JSON.stringify(postings).includes(row.invoice_number);
  };

  expect(await posted()).toBe(false);
  await db('invoices').where({ id: invoiceId }).update({ status: 'sent' });
  expect(await posted()).toBe(true);
});

test('an issued invoice stays locked', async () => {
  const invoiceId = await makeInvoice('sent');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    eventDate: '2026-11-14',
  });
  expect(saved.status).toBe(409);
  expect(saved.body.code).toBe('INVOICE_LOCKED');

  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(toDateOnly(after.event_date)).toBe('2026-10-03');
});
