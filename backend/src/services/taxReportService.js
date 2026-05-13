/**
 * taxReportService — period-scoped revenue listing for tax filing.
 *
 * Pulls every revenue-relevant invoice in [from, to] (accrual basis,
 * keyed on `issue_date`) and returns rows + totals broken down by
 * VAT rate. Cancelled invoices stay in the row list (DE/CH/AT audit
 * trail requires a gap-free invoice-number sequence) but are excluded
 * from the totals math.
 *
 * Late fees: the user opted to include them in the totals. We split
 * each invoice's `late_fee_amount_minor` proportionally using the
 * invoice's own VAT rate:
 *   lateFeeNet = round(late_fee_amount_minor / (1 + vat_rate/100))
 *   lateFeeVat = late_fee_amount_minor − lateFeeNet
 * and add those onto the stored `net_amount_minor` / `vat_amount_minor`
 * before reporting. Invoices without a late fee → math collapses to
 * the stored values.
 *
 * Returned shape (see getTaxReport):
 *   {
 *     rows:               [{ id, invoiceNumber, issueDate, currency,
 *                            vatRate, customerLabel, eventName,
 *                            netMinor, vatMinor, totalMinor,
 *                            isCancelled, supersededByInvoiceNumber }, …],
 *     totalsByVatRate:    [{ vatRate, netMinor, vatMinor, totalMinor }, …],
 *     grandTotalNet:      Number (minor units),
 *     grandTotalVat:      Number (minor units),
 *     grandTotal:         Number (minor units),
 *     cancelledCount:     Number,
 *     currency:           String,
 *     period:             { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' },
 *   }
 *
 * Counterpart renderers (renderTaxReportPdf / renderTaxReportCsv)
 * land in commit 3 alongside the routes — keeping the service pure
 * data-shaping for this commit.
 */

const { db, withRetry } = require('../database/db');

// Rows we WANT to surface in the tax report. `cancelled` is included
// for audit visibility; the totals math filters it out separately.
const REPORTABLE_STATUSES = ['sent', 'paid', 'overdue', 'pending_delivery', 'cancelled'];

function ensureInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function ensureRate(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compose the customer label we show in the table. Prefers company
 * name (most invoices in this workflow are B2B), falls back to
 * "First Last", then display_name, then email. Mirrors how the bills
 * list page picks a label so the two views feel consistent.
 */
function buildCustomerLabel(row) {
  if (row.customer_company_name && String(row.customer_company_name).trim()) {
    return String(row.customer_company_name).trim();
  }
  const first = row.customer_first_name ? String(row.customer_first_name).trim() : '';
  const last  = row.customer_last_name  ? String(row.customer_last_name).trim()  : '';
  const fullName = `${first} ${last}`.trim();
  if (fullName) return fullName;
  if (row.customer_display_name) return String(row.customer_display_name).trim();
  if (row.customer_email) return String(row.customer_email).trim();
  return '';
}

/**
 * Split a late-fee gross amount into (net, vat) components using the
 * invoice's own VAT rate. Rounding direction matches how we render
 * money throughout the system: half-to-even on the net portion,
 * remainder lands in VAT so net + vat = grossInput exactly.
 *
 *   grossUpLateFee(2500, 7.7) → { net: 2321, vat: 179 }   // 25.00 → 23.21 + 1.79
 *   grossUpLateFee(2500, 0)   → { net: 2500, vat: 0 }     // no VAT, fee is pure net
 */
function grossUpLateFee(grossMinor, vatRatePercent) {
  const fee = ensureInt(grossMinor);
  if (fee <= 0) return { net: 0, vat: 0 };
  const rate = ensureRate(vatRatePercent);
  if (rate <= 0) return { net: fee, vat: 0 };
  const net = Math.round(fee / (1 + rate / 100));
  const vat = fee - net;
  return { net, vat };
}

/**
 * Apply the late-fee gross-up to a raw DB row and return the values
 * we'll show + sum in the report. Net + VAT are the stored amounts
 * PLUS the late-fee components; total stays at `total_amount_minor`
 * (already includes the late fee).
 */
function computeReportedAmounts(row) {
  const baseNet = ensureInt(row.net_amount_minor);
  const baseVat = ensureInt(row.vat_amount_minor);
  const total   = ensureInt(row.total_amount_minor);
  const { net: lateNet, vat: lateVat } = grossUpLateFee(row.late_fee_amount_minor, row.vat_rate);
  return {
    netMinor:   baseNet + lateNet,
    vatMinor:   baseVat + lateVat,
    totalMinor: total,
  };
}

/**
 * Resolve which replacement invoice (if any) was issued for each
 * cancelled row. Used for the "Bezug → R-2026-0043" badge in the UI
 * and PDF. Single batched query, no N+1.
 */
async function loadSupersedesMap(cancelledIds) {
  if (!cancelledIds.length) return new Map();
  const successors = await db('invoices')
    .whereIn('supersedes_invoice_id', cancelledIds)
    .select('supersedes_invoice_id', 'invoice_number');
  const map = new Map();
  for (const s of successors) {
    map.set(s.supersedes_invoice_id, s.invoice_number);
  }
  return map;
}

/**
 * The main entry point.
 *
 *   getTaxReport({ from: '2026-01-01', to: '2026-03-31', currency: 'CHF' })
 *
 * `from` and `to` are inclusive ISO dates (YYYY-MM-DD). `currency` is
 * required and must match `invoices.currency` exactly — mixing
 * currencies in one report is unsound for tax filing, so the API
 * forces a single-currency view.
 */
async function getTaxReport({ from, to, currency } = {}) {
  if (!from || !to) {
    throw new Error('getTaxReport: `from` and `to` are required (YYYY-MM-DD)');
  }
  if (!currency || typeof currency !== 'string') {
    throw new Error('getTaxReport: `currency` is required');
  }
  const cur = currency.toUpperCase();

  return await withRetry(async () => {
    const dbRows = await db('invoices')
      .leftJoin('customer_accounts', 'invoices.customer_account_id', 'customer_accounts.id')
      .leftJoin('events',            'invoices.event_id',            'events.id')
      .whereBetween('invoices.issue_date', [from, to])
      .where('invoices.currency', cur)
      .whereIn('invoices.status', REPORTABLE_STATUSES)
      .orderBy('invoices.invoice_number', 'asc')
      .select(
        'invoices.id',
        'invoices.invoice_number',
        'invoices.issue_date',
        'invoices.currency',
        'invoices.status',
        'invoices.vat_rate',
        'invoices.net_amount_minor',
        'invoices.vat_amount_minor',
        'invoices.total_amount_minor',
        'invoices.late_fee_amount_minor',
        'invoices.supersedes_invoice_id',
        'customer_accounts.email         as customer_email',
        'customer_accounts.display_name  as customer_display_name',
        'customer_accounts.first_name    as customer_first_name',
        'customer_accounts.last_name     as customer_last_name',
        'customer_accounts.company_name  as customer_company_name',
        'events.event_name               as event_name',
      );

    // Find replacement invoice numbers for any cancelled rows so the
    // UI can render "Bezug → R-XXXX" without an extra round-trip.
    const cancelledIds = dbRows.filter((r) => r.status === 'cancelled').map((r) => r.id);
    const supersededByMap = await loadSupersedesMap(cancelledIds);

    // Bucket totals by VAT rate. Use a string key so 7.7 and 7.70
    // collapse to the same bucket regardless of how the DB rounds.
    const byRate = new Map();
    let grandTotalNet = 0;
    let grandTotalVat = 0;
    let grandTotal    = 0;
    let cancelledCount = 0;

    const rows = dbRows.map((r) => {
      const reported = computeReportedAmounts(r);
      const isCancelled = r.status === 'cancelled';
      if (isCancelled) {
        cancelledCount += 1;
      } else {
        grandTotalNet += reported.netMinor;
        grandTotalVat += reported.vatMinor;
        grandTotal    += reported.totalMinor;
        const rateKey = String(ensureRate(r.vat_rate).toFixed(2));
        const bucket = byRate.get(rateKey) || {
          vatRate: ensureRate(r.vat_rate),
          netMinor: 0, vatMinor: 0, totalMinor: 0,
        };
        bucket.netMinor   += reported.netMinor;
        bucket.vatMinor   += reported.vatMinor;
        bucket.totalMinor += reported.totalMinor;
        byRate.set(rateKey, bucket);
      }
      return {
        id: r.id,
        invoiceNumber: r.invoice_number,
        issueDate: r.issue_date,
        currency: r.currency,
        status: r.status,
        isCancelled,
        supersededByInvoiceNumber: isCancelled ? (supersededByMap.get(r.id) || null) : null,
        vatRate: ensureRate(r.vat_rate),
        customerLabel: buildCustomerLabel(r),
        eventName: r.event_name || '',
        netMinor: reported.netMinor,
        vatMinor: reported.vatMinor,
        totalMinor: reported.totalMinor,
      };
    });

    const totalsByVatRate = Array.from(byRate.values()).sort((a, b) => a.vatRate - b.vatRate);

    return {
      rows,
      totalsByVatRate,
      grandTotalNet,
      grandTotalVat,
      grandTotal,
      cancelledCount,
      currency: cur,
      period: { from, to },
    };
  });
}

module.exports = {
  getTaxReport,
  // Exposed for unit tests.
  _internal: { grossUpLateFee, computeReportedAmounts, buildCustomerLabel },
};
