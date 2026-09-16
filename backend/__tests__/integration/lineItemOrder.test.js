/**
 * Line-item order persistence — integration tests.
 *
 * `LineItemsTable` keeps `position` as a stable row id ("once assigned at row
 * creation we never renumber it") and `move()` only reorders the array, so the
 * editors post the row's original position back on save. The service stored it
 * verbatim and the detail endpoints read the items back `ORDER BY position`,
 * which is why a reorder looked right in the editor and came back in the
 * original order after a reload.
 *
 * These tests drive the real HTTP route → service → SQLite pipeline and pin
 * that the order the editor sent is the order that is stored, for quotes and
 * for invoices, with a moved parent keeping its sub-items.
 *
 * Real SQLite with the full core-migration run (helpers/crmDb). No PDF
 * rendering: the PDF and the customer page both read the stored order, so the
 * round-trip through getQuoteById / getInvoiceById is the contract under test.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

// Full migration run + cold-requiring the CRM services is slow under CI load;
// matches the other CRM integration suites.
jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;
let quoteApp;
let invoiceApp;

const prevCwd = process.cwd();

const auth = { get Authorization() { return `Bearer ${token}`; } };

const descriptionsOf = (body) => body.lineItems.map((li) => li.description);
const positionsOf = (body) => body.lineItems.map((li) => li.position);

async function enableFlag(key) {
  const updated = await db('feature_flags').where({ key }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key, value: true });
}

/**
 * Create a draft quote through the admin route so the payload goes through the
 * same mapping the editor uses. Returns the new quote id.
 */
async function createQuote(lineItems) {
  const res = await request(quoteApp).post('/api/admin/quotes').set(auth).send({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    lineItems,
  });
  expect(res.status).toBe(201);
  return res.body.quote.id;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  // Business-doc storage paths are anchored under process.cwd() — chdir into
  // the temp dir so nothing escapes the suite.
  process.chdir(tmpDir);
  // Same swallowed logActivity-inside-transaction stall the other CRM
  // integration suites shrink: 2s instead of the 60s acquire timeout.
  db.client.pool.acquireTimeoutMillis = 2000;

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);

  // CRM surfaces are feature-flagged; migration 107 seeds them off.
  await enableFlag('quotes');
  await enableFlag('bills');

  quoteApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('PUT /api/admin/quotes/:id — line-item order', () => {
  test('a reordered quote keeps the new order after a reload', async () => {
    const quoteId = await createQuote([
      { position: 1, quantity: 1, description: 'Studio shooting', unitPriceMinor: 100000, discountPercent: 0 },
      { position: 2, quantity: 1, description: 'Album', unitPriceMinor: 50000, discountPercent: 0 },
    ]);

    // The editor's arrows only reorder the array — the row ids travel back
    // unchanged, which is exactly what used to lose the reorder.
    const saved = await request(quoteApp)
      .put(`/api/admin/quotes/${quoteId}`)
      .set(auth)
      .send({
        lineItems: [
          { position: 2, quantity: 1, description: 'Album', unitPriceMinor: 50000, discountPercent: 0 },
          { position: 1, quantity: 1, description: 'Studio shooting', unitPriceMinor: 100000, discountPercent: 0 },
        ],
      });
    expect(saved.status).toBe(200);

    const reloaded = await request(quoteApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
    expect(reloaded.status).toBe(200);
    expect(descriptionsOf(reloaded.body)).toEqual(['Album', 'Studio shooting']);
    expect(positionsOf(reloaded.body)).toEqual([1, 2]);
  });

  test('a moved parent carries its sub-items and the parent links survive', async () => {
    const quoteId = await createQuote([
      { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 120000, discountPercent: 0 },
      { position: 2, quantity: 1, description: 'Camera', unitPriceMinor: 30000, discountPercent: 0, parentPosition: 1 },
      { position: 3, quantity: 1, description: 'Travel', unitPriceMinor: 20000, discountPercent: 0 },
    ]);

    // 'Package' moves below 'Travel'; its sub-item follows it in the array
    // and still names row id 1 as its parent.
    const saved = await request(quoteApp)
      .put(`/api/admin/quotes/${quoteId}`)
      .set(auth)
      .send({
        lineItems: [
          { position: 3, quantity: 1, description: 'Travel', unitPriceMinor: 20000, discountPercent: 0 },
          { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 120000, discountPercent: 0 },
          { position: 2, quantity: 1, description: 'Camera', unitPriceMinor: 30000, discountPercent: 0, parentPosition: 1 },
        ],
      });
    expect(saved.status).toBe(200);

    const reloaded = await request(quoteApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
    expect(reloaded.status).toBe(200);
    expect(descriptionsOf(reloaded.body)).toEqual(['Travel', 'Package', 'Camera']);
    expect(positionsOf(reloaded.body)).toEqual([1, 2, 3]);
    // 'Camera' is still the child of 'Package', at its new position.
    expect(reloaded.body.lineItems[2].parentPosition).toBe(2);
    expect(reloaded.body.lineItems[2].parentLineItemId).toBe(reloaded.body.lineItems[1].id);
  });

  test('reordering sub-items inside one parent persists', async () => {
    const quoteId = await createQuote([
      { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 120000, discountPercent: 0 },
      { position: 2, quantity: 1, description: 'Camera', unitPriceMinor: 30000, discountPercent: 0, parentPosition: 1 },
      { position: 3, quantity: 1, description: 'Lens', unitPriceMinor: 40000, discountPercent: 0, parentPosition: 1 },
    ]);

    const saved = await request(quoteApp)
      .put(`/api/admin/quotes/${quoteId}`)
      .set(auth)
      .send({
        lineItems: [
          { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 120000, discountPercent: 0 },
          { position: 3, quantity: 1, description: 'Lens', unitPriceMinor: 40000, discountPercent: 0, parentPosition: 1 },
          { position: 2, quantity: 1, description: 'Camera', unitPriceMinor: 30000, discountPercent: 0, parentPosition: 1 },
        ],
      });
    expect(saved.status).toBe(200);

    const reloaded = await request(quoteApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
    expect(descriptionsOf(reloaded.body)).toEqual(['Package', 'Lens', 'Camera']);
    expect(reloaded.body.lineItems[1].parentPosition).toBe(1);
    expect(reloaded.body.lineItems[2].parentPosition).toBe(1);
  });

  test('a sub-item added after its parent is stored under that parent', async () => {
    // addSubItem numbers a new row max + 1, so a sub-item added later to the
    // first parent posts as [Package(1), Camera(3, parent 1), Travel(2)]. The
    // PDF groups rows by array order, so Camera used to print under Travel.
    const quoteId = await createQuote([
      { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 120000, discountPercent: 0 },
      { position: 2, quantity: 1, description: 'Travel', unitPriceMinor: 20000, discountPercent: 0 },
    ]);

    const saved = await request(quoteApp).put(`/api/admin/quotes/${quoteId}`).set(auth).send({
      lineItems: [
        { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 120000, discountPercent: 0 },
        { position: 3, quantity: 1, description: 'Camera', unitPriceMinor: 30000, discountPercent: 0, parentPosition: 1 },
        { position: 2, quantity: 1, description: 'Travel', unitPriceMinor: 20000, discountPercent: 0 },
      ],
    });
    expect(saved.status).toBe(200);

    const reloaded = await request(quoteApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
    expect(descriptionsOf(reloaded.body)).toEqual(['Package', 'Camera', 'Travel']);
    expect(positionsOf(reloaded.body)).toEqual([1, 2, 3]);
    expect(reloaded.body.lineItems[1].parentPosition).toBe(1);
    expect(reloaded.body.lineItems[1].parentLineItemId).toBe(reloaded.body.lineItems[0].id);
  });

  test('an ambiguous payload is still refused instead of renumbered', async () => {
    // Renumbering makes positions unique and can move a parent number onto a
    // different row, so it must not run on a payload the hierarchy validation
    // would reject: these three stay 400.
    const quoteId = await createQuote([
      { position: 1, quantity: 1, description: 'A', unitPriceMinor: 10000, discountPercent: 0 },
    ]);
    const put = (lineItems) => request(quoteApp).put(`/api/admin/quotes/${quoteId}`).set(auth).send({ lineItems });

    const duplicate = await put([
      { position: 1, quantity: 1, description: 'P1', unitPriceMinor: 10000, discountPercent: 0 },
      { position: 2, quantity: 1, description: 'S', unitPriceMinor: 5000, discountPercent: 0, parentPosition: 1 },
      { position: 1, quantity: 1, description: 'P1dup', unitPriceMinor: 10000, discountPercent: 0 },
    ]);
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe('LINE_ITEM_POSITION_DUPLICATE');

    // The missing parent number (2) is inside 1..n, so renumbering would have
    // handed the sub-item to whichever row landed on 2.
    const missingParent = await put([
      { position: 10, quantity: 1, description: 'A', unitPriceMinor: 10000, discountPercent: 0 },
      { position: 20, quantity: 1, description: 'B', unitPriceMinor: 10000, discountPercent: 0 },
      { position: 30, quantity: 1, description: 'C', unitPriceMinor: 10000, discountPercent: 0, parentPosition: 2 },
    ]);
    expect(missingParent.status).toBe(400);
    expect(missingParent.body.code).toBe('LINE_ITEM_PARENT_NOT_FOUND');

    const tooDeep = await put([
      { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 10000, discountPercent: 0 },
      { position: 2, quantity: 1, description: 'Camera', unitPriceMinor: 5000, discountPercent: 0, parentPosition: 1 },
      { position: 3, quantity: 1, description: 'Lens hood', unitPriceMinor: 1000, discountPercent: 0, parentPosition: 2 },
    ]);
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.body.code).toBe('LINE_ITEM_NESTING_TOO_DEEP');
  });
});

describe('PUT /api/admin/invoices/:id — line-item order', () => {
  test('an out-of-order payload is stored in array order at create time', async () => {
    const created = await request(invoiceApp).post('/api/admin/invoices').set(auth).send({
      customerAccountId: customerId,
      currency: 'CHF',
      vatRate: 0,
      lineItems: [
        { position: 3, quantity: 1, description: 'Album', unitPriceMinor: 60000, discountPercent: 0 },
        { position: 1, quantity: 1, description: 'Wedding coverage', unitPriceMinor: 200000, discountPercent: 0 },
      ],
    });
    expect(created.status).toBe(201);

    const reloaded = await request(invoiceApp).get(`/api/admin/invoices/${created.body.invoice.id}`).set(auth);
    expect(reloaded.status).toBe(200);
    expect(descriptionsOf(reloaded.body)).toEqual(['Album', 'Wedding coverage']);
    expect(positionsOf(reloaded.body)).toEqual([1, 2]);
  });

  test('a reordered invoice keeps the new order after a reload', async () => {
    const created = await request(invoiceApp).post('/api/admin/invoices').set(auth).send({
      customerAccountId: customerId,
      currency: 'CHF',
      vatRate: 0,
      lineItems: [
        { position: 1, quantity: 1, description: 'Wedding coverage', unitPriceMinor: 200000, discountPercent: 0 },
        { position: 2, quantity: 1, description: 'Album', unitPriceMinor: 60000, discountPercent: 0 },
      ],
    });
    expect(created.status).toBe(201);
    const invoiceId = created.body.invoice.id;

    const saved = await request(invoiceApp)
      .put(`/api/admin/invoices/${invoiceId}`)
      .set(auth)
      .send({
        lineItems: [
          { position: 2, quantity: 1, description: 'Album', unitPriceMinor: 60000, discountPercent: 0 },
          { position: 1, quantity: 1, description: 'Wedding coverage', unitPriceMinor: 200000, discountPercent: 0 },
        ],
      });
    expect(saved.status).toBe(200);

    const reloaded = await request(invoiceApp).get(`/api/admin/invoices/${invoiceId}`).set(auth);
    expect(reloaded.status).toBe(200);
    expect(descriptionsOf(reloaded.body)).toEqual(['Album', 'Wedding coverage']);
    expect(positionsOf(reloaded.body)).toEqual([1, 2]);
  });
});
