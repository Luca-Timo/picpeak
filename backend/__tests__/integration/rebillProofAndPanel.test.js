/**
 * Issue #866 — the createInvoice-free halves of the re-bill proof + CRM panel
 * feature, against a real SQLite schema:
 *
 *   • listCustomerRebills — status DERIVED from the linked invoice lifecycle
 *     (open / sent / paid; a cancelled/Storno'd cover drops back to open) plus
 *     cost-vs-rebilled math and mode.
 *   • collectRebillProofAttachments — the Send-dialog per-file selection, the
 *     all-or-none default resolution (per-customer override else global), the
 *     Beleg-<inv#> filename (suffix only when >1), and the missing-file marker.
 *
 * The invoice-MINTING paths (billCombinedForCustomer / billPendingRebills) call
 * createInvoice inside a db.transaction, which deadlocks on the SQLite harness
 * (global-db sequence write vs. held write lock) — same limitation the sibling
 * incomingInvoiceRebill.test.js documents. They're covered by the existing
 * billPendingRebills / billUnbilledEntries suites; here we hand-craft billed
 * state instead.
 */
const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('#866 re-bill proof attachment + CRM panel', () => {
  let db;
  let cleanup;
  let adminId;
  let expenseService;
  let rebillProofs;
  let flagCache;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const dbModule = require('../../src/database/db');
    dbModule.logActivity = async () => {};
    ({ adminId } = await seedMinimal(db));
    expenseService = require('../../src/services/expenseService');
    rebillProofs = require('../../src/services/invoice/rebillProofs');
    flagCache = require('../../src/middleware/requireFeatureFlag');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  const unwrapId = (ins) => (typeof ins[0] === 'object' ? ins[0].id : ins[0]);
  let seq = 0;

  async function makeCustomer(overrides = {}) {
    seq += 1;
    const ins = await db('customer_accounts').insert({
      email: `c866-${seq}@example.com`,
      display_name: `C866 ${seq}`,
      password_hash: 'x',
      preferred_language: 'de',
      is_active: 1,
      billing_cadence: 'per_event',
      created_at: new Date(),
      ...overrides,
    }).returning('id');
    return unwrapId(ins);
  }

  async function makeDoc(customerId, overrides = {}) {
    const ins = await db('inbound_documents').insert({
      source: 'upload', status: 'categorized', parse_status: 'parsed', parse_method: 'none',
      supplier_name: 'ACME AG', currency: 'CHF', total_amount_minor: 10000,
      invoice_date: '2026-06-01', disposition: 'rebill', customer_account_id: customerId,
      created_at: new Date(), updated_at: new Date(),
      ...overrides,
    }).returning('id');
    return unwrapId(ins);
  }

  async function makeInvoice(customerId, status, number) {
    const ins = await db('invoices').insert({
      invoice_number: number,
      customer_account_id: customerId,
      status,
      currency: 'CHF',
      issue_date: '2026-06-01', due_date: '2026-07-01',
      vat_rate: 0, net_amount_minor: 10000, vat_amount_minor: 0, total_amount_minor: 10000,
      created_at: new Date(), updated_at: new Date(),
    }).returning('id');
    return unwrapId(ins);
  }

  describe('listCustomerRebills', () => {
    it('derives open / sent / paid and open→cost==rebilled for passthrough, +markup for rebill', async () => {
      const customerId = await makeCustomer();

      // Open re-bill (10% markup): rebilled = 11000.
      await makeDoc(customerId, { total_amount_minor: 10000, markup_type: 'percent', markup_percent: 10 });
      // Open passthrough: no markup, rebilled == cost.
      await makeDoc(customerId, { disposition: 'durchlaufend', total_amount_minor: 5000, markup_type: 'none' });
      // Sent (on a 'sent' invoice).
      const sentInv = await makeInvoice(customerId, 'sent', 'R-2026-0001');
      await makeDoc(customerId, { total_amount_minor: 8000, markup_type: 'none', billed_invoice_id: sentInv });
      // Paid.
      const paidInv = await makeInvoice(customerId, 'paid', 'R-2026-0002');
      await makeDoc(customerId, { total_amount_minor: 8000, markup_type: 'none', billed_invoice_id: paidInv });
      // Cancelled cover → drops back to 'open', no invoice link surfaced.
      const cancInv = await makeInvoice(customerId, 'cancelled', 'R-2026-0003');
      await makeDoc(customerId, { total_amount_minor: 8000, markup_type: 'none', billed_invoice_id: cancInv });

      const items = await expenseService.listCustomerRebills(customerId);
      const byStatus = (s) => items.filter((r) => r.status === s);

      expect(items).toHaveLength(5);
      expect(byStatus('open')).toHaveLength(3); // 2 genuinely-open + 1 cancelled-cover
      expect(byStatus('sent')).toHaveLength(1);
      expect(byStatus('paid')).toHaveLength(1);

      const rebill = items.find((r) => r.mode === 'rebill' && r.costMinor === 10000);
      expect(rebill.rebilledMinor).toBe(11000);
      const passthrough = items.find((r) => r.mode === 'passthrough');
      expect(passthrough.rebilledMinor).toBe(passthrough.costMinor);

      const sent = byStatus('sent')[0];
      expect(sent.invoiceNumber).toBe('R-2026-0001');
      expect(sent.invoiceId).toBe(sentInv);

      const cancelledCover = items.find((r) => r.status === 'open' && r.invoiceNumber === null && r.costMinor === 8000);
      expect(cancelledCover).toBeDefined(); // cancelled cover isn't shown as a live invoice link
    });
  });

  describe('storno releases the re-bill linkage (#866 review)', () => {
    it("clears billed_invoice_id so a Storno'd cover returns to the billable pool", async () => {
      const invoiceService = require('../../src/services/invoiceService');
      const customerId = await makeCustomer();
      const invId = await makeInvoice(customerId, 'sent', 'R-2026-9000');
      const lineIns = await db('invoice_line_items').insert({
        invoice_id: invId, position: 1, quantity: 1, description: 'Rebill',
        unit_price_minor: 8000, discount_percent: 0, line_total_minor: 8000,
      }).returning('id');
      const lineId = unwrapId(lineIns);
      const docId = await makeDoc(customerId, {
        total_amount_minor: 8000, markup_type: 'none', billed_invoice_id: invId, billed_invoice_line_item_id: lineId,
      });

      // Storno claims a fresh number from document_sequences; the other tests
      // seed explicit R-2026-000x numbers without advancing it, so push the
      // counter past them to avoid a number collision (a test artifact — real
      // invoices always claim through the sequence).
      await db('document_sequences').insert({ kind: 'invoice', year: 2026, current_value: 9000, created_at: new Date(), updated_at: new Date() })
        .onConflict(['kind', 'year']).ignore();
      await db('document_sequences').where({ kind: 'invoice', year: 2026 }).update({ current_value: 9000 });

      // Storno the covering invoice (the issued-cancel path).
      await db.transaction(async (trx) => invoiceService.createStorno(invId, adminId, trx));

      const doc = await db('inbound_documents').where({ id: docId }).first();
      expect(doc.billed_invoice_id).toBeNull();
      expect(doc.billed_invoice_line_item_id).toBeNull();

      // It now surfaces as a genuinely-open item AND the pending pool picks it up.
      const items = await expenseService.listCustomerRebills(customerId);
      const row = items.find((r) => r.id === docId);
      expect(row.status).toBe('open');
      expect(row.invoiceId).toBeNull();
      const pending = await db('inbound_documents')
        .where({ customer_account_id: customerId }).whereNull('billed_invoice_id')
        .whereIn('disposition', ['rebill', 'durchlaufend']).where('status', 'categorized');
      expect(pending.map((p) => p.id)).toContain(docId);
    });
  });

  describe('collectRebillProofAttachments', () => {
    const businessDocs = () => path.join(process.env.STORAGE_PATH, 'business-docs', 'inbound', '2026');

    async function enableIncoming() {
      const existing = await db('feature_flags').where({ key: 'incomingInvoices' }).first();
      if (existing) await db('feature_flags').where({ key: 'incomingInvoices' }).update({ value: 1 });
      else await db('feature_flags').insert({ key: 'incomingInvoices', value: 1 });
      flagCache.invalidateFeatureFlagCache();
    }

    function writeProof(name) {
      fs.mkdirSync(businessDocs(), { recursive: true });
      const p = path.join(businessDocs(), name);
      fs.writeFileSync(p, '%PDF-1.4\n% test proof\n');
      return p;
    }

    it('honours explicit selection, names Beleg-<inv#>, and marks a missing file', async () => {
      await enableIncoming();
      const customerId = await makeCustomer();
      const invId = await makeInvoice(customerId, 'scheduled', 'R-2026-1000');
      const invoice = await db('invoices').where({ id: invId }).first();

      const good1 = await makeDoc(customerId, { billed_invoice_id: invId, file_path: writeProof('p1.pdf') });
      const good2 = await makeDoc(customerId, { billed_invoice_id: invId, file_path: writeProof('p2.pdf') });
      const missing = await makeDoc(customerId, { billed_invoice_id: invId, file_path: path.join(businessDocs(), 'nope.pdf') });

      // Select the two good proofs → two attachments, suffixed because >1.
      const both = await rebillProofs.collectRebillProofAttachments(invoice, null, [good1, good2]);
      expect(both.map((a) => a.filename).sort()).toEqual(['Beleg-R-2026-1000-1.pdf', 'Beleg-R-2026-1000-2.pdf']);

      // Select exactly one → single, unsuffixed.
      const one = await rebillProofs.collectRebillProofAttachments(invoice, null, [good1]);
      expect(one).toHaveLength(1);
      expect(one[0].filename).toBe('Beleg-R-2026-1000.pdf');

      // Select the missing-file doc → no attachment, but a marker is persisted.
      const none = await rebillProofs.collectRebillProofAttachments(invoice, null, [missing]);
      expect(none).toHaveLength(0);
      const markerRow = await db('inbound_documents').where({ id: missing }).first('proof_attach_error');
      expect(markerRow.proof_attach_error).toBeTruthy();
      // A successful attach clears any prior marker.
      await rebillProofs.collectRebillProofAttachments(invoice, null, [good1]);
      const cleared = await db('inbound_documents').where({ id: good1 }).first('proof_attach_error');
      expect(cleared.proof_attach_error).toBeNull();
    });

    it('resolves the all-or-none default from the per-customer override then global', async () => {
      await enableIncoming();
      const customerId = await makeCustomer();
      const invId = await makeInvoice(customerId, 'scheduled', 'R-2026-2000');
      const invoice = await db('invoices').where({ id: invId }).first();
      await makeDoc(customerId, { billed_invoice_id: invId, file_path: writeProof('d1.pdf') });

      // Global default off, no override → none.
      const off = await rebillProofs.collectRebillProofAttachments(invoice, { rebill_attach_proof: null }, undefined);
      expect(off).toHaveLength(0);

      // Per-customer override ON → all, regardless of the (off) global.
      const on = await rebillProofs.collectRebillProofAttachments(invoice, { rebill_attach_proof: true }, undefined);
      expect(on).toHaveLength(1);

      // Global ON (no override) → all.
      await db('app_settings').insert({ setting_key: 'accounting_rebill_attach_proof', setting_value: JSON.stringify(true), setting_type: 'accounting' });
      const globalOn = await rebillProofs.collectRebillProofAttachments(invoice, { rebill_attach_proof: null }, undefined);
      expect(globalOn).toHaveLength(1);
      // Override OFF beats global ON.
      const overrideOff = await rebillProofs.collectRebillProofAttachments(invoice, { rebill_attach_proof: false }, undefined);
      expect(overrideOff).toHaveLength(0);
    });

    it('attaches nothing when the incoming-invoices flag is off', async () => {
      const existing = await db('feature_flags').where({ key: 'incomingInvoices' }).first();
      if (existing) await db('feature_flags').where({ key: 'incomingInvoices' }).update({ value: 0 });
      else await db('feature_flags').insert({ key: 'incomingInvoices', value: 0 });
      flagCache.invalidateFeatureFlagCache();

      const customerId = await makeCustomer();
      const invId = await makeInvoice(customerId, 'scheduled', 'R-2026-3000');
      const invoice = await db('invoices').where({ id: invId }).first();
      const doc = await makeDoc(customerId, { billed_invoice_id: invId, file_path: writeProof('f1.pdf') });

      const res = await rebillProofs.collectRebillProofAttachments(invoice, { rebill_attach_proof: true }, [doc]);
      expect(res).toHaveLength(0);
    });
  });
});
