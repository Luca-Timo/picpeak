/**
 * Reissuing an accepted quote (#1451), like an invoice with its Storno.
 *
 * Real admin + public routes → quoteService → SQLite with the full
 * core-migration run (helpers/crmDb). Pins:
 *   - the accepted quote is declined with the admin's reason, its customer
 *     link stops working, its acceptance stays on record, and no email goes
 *     out;
 *   - a draft copy with the same lines and add-on choice replaces it, in the
 *     same deal, and both quotes name each other;
 *   - the reissued quote's PDF says which quote it replaces;
 *   - a reissued quote isn't sent again;
 *   - only an accepted quote without a contract, event or invoice can be
 *     reissued, or declined by the admin;
 *   - editing an accepted quote says to reissue it.
 */

const request = require('supertest');
const PDFKit = require('pdfkit');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, createPublicToken, buildRouteApp,
} = require('./helpers/crmDb');
const { isTruthyFlag } = require('../../src/utils/lineItemTotals');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;
let publicApp;
let adminApp;
let quoteService;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('quotes', true);
  quoteService = require('../../src/services/quoteService');
  publicApp = buildRouteApp('/api/public/quotes', require('../../src/routes/publicQuotes'));
  adminApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

// CHF 1000 wedding day, an album add-on (not booked) and a drone add-on
// (booked), accepted by the customer through their link.
async function acceptedQuote() {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: [
      { position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 },
      { position: 2, quantity: 1, description: 'Album', unit_price_minor: 30000, is_optional: true, selected: false },
      { position: 3, quantity: 1, description: 'Drone', unit_price_minor: 20000, is_optional: true, selected: true },
    ],
  }, adminId);
  await db('quotes').where({ id: quoteId }).update({ status: 'sent', sent_at: new Date().toISOString() });
  const link = await createPublicToken(db, 'quote_action_tokens', { quote_id: quoteId });
  const res = await request(publicApp).post(`/api/public/quotes/${link}/respond`)
    .send({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 });
  expect(res.status).toBe(200);
  return { quoteId, link };
}

test('reissuing declines the accepted quote and replaces it with a draft copy', async () => {
  const { quoteId, link } = await acceptedQuote();
  const before = await db('quotes').where({ id: quoteId }).first();
  const mails = (await db('email_queue')).length;

  const res = await request(adminApp).post(`/api/admin/quotes/${quoteId}/reissue`).set(auth)
    .send({ reason: 'Grösseres Album gewünscht' });
  expect(res.status).toBe(201);

  const old = await db('quotes').where({ id: quoteId }).first();
  expect(old.status).toBe('declined');
  expect(old.decline_reason).toBe('Grösseres Album gewünscht');
  // The acceptance stays on record.
  expect(old.accepted_at).toBeTruthy();
  expect(old.selection_accepted_at).toBeTruthy();
  // The customer's link no longer works, and nobody was emailed.
  const late = await request(publicApp).post(`/api/public/quotes/${link}/respond`)
    .send({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 });
  expect(late.status).toBe(410);
  expect(late.body.code).toBe('QUOTE_REPLACED');
  expect((await db('email_queue')).length).toBe(mails);

  const copy = await db('quotes').where({ id: res.body.quoteId }).first();
  expect(copy).toEqual(expect.objectContaining({
    status: 'draft', replaces_quote_id: quoteId, deal_uuid: before.deal_uuid, customer_account_id: customerId,
  }));
  expect(copy.quote_number).not.toBe(old.quote_number);
  const lines = await db('quote_line_items').where({ quote_id: copy.id }).orderBy('position', 'asc');
  expect(lines.map((l) => l.description)).toEqual(['Wedding day', 'Album', 'Drone']);
  expect(lines.map((l) => isTruthyFlag(l.selected))).toEqual([true, false, true]);

  // Both quotes name each other.
  const oldView = await request(adminApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
  expect(oldView.body.quote).toEqual(expect.objectContaining({
    replacedByQuoteId: copy.id, replacedByQuoteNumber: copy.quote_number, replacesQuoteId: null,
  }));
  const newView = await request(adminApp).get(`/api/admin/quotes/${copy.id}`).set(auth);
  expect(newView.body.quote).toEqual(expect.objectContaining({
    replacesQuoteId: quoteId, replacesQuoteNumber: old.quote_number, replacedByQuoteId: null,
  }));
});

test('a reissued quote isn\'t sent again: the quote that replaced it is', async () => {
  const { quoteId } = await acceptedQuote();
  await quoteService.reissueQuote(quoteId, adminId);
  await expect(quoteService.sendQuote(quoteId, adminId))
    .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_REPLACED' });
});

test('the reissued quote\'s PDF says which quote it replaces', async () => {
  const { quoteId } = await acceptedQuote();
  const old = await db('quotes').where({ id: quoteId }).first();
  const { quoteId: newId } = await quoteService.reissueQuote(quoteId, adminId);

  const texts = jest.spyOn(PDFKit.prototype, 'text');
  await quoteService.getQuotePdfBuffer(newId);
  const drawn = texts.mock.calls.map((c) => String(c[0]));
  texts.mockRestore();
  expect(drawn.some((t) => new RegExp(`(Ersetzt|Replaces) \\S+ ${old.quote_number}`).test(t))).toBe(true);
});

test('only an accepted quote without a contract, event or invoice can be reissued', async () => {
  const draftId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Portrait', unit_price_minor: 50000 }],
  }, adminId);
  const early = await request(adminApp).post(`/api/admin/quotes/${draftId}/reissue`).set(auth).send({});
  expect(early.status).toBe(409);
  expect(early.body.code).toBe('QUOTE_NOT_ACCEPTED');

  const { quoteId } = await acceptedQuote();
  await db('quotes').where({ id: quoteId }).update({ converted_event_id: 999999 });
  const late = await request(adminApp).post(`/api/admin/quotes/${quoteId}/reissue`).set(auth).send({});
  expect(late.status).toBe(409);
  expect(late.body.code).toBe('QUOTE_CONVERTED');
  expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('accepted');
  expect(await db('quotes').where({ replaces_quote_id: quoteId })).toHaveLength(0);
});

test('the admin can decline an accepted quote until a contract, event or invoice exists', async () => {
  const { quoteId } = await acceptedQuote();
  const res = await request(adminApp).post(`/api/admin/quotes/${quoteId}/decline`).set(auth)
    .send({ reason: 'Kunde hat abgesagt' });
  expect(res.status).toBe(200);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote.status).toBe('declined');
  expect(quote.decline_reason).toBe('Kunde hat abgesagt');
  // The acceptance stays on record; no copy is made.
  expect(quote.accepted_at).toBeTruthy();
  expect(await db('quotes').where({ replaces_quote_id: quoteId })).toHaveLength(0);

  const { quoteId: madeId } = await acceptedQuote();
  await db('quotes').where({ id: madeId }).update({ converted_contract_id: 999999 });
  const late = await request(adminApp).post(`/api/admin/quotes/${madeId}/decline`).set(auth).send({});
  expect(late.status).toBe(409);
  expect(late.body.code).toBe('QUOTE_CONVERTED');
  expect((await db('quotes').where({ id: madeId }).first()).status).toBe('accepted');
});

test('editing an accepted quote says to reissue it', async () => {
  const { quoteId } = await acceptedQuote();
  const res = await request(adminApp).put(`/api/admin/quotes/${quoteId}`).set(auth).send({ eventName: 'Changed' });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('QUOTE_LOCKED');
  expect(res.body.error).toMatch(/Reissue it/);
});
