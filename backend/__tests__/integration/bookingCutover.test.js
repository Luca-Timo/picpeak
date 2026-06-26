/**
 * Booking cutover — prepare_invoice's draft seam. convertToInvoiceOnly({draft})
 * must create the invoice(s) but leave scheduled_send_at NULL so the scheduler
 * never auto-sends them before the workflow's review gate + explicit
 * send_document.
 */
const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(30000);

describe('booking cutover — draft invoices on hold', () => {
  let db; let cleanup; let adminId; let customerId; let quoteService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    quoteService = require('../../src/services/quoteService');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function acceptedQuote() {
    const dealUuid = crypto.randomUUID();
    const [id] = await db('quotes').insert({
      quote_number: `Q-${dealUuid.slice(0, 8)}`,
      customer_account_id: customerId,
      status: 'accepted',
      currency: 'CHF',
      issue_date: '2026-01-01',
      net_amount_minor: 100000, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 100000,
      // A non-delivery installment so the contrast (scheduled date vs null) is meaningful.
      payment_term_snapshot: JSON.stringify({ installments: [{ percent: 100, trigger: 'quote_accepted', offset_days: 0, label: 'Total' }], net_days: 30 }),
      deal_uuid: dealUuid,
      created_by_admin_id: adminId,
    });
    return id;
  }

  it('draft mode creates the invoice with scheduled_send_at = NULL (held), and returns its id', async () => {
    const quoteId = await acceptedQuote();
    const res = await quoteService.convertToInvoiceOnly(quoteId, adminId, { draft: true });
    expect(Array.isArray(res.invoiceIds)).toBe(true);
    expect(res.invoiceIds.length).toBeGreaterThanOrEqual(1);

    const inv = await db('invoices').where({ id: res.invoiceIds[0] }).first();
    expect(inv.status).toBe('scheduled');     // editable + sendInvoice can issue it
    expect(inv.scheduled_send_at == null).toBe(true); // held — scheduler won't auto-send
  });

  it('without draft, the same installment IS scheduled (scheduled_send_at set)', async () => {
    const quoteId = await acceptedQuote();
    const res = await quoteService.convertToInvoiceOnly(quoteId, adminId);
    const inv = await db('invoices').where({ id: res.invoiceIds[0] }).first();
    expect(inv.status).toBe('scheduled');
    expect(inv.scheduled_send_at == null).toBe(false); // normal convert → auto-send date set
  });

  it('prepare_contract path (createFromQuote) completes under SQLite — no in-trx deadlock', async () => {
    const contractService = require('../../src/services/contractService');
    const quoteId = await acceptedQuote();
    const res = await contractService.createFromQuote(quoteId, adminId);
    expect(res.contractId).toBeGreaterThanOrEqual(1);
    expect(res.alreadyConverted).toBe(false);
    const c = await db('contracts').where({ id: res.contractId }).first();
    expect(c).toBeTruthy();
  });
});
