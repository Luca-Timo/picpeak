/**
 * Tests for taxReportService.
 *
 * Two layers:
 *   1. Pure helpers (grossUpLateFee, computeReportedAmounts,
 *      buildCustomerLabel) — no db mock needed.
 *   2. getTaxReport — db chain deep-mocked so we can feed canned
 *      invoice rows and assert the filter/bucket/total math.
 */

// ----- mock db chain ---------------------------------------------------
//
// taxReportService builds a single chain:
//   db('invoices').leftJoin(...).leftJoin(...).whereBetween(...)
//     .where(...).whereIn(...).orderBy(...).select(...)
// and then for cancelled ids:
//   db('invoices').whereIn('replaces_invoice_id', ids).select(...)
//
// We use one shared chain factory that returns canned rows from
// `_selectResult` for the main query, and lets us swap the result
// for the replacements lookup via a "second-call" hook.

let invoiceRowsForRun = [];
let replacementsRowsForRun = [];
let callCount = 0;

function makeChain(initialRows) {
  const c = {
    _rows: initialRows,
    then: function (onResolve, onReject) {
      return Promise.resolve(this._rows).then(onResolve, onReject);
    },
    leftJoin: jest.fn(function () { return this; }),
    where: jest.fn(function () { return this; }),
    whereIn: jest.fn(function () { return this; }),
    whereBetween: jest.fn(function () { return this; }),
    orderBy: jest.fn(function () { return this; }),
    select: jest.fn(function () { return Promise.resolve(this._rows); }),
  };
  return c;
}

const mockDbFn = jest.fn((tableName) => {
  callCount += 1;
  // Migration 126 added a Skonto aggregate that hits
  // `invoice_payment_log` — route those explicitly to an empty list so
  // the test surface stays focused on the invoices/replacements flow.
  if (tableName === 'invoice_payment_log') return makeChain([]);
  // First call: main listing. Second call: replacements lookup.
  if (callCount === 1) return makeChain(invoiceRowsForRun);
  return makeChain(replacementsRowsForRun);
});
// `.raw()` is used in the .select() column list for the event_name
// COALESCE (migration 123). The chain's select() ignores its
// arguments and returns the mocked rows, so the raw() return value
// just needs to exist — a string is fine.
mockDbFn.raw = jest.fn((sql) => sql);

jest.mock('../../src/database/db', () => ({
  db: mockDbFn,
  withRetry: jest.fn(async (fn) => fn()),
}));

const taxReportService = require('../../src/services/taxReportService');
const { grossUpLateFee, computeReportedAmounts, buildCustomerLabel } = taxReportService._internal;

beforeEach(() => {
  invoiceRowsForRun = [];
  replacementsRowsForRun = [];
  callCount = 0;
  mockDbFn.mockClear();
});

// ----- pure helpers ----------------------------------------------------

describe('grossUpLateFee', () => {
  it('returns zeros for a zero or negative fee', () => {
    expect(grossUpLateFee(0, 7.7)).toEqual({ net: 0, vat: 0 });
    expect(grossUpLateFee(-100, 7.7)).toEqual({ net: 0, vat: 0 });
    expect(grossUpLateFee(null, 7.7)).toEqual({ net: 0, vat: 0 });
  });

  it('returns the whole fee as net when VAT rate is 0', () => {
    expect(grossUpLateFee(2500, 0)).toEqual({ net: 2500, vat: 0 });
    // Missing/invalid rate is treated the same.
    expect(grossUpLateFee(2500, null)).toEqual({ net: 2500, vat: 0 });
  });

  it('splits a 25.00 CHF fee at 7.7% into net 23.21 + VAT 1.79', () => {
    // 2500 / 1.077 = 2321.265… → rounds to 2321; 2500 - 2321 = 179.
    expect(grossUpLateFee(2500, 7.7)).toEqual({ net: 2321, vat: 179 });
  });

  it('guarantees net + vat === gross input (no rounding drift)', () => {
    for (const fee of [1, 2500, 9999, 12345, 250000]) {
      for (const rate of [7.7, 8.1, 19, 20.5]) {
        const { net, vat } = grossUpLateFee(fee, rate);
        expect(net + vat).toBe(fee);
      }
    }
  });
});

describe('computeReportedAmounts', () => {
  it('returns stored amounts unchanged when late fee is zero', () => {
    const r = computeReportedAmounts({
      net_amount_minor: 10000,
      vat_amount_minor: 770,
      total_amount_minor: 10770,
      late_fee_amount_minor: 0,
      vat_rate: 7.7,
    });
    expect(r).toEqual({ netMinor: 10000, vatMinor: 770, totalMinor: 10770 });
  });

  it('adds the late-fee net/vat split onto the stored net + vat', () => {
    const r = computeReportedAmounts({
      net_amount_minor: 10000,
      vat_amount_minor: 770,
      total_amount_minor: 13270, // 10000 + 770 + 2500 late fee
      late_fee_amount_minor: 2500,
      vat_rate: 7.7,
    });
    expect(r.netMinor).toBe(10000 + 2321);
    expect(r.vatMinor).toBe(770 + 179);
    expect(r.totalMinor).toBe(13270);
  });

  it('keeps total at the stored total even when late fee is present', () => {
    // The stored total already includes the late fee — we never
    // recompute it from net + vat in the report.
    const r = computeReportedAmounts({
      net_amount_minor: 50000,
      vat_amount_minor: 4050,
      total_amount_minor: 56550,
      late_fee_amount_minor: 2500,
      vat_rate: 8.1,
    });
    expect(r.totalMinor).toBe(56550);
  });
});

describe('buildCustomerLabel', () => {
  it('prefers company_name when present', () => {
    expect(buildCustomerLabel({
      customer_company_name: 'ACME GmbH',
      customer_first_name: 'Anna',
      customer_last_name: 'Beispiel',
      customer_email: 'anna@example.com',
    })).toBe('ACME GmbH');
  });

  it('falls back to first + last name', () => {
    expect(buildCustomerLabel({
      customer_company_name: '',
      customer_first_name: 'Anna',
      customer_last_name: 'Beispiel',
    })).toBe('Anna Beispiel');
  });

  it('falls back to display_name when no name parts', () => {
    expect(buildCustomerLabel({
      customer_display_name: 'Anna B.',
    })).toBe('Anna B.');
  });

  it('falls back to email as a last resort', () => {
    expect(buildCustomerLabel({ customer_email: 'anna@example.com' })).toBe('anna@example.com');
  });

  it('returns empty string when nothing usable is present', () => {
    expect(buildCustomerLabel({})).toBe('');
  });
});

// ----- getTaxReport ----------------------------------------------------

describe('getTaxReport', () => {
  it('throws when from/to or currency are missing', async () => {
    await expect(taxReportService.getTaxReport({})).rejects.toThrow(/from.+to/);
    await expect(taxReportService.getTaxReport({ from: '2026-01-01', to: '2026-03-31' }))
      .rejects.toThrow(/currency/);
  });

  it('returns rows + totals for a clean period with one paid invoice', async () => {
    invoiceRowsForRun = [
      {
        id: 1, invoice_number: 'R-2026-0001', issue_date: '2026-01-15',
        currency: 'CHF', status: 'paid', vat_rate: 7.7,
        net_amount_minor: 10000, vat_amount_minor: 770, total_amount_minor: 10770,
        late_fee_amount_minor: 0, replaces_invoice_id: null,
        customer_company_name: 'ACME GmbH', customer_first_name: null, customer_last_name: null,
        customer_display_name: null, customer_email: null, event_name: 'Wedding A',
      },
    ];
    const out = await taxReportService.getTaxReport({
      from: '2026-01-01', to: '2026-03-31', currency: 'chf', // lowercase → coerced
    });
    expect(out.currency).toBe('CHF');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      invoiceNumber: 'R-2026-0001',
      isCancelled: false,
      customerLabel: 'ACME GmbH',
      eventName: 'Wedding A',
      netMinor: 10000,
      vatMinor: 770,
      totalMinor: 10770,
    });
    expect(out.grandTotalNet).toBe(10000);
    expect(out.grandTotalVat).toBe(770);
    expect(out.grandTotal).toBe(10770);
    expect(out.cancelledCount).toBe(0);
    expect(out.totalsByVatRate).toEqual([
      { vatRate: 7.7, netMinor: 10000, vatMinor: 770, totalMinor: 10770 },
    ]);
    expect(out.period).toEqual({ from: '2026-01-01', to: '2026-03-31' });
  });

  it('keeps cancelled rows visible but excludes them from totals', async () => {
    invoiceRowsForRun = [
      {
        id: 10, invoice_number: 'R-2026-0010', issue_date: '2026-02-01',
        currency: 'CHF', status: 'cancelled', vat_rate: 7.7,
        net_amount_minor: 10000, vat_amount_minor: 770, total_amount_minor: 10770,
        late_fee_amount_minor: 0, replaces_invoice_id: null,
        customer_company_name: 'ACME GmbH', customer_first_name: null, customer_last_name: null,
        customer_display_name: null, customer_email: null, event_name: 'Wedding A',
      },
      {
        id: 11, invoice_number: 'R-2026-0011', issue_date: '2026-02-02',
        currency: 'CHF', status: 'paid', vat_rate: 7.7,
        net_amount_minor: 10000, vat_amount_minor: 770, total_amount_minor: 10770,
        late_fee_amount_minor: 0, replaces_invoice_id: 10,
        customer_company_name: 'ACME GmbH', customer_first_name: null, customer_last_name: null,
        customer_display_name: null, customer_email: null, event_name: 'Wedding A',
      },
    ];
    // The supersedes lookup query: row 11 supersedes row 10.
    replacementsRowsForRun = [{ replaces_invoice_id: 10, invoice_number: 'R-2026-0011' }];

    const out = await taxReportService.getTaxReport({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF',
    });
    expect(out.rows).toHaveLength(2);
    const cancelled = out.rows.find((r) => r.invoiceNumber === 'R-2026-0010');
    const replacement = out.rows.find((r) => r.invoiceNumber === 'R-2026-0011');
    expect(cancelled.isCancelled).toBe(true);
    expect(cancelled.replacedByInvoiceNumber).toBe('R-2026-0011');
    expect(replacement.isCancelled).toBe(false);

    // Totals: only the replacement counts.
    expect(out.grandTotalNet).toBe(10000);
    expect(out.grandTotalVat).toBe(770);
    expect(out.grandTotal).toBe(10770);
    expect(out.cancelledCount).toBe(1);
    expect(out.totalsByVatRate).toEqual([
      { vatRate: 7.7, netMinor: 10000, vatMinor: 770, totalMinor: 10770 },
    ]);
  });

  it('buckets totals by VAT rate (e.g. 7.7 + 8.1 in same period)', async () => {
    invoiceRowsForRun = [
      {
        id: 1, invoice_number: 'R-2026-0001', issue_date: '2026-01-01',
        currency: 'CHF', status: 'paid', vat_rate: 7.7,
        net_amount_minor: 10000, vat_amount_minor: 770, total_amount_minor: 10770,
        late_fee_amount_minor: 0, replaces_invoice_id: null,
        customer_company_name: 'A', event_name: 'X',
      },
      {
        id: 2, invoice_number: 'R-2026-0002', issue_date: '2026-01-02',
        currency: 'CHF', status: 'paid', vat_rate: 8.1,
        net_amount_minor: 20000, vat_amount_minor: 1620, total_amount_minor: 21620,
        late_fee_amount_minor: 0, replaces_invoice_id: null,
        customer_company_name: 'B', event_name: 'Y',
      },
      {
        id: 3, invoice_number: 'R-2026-0003', issue_date: '2026-01-03',
        currency: 'CHF', status: 'sent', vat_rate: 8.1,
        net_amount_minor: 5000, vat_amount_minor: 405, total_amount_minor: 5405,
        late_fee_amount_minor: 0, replaces_invoice_id: null,
        customer_company_name: 'C', event_name: 'Z',
      },
    ];
    const out = await taxReportService.getTaxReport({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF',
    });
    expect(out.totalsByVatRate).toHaveLength(2);
    // Sorted ascending by rate.
    expect(out.totalsByVatRate[0]).toEqual({
      vatRate: 7.7, netMinor: 10000, vatMinor: 770, totalMinor: 10770,
    });
    expect(out.totalsByVatRate[1]).toEqual({
      vatRate: 8.1, netMinor: 25000, vatMinor: 2025, totalMinor: 27025,
    });
    expect(out.grandTotalNet).toBe(35000);
    expect(out.grandTotalVat).toBe(2795);
    expect(out.grandTotal).toBe(37795);
  });

  it('folds late fees into the reporting net + vat (gross-up per VAT rate)', async () => {
    invoiceRowsForRun = [
      {
        id: 1, invoice_number: 'R-2026-0001', issue_date: '2026-01-15',
        currency: 'CHF', status: 'overdue', vat_rate: 7.7,
        net_amount_minor: 10000, vat_amount_minor: 770,
        total_amount_minor: 13270, // 10000 + 770 + 2500 fee
        late_fee_amount_minor: 2500, replaces_invoice_id: null,
        customer_company_name: 'ACME', event_name: 'Wedding A',
      },
    ];
    const out = await taxReportService.getTaxReport({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF',
    });
    // Late fee 2500 @ 7.7% → net 2321 + vat 179.
    expect(out.rows[0].netMinor).toBe(12321);
    expect(out.rows[0].vatMinor).toBe(949);
    expect(out.rows[0].totalMinor).toBe(13270);
    // Grand totals reflect the same gross-up math.
    expect(out.grandTotalNet).toBe(12321);
    expect(out.grandTotalVat).toBe(949);
    expect(out.grandTotal).toBe(13270);
  });

  it('returns empty rows + zero totals when no invoices match the period', async () => {
    invoiceRowsForRun = [];
    const out = await taxReportService.getTaxReport({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF',
    });
    expect(out.rows).toEqual([]);
    expect(out.grandTotalNet).toBe(0);
    expect(out.grandTotalVat).toBe(0);
    expect(out.grandTotal).toBe(0);
    expect(out.totalsByVatRate).toEqual([]);
    expect(out.cancelledCount).toBe(0);
  });
});
