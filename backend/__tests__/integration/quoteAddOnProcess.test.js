/**
 * The add-on process around a quote (#1451).
 *
 * Real public + admin routes → quoteService → SQLite with the full
 * core-migration run (helpers/crmDb). Pins:
 *   - the quote email says when there are add-ons to choose;
 *   - the PDF lists every add-on, marked booked or not in the total;
 *   - the customer's message is stored with the acceptance and reaches the
 *     business in the "quote accepted" notice with the booked add-ons;
 *   - the business can change the add-ons of an accepted quote until a
 *     contract, event or invoice exists: recorded, re-rendered, and the
 *     customer is emailed the updated quote;
 *   - a stored default email template is brought up to date, an edited one
 *     is left alone.
 */

const request = require('supertest');
const PDFKit = require('pdfkit');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, createPublicToken, buildRouteApp,
} = require('./helpers/crmDb');

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

async function lastMail(type, to) {
  const row = await db('email_queue').where({ email_type: type, recipient_email: to }).orderBy('id', 'desc').first();
  return row ? JSON.parse(row.email_data) : null;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('quotes', true);
  const profile = await db('business_profile').where({ id: 1 }).first();
  if (profile) await db('business_profile').where({ id: 1 }).update({ email: 'studio@example.com', company_name: 'Studio Test' });
  else await db('business_profile').insert({ id: 1, email: 'studio@example.com', company_name: 'Studio Test' });
  quoteService = require('../../src/services/quoteService');
  publicApp = buildRouteApp('/api/public/quotes', require('../../src/routes/publicQuotes'));
  adminApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

// CHF 1000 wedding day; an album add-on (CHF 300, not booked); a drone
// add-on (CHF 200, booked); no VAT.
async function quoteWithAddOns() {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: [
      { position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 },
      { position: 2, quantity: 1, description: 'Album', unit_price_minor: 30000, is_optional: true, selected: false },
      { position: 3, quantity: 1, description: 'Drone', unit_price_minor: 20000, is_optional: true, selected: true },
    ],
  }, adminId);
  return quoteId;
}

async function sentQuote() {
  const quoteId = await quoteWithAddOns();
  await db('quotes').where({ id: quoteId }).update({ status: 'sent', sent_at: new Date() });
  const link = await createPublicToken(db, 'quote_action_tokens', { quote_id: quoteId });
  return { quoteId, link };
}

test('the quote email says when there are add-ons to choose', async () => {
  const quoteId = await quoteWithAddOns();
  await quoteService.sendQuote(quoteId, adminId);
  const customer = await db('customer_accounts').where({ id: customerId }).first();
  expect(await lastMail('quote_sent', customer.email)).toEqual(expect.objectContaining({ has_add_ons: true }));
});

test('the PDF lists every add-on, marked booked or not in the total', async () => {
  const quoteId = await quoteWithAddOns();
  const texts = jest.spyOn(PDFKit.prototype, 'text');
  await quoteService.getQuotePdfBuffer(quoteId);
  const drawn = texts.mock.calls.map((c) => String(c[0]));
  texts.mockRestore();
  expect(drawn).toEqual(expect.arrayContaining(['Album', 'Drone']));
  expect(drawn.some((t) => t.includes('nicht gebucht') || t.includes('not booked'))).toBe(true);
  expect(drawn.some((t) => /gebucht$|booked$/.test(t) && !t.includes('nicht') && !t.includes('not'))).toBe(true);
});

test('the PDF preview of unsaved lines marks each add-on as the editor shows it', async () => {
  // Unsaved lines have no ids; the booked / not booked marks must still follow each line.
  const texts = jest.spyOn(PDFKit.prototype, 'text');
  const res = await request(adminApp).post('/api/admin/quotes/preview').set(auth).send({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, language: 'de',
    lineItems: [
      { position: 1, quantity: 1, description: 'Wedding day', unitPriceMinor: 100000 },
      { position: 2, quantity: 1, description: 'Drone', unitPriceMinor: 25000, isOptional: true, selected: true },
      { position: 3, quantity: 1, description: 'Photo book', unitPriceMinor: 39000, isOptional: true, selected: false },
    ],
  });
  const drawn = texts.mock.calls.map((c) => String(c[0]));
  texts.mockRestore();
  expect(res.status).toBe(200);
  const marks = drawn.filter((t) => /^(Zusatzleistung|Add-on) ·/.test(t));
  expect(marks).toEqual([
    expect.stringMatching(/^(Zusatzleistung · gebucht|Add-on · booked)$/),
    expect.stringMatching(/^(Zusatzleistung · nicht gebucht|Add-on · not booked)$/),
  ]);
  // The not-booked amount is in parentheses, outside the total.
  expect(drawn.some((t) => t.startsWith('(') && t.includes('390.00'))).toBe(true);
});

test('the customer\'s message comes with the acceptance and reaches the business', async () => {
  const { quoteId, link } = await sentQuote();
  const res = await request(publicApp).post(`/api/public/quotes/${link}/respond`).send({
    action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000, customerMessage: 'Kein Album, aber gerne <b>zwei</b> Drohnenflüge?',
  });
  expect(res.status).toBe(200);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote.customer_message).toBe('Kein Album, aber gerne <b>zwei</b> Drohnenflüge?');

  const notice = await lastMail('quote_accepted_admin', 'studio@example.com');
  expect(notice).toEqual(expect.objectContaining({
    quote_number: quote.quote_number, booked_add_ons: 'Drone', customer_message: 'Kein Album, aber gerne <b>zwei</b> Drohnenflüge?',
  }));
  const view = await request(adminApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
  expect(view.body.quote).toEqual(expect.objectContaining({ customerMessage: expect.stringContaining('Kein Album'), addOnsEditable: true }));
});

test('the business changes the add-ons of an accepted quote: recorded, re-rendered, emailed', async () => {
  const { quoteId, link } = await sentQuote();
  await request(publicApp).post(`/api/public/quotes/${link}/respond`).send({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 });
  const before = await db('quotes').where({ id: quoteId }).first();

  const res = await request(adminApp).post(`/api/admin/quotes/${quoteId}/add-ons`).set(auth).send({ selectedOptional: [2] });
  expect(res.status).toBe(200);
  expect(res.body).toEqual(expect.objectContaining({ changed: true, totalAmountMinor: 130000 }));
  expect(res.body.quote.selectionChanges).toEqual([expect.objectContaining({
    by: 'admin', adminId, booked: ['Album'], removed: ['Drone'], totalBeforeMinor: 120000, totalAfterMinor: 130000,
  })]);

  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(Number(quote.total_amount_minor)).toBe(130000);
  // First chosen by the customer, then changed by the business.
  expect(JSON.parse(quote.optional_selection_snapshot)).toEqual(expect.objectContaining({ by: 'customer', selectedOptional: [2] }));
  expect(String(quote.selection_accepted_at)).toBe(String(before.selection_accepted_at));
  // Each version keeps its own file: the first acceptance stays on disk.
  expect(before.pdf_path).toMatch(/-accepted\.pdf$/);
  expect(quote.pdf_path).toMatch(/-accepted-2\.pdf$/);
  expect(require('fs').existsSync(before.pdf_path)).toBe(true);

  const customer = await db('customer_accounts').where({ id: customerId }).first();
  const mail = await lastMail('quote_addons_updated', customer.email);
  expect(mail).toEqual(expect.objectContaining({ booked_list: 'Album', removed_list: 'Drone' }));
  expect(mail.attachments[0].contentPath).toBe(quote.pdf_path);

  // The same choice again changes nothing and sends nothing.
  const count = (await db('email_queue').where({ email_type: 'quote_addons_updated' })).length;
  const same = await request(adminApp).post(`/api/admin/quotes/${quoteId}/add-ons`).set(auth).send({ selectedOptional: [2] });
  expect(same.body.changed).toBe(false);
  expect((await db('email_queue').where({ email_type: 'quote_addons_updated' })).length).toBe(count);
});

test('add-ons can only be changed on an accepted quote without a contract, event or invoice', async () => {
  const { quoteId, link } = await sentQuote();
  const early = await request(adminApp).post(`/api/admin/quotes/${quoteId}/add-ons`).set(auth).send({ selectedOptional: [2] });
  expect(early.status).toBe(409);
  expect(early.body.code).toBe('QUOTE_NOT_ACCEPTED');

  await request(publicApp).post(`/api/public/quotes/${link}/respond`).send({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 });
  await db('quotes').where({ id: quoteId }).update({ converted_event_id: 999999 });
  const late = await request(adminApp).post(`/api/admin/quotes/${quoteId}/add-ons`).set(auth).send({ selectedOptional: [2] });
  expect(late.status).toBe(409);
  expect(late.body.code).toBe('QUOTE_CONVERTED');
  const view = await request(adminApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
  expect(view.body.quote.addOnsEditable).toBe(false);
});

test('saving a quote books and removes its add-ons, right after a restart too', async () => {
  // After a restart the column checks are uncached; run inside the save
  // transaction they waited on the one SQLite connection and failed the save.
  const quoteId = await quoteWithAddOns();
  require('../../src/utils/schemaCache').invalidateSchemaCache();
  const res = await request(adminApp).put(`/api/admin/quotes/${quoteId}`).set(auth).send({
    projectId: null, eventType: 'wedding', vatRate: 0,
    lineItems: [
      { position: 1, quantity: 1, description: 'Wedding day', unitPriceMinor: 100000 },
      { position: 2, quantity: 1, description: 'Album', unitPriceMinor: 30000, isOptional: true, selected: true },
      { position: 3, quantity: 1, description: 'Drone', unitPriceMinor: 20000, isOptional: true, selected: false },
    ],
  });
  expect(res.status).toBe(200);
  const { isTruthyFlag } = require('../../src/utils/lineItemTotals');
  const rows = await db('quote_line_items').where({ quote_id: quoteId });
  const line = (d) => rows.find((r) => r.description === d);
  expect(isTruthyFlag(line('Album').selected)).toBe(true);
  expect(isTruthyFlag(line('Drone').selected)).toBe(false);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(Number(quote.total_amount_minor)).toBe(130000);
});

test('a save that clears the intro, closing, notes and event name clears them', async () => {
  // The editor sends a cleared field as null; left out, the old text came back.
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0,
    introText: 'Hallo', outroText: 'Freundliche Grüsse', internalNotes: 'intern', eventName: 'Hochzeit',
    lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 }],
  }, adminId);
  const res = await request(adminApp).put(`/api/admin/quotes/${quoteId}`).set(auth).send({
    introText: null, outroText: null, internalNotes: null, eventName: null,
    lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unitPriceMinor: 100000 }],
  });
  expect(res.status).toBe(200);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote).toEqual(expect.objectContaining({
    intro_text: null, outro_text: null, internal_notes: null, event_name: null,
  }));
});

test('a default email template is brought up to date; an edited one is left alone', async () => {
  const templates = require('../../src/services/crmEmailTemplates');
  const row = await db('email_templates').where({ template_key: 'quote_sent' }).first();
  const translations = await db.schema.hasTable('email_template_translations');
  if (!row || !translations) return; // nothing stored to upgrade on this schema
  const old = templates.PREVIOUS_DEFAULTS.quote_sent;
  await db('email_template_translations').where({ template_id: row.id, language: 'en' })
    .update({ subject: old.en.subject, body_html: old.en.body_html, body_text: old.en.body_text });
  await db('email_template_translations').where({ template_id: row.id, language: 'de' })
    .update({ subject: old.de.subject, body_html: `${old.de.body_html}<p>Eigener Text</p>`, body_text: old.de.body_text });

  await new Promise((resolve, reject) => {
    jest.isolateModules(() => {
      require('../../src/services/crmEmailTemplates').ensureCrmEmailTemplatesSeeded(db, null).then(resolve, reject);
    });
  });
  const en = await db('email_template_translations').where({ template_id: row.id, language: 'en' }).first();
  const de = await db('email_template_translations').where({ template_id: row.id, language: 'de' }).first();
  expect(en.body_html).toContain('{{#if has_add_ons}}');
  expect(de.body_html).toContain('Eigener Text');
  expect(de.body_html).not.toContain('{{#if has_add_ons}}');
});
