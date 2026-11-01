/**
 * Customer gifts and gift stock (migration 343), through the real admin router
 * so the flag, permission and validation layers are part of what is pinned.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let app;
let superToken;
let viewerToken;
let invalidateFeatureFlagCache;
let seq = 0;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
const bodyOf = (res) => res.body.data || res.body;
const api = (path) => `/api/admin/gifts${path}`;
const post = (path, body = {}, token = superToken) => request(app).post(api(path)).set(auth(token)).send(body);
const get = (path, token = superToken) => request(app).get(api(path)).set(auth(token));

const setFlag = async (key, value) => {
  await db('feature_flags').where({ key }).del();
  await db('feature_flags').insert({ key, value });
  invalidateFeatureFlagCache();
};

async function createCustomer(fields = {}) {
  seq += 1;
  return idOf(await db('customer_accounts').insert({
    email: `gifts-${seq}@example.com`,
    display_name: `Customer ${seq}`,
    is_active: true,
    created_at: new Date().toISOString(),
    ...fields,
  }).returning('id'));
}

const yearsAgo = (years, days = 0) => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  date.setDate(date.getDate() - days);
  return date.toISOString();
};

let invoiceSeq = 0;
async function paidInvoice(customerId, paidAt, fields = {}) {
  invoiceSeq += 1;
  return idOf(await db('invoices').insert({
    invoice_number: `GIFT-${invoiceSeq}`,
    customer_account_id: customerId,
    status: 'paid',
    kind: 'invoice',
    currency: 'CHF',
    issue_date: paidAt.slice(0, 10),
    due_date: paidAt.slice(0, 10),
    total_amount_minor: 10000,
    paid_at: paidAt,
    ...fields,
  }).returning('id'));
}

async function createItem(name = 'Wine', quantity = 0) {
  const item = bodyOf(await post('/items', { name })).item;
  if (quantity) await post(`/items/${item.id}/stock`, { quantity, unitCostMinor: 1500 });
  return item;
}

const stockOf = async (id) => {
  const { items } = bodyOf(await get('/items?includeArchived=true'));
  return items.find((item) => item.id === id).stock;
};

/** Three bookings over three years, the last recent. */
async function dueCustomer() {
  const id = await createCustomer();
  await paidInvoice(id, yearsAgo(3, 10));
  await paidInvoice(id, yearsAgo(2));
  await paidInvoice(id, yearsAgo(0, 30));
  return id;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag'));
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  superToken = mintAdminToken(adminId);
  const [viewer] = await db('admin_users').insert({
    username: 'gift-viewer', email: 'gift-viewer@example.com', password_hash: 'x',
  }).returning('id');
  const viewerId = viewer?.id ?? viewer;
  await assignAdminRole(db, viewerId, 'viewer').catch(() => {});
  viewerToken = mintAdminToken(viewerId);
  app = buildRouteApp('/api/admin/gifts', require('../../src/routes/adminGifts'));
  await setFlag('customerGifts', true);
});
afterAll(async () => { if (cleanup) await cleanup(); });

describe('access', () => {
  it('answers 403 on every route while the flag is off', async () => {
    await setFlag('customerGifts', false);
    const res = await get('/suggestions');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CUSTOMER_GIFTS_DISABLED');
    expect((await post('/items', { name: 'x' })).status).toBe(403);
    await setFlag('customerGifts', true);
  });

  it('refuses without a token and without the permission', async () => {
    expect((await request(app).get(api('/suggestions'))).status).toBe(401);
    expect((await get('/suggestions', viewerToken)).status).toBe(403);
    expect((await post('/items', { name: 'x' }, viewerToken)).status).toBe(403);
  });
});

describe('stock', () => {
  it('adds stock, gives, undoes and corrects, and the count follows', async () => {
    const item = await createItem('Merlot', 5);
    const customer = await createCustomer();
    expect(await stockOf(item.id)).toBe(5);

    const given = bodyOf(await post(`/customers/${customer}/gifts`, { giftItemId: item.id, note: 'thank you' }));
    expect(await stockOf(item.id)).toBe(4);
    expect(given.gifts[0]).toMatchObject({ status: 'given', unitCostMinor: 1500, currency: 'CHF', note: 'thank you' });

    await post(`/${given.gifts[0].id}/undo`);
    expect(await stockOf(item.id)).toBe(5);

    await post(`/items/${item.id}/corrections`, { quantityDelta: -2, reason: '2 bottles broken' });
    expect(await stockOf(item.id)).toBe(3);

    const { movements } = bodyOf(await get(`/items/${item.id}/movements`));
    expect(movements.map((m) => m.kind).sort()).toEqual(['correction', 'gift', 'gift_undone', 'purchase']);
  });

  it('refuses a gift at zero stock and a correction below zero', async () => {
    const item = await createItem('Empty');
    const customer = await createCustomer();
    const res = await post(`/customers/${customer}/gifts`, { giftItemId: item.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GIFT_OUT_OF_STOCK');
    expect((await post(`/items/${item.id}/corrections`, { quantityDelta: -1, reason: 'x' })).body.code)
      .toBe('GIFT_STOCK_NEGATIVE');
  });

  it('lets two gifts race for the last unit and only one wins', async () => {
    const item = await createItem('Last', 1);
    const [a, b] = [await createCustomer(), await createCustomer()];
    const results = await Promise.all([
      post(`/customers/${a}/gifts`, { giftItemId: item.id }),
      post(`/customers/${b}/gifts`, { giftItemId: item.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stockOf(item.id)).toBe(0);
  });

  it('records a past gift without touching stock', async () => {
    const item = await createItem('Old', 1);
    const customer = await createCustomer();
    expect((await post(`/customers/${customer}/gifts`, {
      giftItemId: item.id, reduceStock: false, giftDate: '2020-05-01',
    })).status).toBe(201);
    expect(await stockOf(item.id)).toBe(1);
    const { gifts } = bodyOf(await get(`/customers/${customer}`));
    expect(gifts[0].giftDate).toBe('2020-05-01');
  });

  it('links a supplier invoice only with incoming invoices on and accounting access', async () => {
    const item = await createItem('Invoiced');
    const [doc] = await db('inbound_documents').insert({ supplier_name: 'Wine shop', currency: 'EUR' }).returning('id');
    const documentId = doc?.id ?? doc;
    const body = { quantity: 6, unitCostMinor: 1200, inboundDocumentId: documentId };

    await setFlag('incomingInvoices', false);
    const refused = await post(`/items/${item.id}/stock`, body);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('GIFT_INVOICE_FORBIDDEN');
    expect(await stockOf(item.id)).toBe(0);

    await setFlag('incomingInvoices', true);
    const res = await post(`/items/${item.id}/stock`, body);
    expect(res.status).toBe(201);
    expect(bodyOf(res).movement).toMatchObject({ inboundDocumentId: documentId, currency: 'EUR' });
    expect((await post(`/items/${item.id}/stock`, { ...body, inboundDocumentId: 999999 })).status).toBe(404);
  });

  it('refuses an archived item for a new gift', async () => {
    const item = await createItem('Retired', 1);
    await request(app).patch(api(`/items/${item.id}`)).set(auth(superToken)).send({ isArchived: true });
    const customer = await createCustomer();
    expect((await post(`/customers/${customer}/gifts`, { giftItemId: item.id })).body.code).toBe('GIFT_ITEM_ARCHIVED');
  });
});

describe('suggestions', () => {
  const find = (list, id) => list.find((row) => row.customerId === id);

  it('lists a qualifying customer as due and closes the milestone on a gift', async () => {
    const customer = await dueCustomer();
    const item = await createItem('Due item', 2);
    const { due } = bodyOf(await get('/suggestions'));
    expect(find(due, customer)).toMatchObject({ milestoneYears: 3, bookingCount: 3 });

    await post(`/customers/${customer}/gifts`, { giftItemId: item.id, milestoneYears: 3 });
    expect(find(bodyOf(await get('/suggestions')).due, customer)).toBeUndefined();

    const twice = await post(`/customers/${customer}/gifts`, { giftItemId: item.id, milestoneYears: 3 });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('GIFT_MILESTONE_CLOSED');
    expect(await stockOf(item.id)).toBe(1);
  });

  it('ignores Storno rows and cancelled originals', async () => {
    const customer = await createCustomer();
    await paidInvoice(customer, yearsAgo(3, 100));
    await paidInvoice(customer, yearsAgo(2));
    await paidInvoice(customer, yearsAgo(0, 30), { status: 'cancelled' });
    await paidInvoice(customer, yearsAgo(0, 20), { kind: 'storno' });
    const { notQualified } = bodyOf(await get('/suggestions'));
    expect(find(notQualified, customer)).toMatchObject({ bookingCount: 2, reason: 'too_few_bookings' });
  });

  it('declines one milestone, and undo reopens it', async () => {
    const customer = await dueCustomer();
    const declined = bodyOf(await post(`/customers/${customer}/declines`, { milestoneYears: 3, note: 'asked for none' }));
    expect(declined.gifts[0]).toMatchObject({ status: 'declined', giftItemId: null });
    expect(find(bodyOf(await get('/suggestions')).due, customer)).toBeUndefined();
    await post(`/${declined.gifts[0].id}/undo`);
    expect(find(bodyOf(await get('/suggestions')).due, customer)).toBeDefined();
    expect((await post(`/${declined.gifts[0].id}/undo`)).body.code).toBe('GIFT_ALREADY_UNDONE');
  });

  it('marks a gift anyway, and hides a no-gifts customer', async () => {
    const customer = await createCustomer();
    await paidInvoice(customer, yearsAgo(3, 100));
    const item = await createItem('Override', 1);
    expect(find(bodyOf(await get('/suggestions')).notQualified, customer)).toBeDefined();
    const { gifts } = bodyOf(await post(`/customers/${customer}/gifts`, { giftItemId: item.id, milestoneYears: 3, isOverride: true }));
    expect(gifts[0].isOverride).toBe(true);

    const other = await dueCustomer();
    await request(app).patch(api(`/customers/${other}`)).set(auth(superToken)).send({ noGifts: true });
    expect(find(bodyOf(await get('/suggestions')).due, other)).toBeUndefined();
  });

  it('keeps changed rules', async () => {
    const res = await request(app).put(api('/rules')).set(auth(superToken))
      .send({ activityPeriodYears: 3, milestoneYears: [10, 3, 3] });
    expect(bodyOf(res).rules).toMatchObject({ activityPeriodYears: 3, milestoneYears: [3, 10], minBookings: 3 });
    expect(bodyOf(await get('/rules')).rules.activityPeriodYears).toBe(3);
    await request(app).put(api('/rules')).set(auth(superToken)).send({ activityPeriodYears: 1, milestoneYears: [3, 5, 10] });
  });
});

describe('customer erasure', () => {
  it('clears gift notes and keeps the stock count', async () => {
    const item = await createItem('Erased', 3);
    const customer = await createCustomer({ gift_start_date_override: '2020-01-01' });
    await post(`/customers/${customer}/gifts`, { giftItemId: item.id, note: 'Loves Barolo' });
    await require('../../src/services/customerAccountsService').eraseCustomer(customer, null);
    const [row] = await db('customer_gifts').where({ customer_account_id: customer });
    expect(row.note).toBeNull();
    expect(await stockOf(item.id)).toBe(2);
    const account = await db('customer_accounts').where({ id: customer }).first();
    expect(account.gift_start_date_override).toBeNull();
    expect((bodyOf(await get('/suggestions')).notQualified).find((r) => r.customerId === customer)).toBeUndefined();
  });
});
