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
 *                            isCancelled, replacedByInvoiceNumber }, …],
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
const pdfService = require('./pdfService');
const businessProfileService = require('./businessProfileService');
const { getAppSetting } = require('../utils/appSettings');
const { t } = require('./pdf-i18n');
const { formatMinor, formatDate } = pdfService._internal;

// Rows we WANT to surface in the tax report. `cancelled` is included
// for audit visibility; the totals math filters it out separately.
const REPORTABLE_STATUSES = ['sent', 'paid', 'overdue', 'pending_delivery', 'cancelled'];

// D.2 — `ensureInt` consolidated into utils/numericHelpers.
const { ensureInt } = require('../utils/numericHelpers');

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
async function loadReplacementsMap(cancelledIds) {
  if (!cancelledIds.length) return new Map();
  const successors = await db('invoices')
    .whereIn('replaces_invoice_id', cancelledIds)
    .select('replaces_invoice_id', 'invoice_number');
  const map = new Map();
  for (const s of successors) {
    map.set(s.replaces_invoice_id, s.invoice_number);
  }
  return map;
}

/**
 * Aggregate Skonto state per invoice from `invoice_payment_log`
 * (migration 126). Returns Map<invoice_id, { applied, amountMinor }>.
 * An invoice is considered Skonto-applied if ANY of its payment-log
 * rows carries the flag — admins occasionally split the discounted
 * total across multiple rows (e.g. retainer + final).
 *
 * Single batched query, no N+1. Empty map when the input list is
 * empty so the main path can skip the lookup entirely on empty
 * periods.
 */
async function loadSkontoMap(invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const rows = await db('invoice_payment_log')
    .whereIn('invoice_id', invoiceIds)
    .select('invoice_id', 'skonto_applied', 'skonto_amount_minor');
  const map = new Map();
  for (const r of rows) {
    const flag = r.skonto_applied === true || r.skonto_applied === 1;
    const amt = Number(r.skonto_amount_minor || 0);
    const cur = map.get(r.invoice_id) || { applied: false, amountMinor: 0 };
    if (flag) cur.applied = true;
    cur.amountMinor += amt;
    map.set(r.invoice_id, cur);
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
        'invoices.kind',
        'invoices.vat_rate',
        'invoices.net_amount_minor',
        'invoices.vat_amount_minor',
        'invoices.total_amount_minor',
        'invoices.late_fee_amount_minor',
        'invoices.replaces_invoice_id',
        'customer_accounts.email         as customer_email',
        'customer_accounts.display_name  as customer_display_name',
        'customer_accounts.first_name    as customer_first_name',
        'customer_accounts.last_name     as customer_last_name',
        'customer_accounts.company_name  as customer_company_name',
        // Prefer the invoice's inline snapshot (migration 123) so
        // renames on the events table don't retroactively change
        // historical tax reports; fall back to events.event_name for
        // legacy rows where the snapshot is still null.
        db.raw('COALESCE(invoices.event_name, events.event_name) AS event_name'),
      );

    // Find replacement invoice numbers for any cancelled rows so the
    // UI can render "Bezug → R-XXXX" without an extra round-trip.
    const cancelledIds = dbRows.filter((r) => r.status === 'cancelled').map((r) => r.id);
    const replacedByMap = await loadReplacementsMap(cancelledIds);

    // Skonto aggregate (migration 126). One invoice can have multiple
    // payment-log rows (partial → top-up → top-up → final); we surface
    // the row as "paid with Skonto" if ANY of its log rows carries the
    // flag, and sum the discount across all such rows. Done as a
    // separate query so the main SELECT doesn't need a GROUP BY (which
    // would force every selected column into the GROUP under strict
    // Postgres semantics).
    const skontoByInvoiceId = await loadSkontoMap(dbRows.map((r) => r.id));

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
      const skonto = skontoByInvoiceId.get(r.id) || { applied: false, amountMinor: 0 };
      return {
        id: r.id,
        invoiceNumber: r.invoice_number,
        issueDate: r.issue_date,
        currency: r.currency,
        status: r.status,
        // kind + isReissue drive the lineage badges in the tax-tab
        // table (parity with the admin invoices list). isCancelled
        // already gates the "Cancelled" badge; isReissue gates a
        // "Reissue" badge on invoices created via Cancel & reissue.
        kind: r.kind || 'invoice',
        isCancelled,
        isReissue: !isCancelled && r.replaces_invoice_id != null,
        replacedByInvoiceNumber: isCancelled ? (replacedByMap.get(r.id) || null) : null,
        vatRate: ensureRate(r.vat_rate),
        customerLabel: buildCustomerLabel(r),
        eventName: r.event_name || '',
        netMinor: reported.netMinor,
        vatMinor: reported.vatMinor,
        totalMinor: reported.totalMinor,
        // Skonto aggregate (migration 126). `skontoApplied` flags
        // any row in this invoice's payment log as Skonto-applied;
        // `skontoAmountMinor` is the summed discount across all such
        // rows. Both surfaced so the report consumer (UI / PDF / CSV)
        // can render the column without re-querying the log.
        skontoApplied: skonto.applied,
        skontoAmountMinor: skonto.amountMinor,
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

// ---------------------------------------------------------------------
// PDF + CSV renderers
// ---------------------------------------------------------------------

/**
 * Pull the issuer block + date format that the renderers need. Mirrors
 * the slice that invoiceService.buildInvoiceRenderContext builds for
 * the regular invoice/quote PDFs so the letterhead looks identical.
 */
async function loadRenderContext(locale) {
  const { profile } = await businessProfileService.getProfile();
  let dateFormat = null;
  try {
    const raw = await getAppSetting('general_date_format');
    if (raw && typeof raw === 'object' && raw.format) dateFormat = raw;
    else if (typeof raw === 'string' && raw.trim()) dateFormat = { format: raw.trim() };
  } catch (_) { /* fall back to renderer default */ }

  const issuer = profile ? {
    companyName: profile.company_name,
    addressLine1: profile.address_line1,
    addressLine2: profile.address_line2,
    postalCode: profile.postal_code,
    city: profile.city,
    state: profile.state,
    countryCode: profile.country_code,
    countryName: profile.country_name || null,
    phone: profile.phone, mobile: profile.mobile, email: profile.email, website: profile.website,
    footerLine: profile.footer_line,
    vatId: profile.vat_id,
    logoPath: profile.logo_path,
    pdfFontTtfPath: profile.pdf_font_ttf_path,
    pdfFontFamily: profile.pdf_font_family || null,
    showLogo: profile.pdf_show_logo == null ? true
      : (profile.pdf_show_logo === true || profile.pdf_show_logo === 1 || profile.pdf_show_logo === '1'),
    showCompanyName: profile.pdf_show_company_name == null ? true
      : (profile.pdf_show_company_name === true || profile.pdf_show_company_name === 1 || profile.pdf_show_company_name === '1'),
    logoHeight: profile.pdf_logo_height == null ? 56 : Number(profile.pdf_logo_height),
    companyNameInline: profile.pdf_company_name_inline === true || profile.pdf_company_name_inline === 1 || profile.pdf_company_name_inline === '1',
    // Folding marks would clutter a tax-report (no envelope window in
    // play); always suppress regardless of the profile setting.
    foldingMarks: 'none',
  } : {};

  return { issuer, dateFormat, locale: locale || profile?.default_locale || 'de' };
}

// Page layout for the tax-report table. Sized for A4 landscape (762pt
// content width). Sums to ~759 leaving ~3pt slack for the right margin.
//
// "Status" column lives at the far right so the cancelled marker
// doesn't crowd the invoice number. The invoice column itself stays
// uncluttered with just "R-2026-0001" — easier to scan for an
// auditor looking at the sequence.
const TAX_TABLE_COLS = [
  { key: 'idx',      labelKey: 'tax_col_no',       width: 26,  align: 'right' },
  { key: 'date',     labelKey: 'tax_col_date',     width: 60,  align: 'left'  },
  { key: 'invoice',  labelKey: 'tax_col_invoice',  width: 100, align: 'left'  },
  { key: 'customer', labelKey: 'tax_col_customer', width: 132, align: 'left'  },
  { key: 'event',    labelKey: 'tax_col_event',    width: 95,  align: 'left'  },
  { key: 'vatRate',  labelKey: 'tax_col_vat_rate', width: 42,  align: 'right' },
  { key: 'net',      labelKey: 'tax_col_net',      width: 70,  align: 'right' },
  { key: 'vat',      labelKey: 'tax_col_vat',      width: 60,  align: 'right' },
  { key: 'total',    labelKey: 'tax_col_total',    width: 80,  align: 'right' },
  // Skonto column (migration 126) — blank for non-Skonto rows so the
  // column reads quietly until it has data. Shrunk neighbouring text
  // columns slightly to make space without going over the landscape
  // content width.
  { key: 'skonto',   labelKey: 'tax_col_skonto',   width: 56,  align: 'right' },
  { key: 'status',   labelKey: 'tax_col_status',   width: 58,  align: 'left'  },
];

function colX(leftMargin, index) {
  let x = leftMargin;
  for (let i = 0; i < index; i += 1) x += TAX_TABLE_COLS[i].width;
  return x;
}

function drawTaxTableHeader(doc, leftMargin, y, locale, fonts) {
  doc.font(fonts.bold).fontSize(8.5).fillColor('#000');
  for (let i = 0; i < TAX_TABLE_COLS.length; i += 1) {
    const col = TAX_TABLE_COLS[i];
    doc.text(t(locale, col.labelKey), colX(leftMargin, i) + 2, y, {
      width: col.width - 4, align: col.align,
    });
  }
  const headerBottom = y + 14;
  doc.moveTo(leftMargin, headerBottom)
    .lineTo(leftMargin + TAX_TABLE_COLS.reduce((s, c) => s + c.width, 0), headerBottom)
    .lineWidth(0.6).strokeColor('#000').stroke();
  return headerBottom + 4;
}

function formatVatRate(rate, locale) {
  // 7.7 → "7.7 %" in en, "7,7 %" in de. Two decimals stripped for
  // tidiness when zero (8.10 → "8.1 %").
  const n = Number(rate || 0);
  const intlLocale = locale === 'de' ? 'de-CH' : 'en-GB';
  const formatted = new Intl.NumberFormat(intlLocale, {
    minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(n);
  return `${formatted} %`;
}

function rowCellValues(row, idx, locale, dateFormat) {
  const intlLocale = locale === 'de' ? 'de-CH' : 'en-GB';
  return {
    idx: String(idx),
    date: formatDate(row.issueDate, dateFormat),
    invoice: row.invoiceNumber, // no inline "(Cancelled)" — keep the column tidy; status is its own column
    customer: row.customerLabel || '',
    event: row.eventName || '',
    vatRate: formatVatRate(row.vatRate, locale),
    net: formatMinor(row.netMinor, row.currency, intlLocale),
    vat: formatMinor(row.vatMinor, row.currency, intlLocale),
    total: formatMinor(row.totalMinor, row.currency, intlLocale),
    skonto: row.skontoApplied
      ? formatMinor(row.skontoAmountMinor, row.currency, intlLocale)
      : '',
    status: row.isCancelled ? t(locale, 'tax_status_cancelled') : '',
  };
}

/**
 * Render the tax report as a PDF buffer.
 *
 *   renderTaxReportPdf({ from, to, currency, locale })  → Promise<Buffer>
 *
 * Currency is required and used to scope the data (same contract as
 * getTaxReport). Locale defaults to the business profile's default.
 */
async function renderTaxReportPdf({ from, to, currency, locale } = {}) {
  const report = await getTaxReport({ from, to, currency });
  const renderCtx = await loadRenderContext(locale);
  const useLocale = renderCtx.locale;
  const intlLocale = useLocale === 'de' ? 'de-CH' : 'en-GB';

  const { doc, page, fonts } = pdfService.createBaseDocument({
    orientation: 'landscape',
    issuer: renderCtx.issuer,
    info: {
      Title: `${t(useLocale, 'tax_title')} ${report.period.from}–${report.period.to}`,
      Author: renderCtx.issuer.companyName || 'picpeak',
    },
  });

  return await new Promise((resolve, reject) => {
    try {
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const leftMargin = page.marginLeft;
      // Issuer block: top-right, same width pattern as the existing
      // invoice/quote letterhead (180pt) so the branding feels
      // consistent across all admin-facing PDFs.
      const issuerWidth = 180;
      const issuerX = page.width - page.marginRight - issuerWidth;
      const issuerY = page.marginTop + 4;
      const issuerEndY = pdfService.drawIssuerBlock(
        doc, renderCtx.issuer, issuerX, issuerY, issuerWidth, useLocale
      );

      // Title block on the left.
      doc.font(fonts.bold).fontSize(18).fillColor('#000')
        .text(t(useLocale, 'tax_title'), leftMargin, page.marginTop + 4, {
          width: page.contentWidth - issuerWidth - 20, align: 'left',
        });

      doc.font(fonts.body).fontSize(10).fillColor('#333');
      const periodLine = `${t(useLocale, 'tax_period')}: ${formatDate(report.period.from, renderCtx.dateFormat)} – ${formatDate(report.period.to, renderCtx.dateFormat)}`;
      doc.text(periodLine, leftMargin, page.marginTop + 30, {
        width: page.contentWidth - issuerWidth - 20, align: 'left',
      });
      doc.text(`${t(useLocale, 'tax_currency')}: ${report.currency}`,
        leftMargin, page.marginTop + 46, {
          width: page.contentWidth - issuerWidth - 20, align: 'left',
        });

      // Table starts below whichever block (issuer or title) ends lower.
      let y = Math.max(issuerEndY, page.marginTop + 70) + 14;
      y = drawTaxTableHeader(doc, leftMargin, y, useLocale, fonts);

      doc.fontSize(8.5);
      const tableBottomLimit = page.height - page.marginBottom - 110; // leave room for totals
      const tableWidth = TAX_TABLE_COLS.reduce((s, c) => s + c.width, 0);

      if (report.rows.length === 0) {
        doc.font(fonts.body).fontSize(10).fillColor('#555')
          .text(t(useLocale, 'tax_no_invoices'), leftMargin, y + 6, {
            width: tableWidth, align: 'center',
          });
        y += 24;
      }

      // Row height is now DYNAMIC — computed per row as the max
      // rendered height across every cell at its column width. This
      // means a cell that wraps to two lines (long customer label,
      // multi-line event name, "Storniert" tag in a narrow status
      // column) makes the whole row taller instead of overlapping
      // the row below. The minimum keeps tight rows readable.
      const ROW_MIN_HEIGHT = 14;
      const ROW_VERTICAL_PADDING = 4; // space between text and the separator line
      const safeStr = (v) => (v == null ? '' : String(v));

      // Measure how tall a value would render in the given column.
      // Numeric / aligned cells use `lineBreak: false` so they never
      // wrap (they're either ints or money strings whose width we
      // budget for) — only text cells (customer, event, invoice,
      // status) opt into natural wrapping.
      const isWrappable = (col) => ['invoice', 'customer', 'event', 'status'].includes(col.key);
      const measureCellHeight = (value, col) => {
        const s = safeStr(value);
        if (!s) return 0;
        const opts = isWrappable(col)
          ? { width: col.width - 4, align: col.align }
          : { width: col.width - 4, align: col.align, lineBreak: false };
        // `doc.heightOfString` reads the current font + fontSize, so
        // we set the body font + 8.5pt before each row's measurement
        // pass and the values stay consistent with the actual draw.
        return doc.heightOfString(s, opts);
      };

      for (let i = 0; i < report.rows.length; i += 1) {
        const row = report.rows[i];
        const cells = rowCellValues(row, i + 1, useLocale, renderCtx.dateFormat);

        // Set the font BEFORE measuring so heightOfString reads the
        // exact rendering state we'll use for doc.text below.
        doc.font(fonts.body).fontSize(8.5);

        let textHeight = ROW_MIN_HEIGHT - ROW_VERTICAL_PADDING;
        for (const col of TAX_TABLE_COLS) {
          const h = measureCellHeight(cells[col.key], col);
          if (h > textHeight) textHeight = h;
        }
        const rowH = Math.ceil(textHeight) + ROW_VERTICAL_PADDING;

        // Page break check uses the actual row height we're about to
        // draw, not the old hard-coded constant — long rows can't
        // sneak past the bottom margin. Pass margins explicitly so the
        // new page inherits the same 40pt frame as page 1 — without
        // this, PDFKit's addPage falls back to its 72pt default and
        // the footer-Y math (`page.height - page.marginBottom - 12`)
        // ends up positioned for a margin the page doesn't actually
        // have, which is what made the page-number footer drift onto
        // the wrong row of subsequent pages.
        if (y + rowH > tableBottomLimit) {
          doc.addPage({
            size: 'A4', layout: 'landscape',
            margins: {
              top: page.marginTop, bottom: page.marginBottom,
              left: page.marginLeft, right: page.marginRight,
            },
          });
          y = page.marginTop;
          y = drawTaxTableHeader(doc, leftMargin, y, useLocale, fonts);
          doc.font(fonts.body).fontSize(8.5);
        }

        doc.fillColor(row.isCancelled ? '#888' : '#000');

        for (let c = 0; c < TAX_TABLE_COLS.length; c += 1) {
          const col = TAX_TABLE_COLS[c];
          const opts = isWrappable(col)
            ? { width: col.width - 4, align: col.align }
            : { width: col.width - 4, align: col.align, lineBreak: false };
          doc.text(safeStr(cells[col.key]), colX(leftMargin, c) + 2, y, opts);
        }

        // Light separator under each row, drawn at the dynamic
        // bottom edge — not at a fixed offset.
        doc.moveTo(leftMargin, y + rowH - 1)
          .lineTo(leftMargin + tableWidth, y + rowH - 1)
          .lineWidth(0.3).strokeColor('#e0e0e0').stroke();
        y += rowH;
      }

      // Totals block. Lives in the right half of the page so it
      // doesn't fight with the cancelled footnote on the left.
      //
      // Estimate the totals block height up-front: header (16) +
      // 13pt per VAT bucket row + divider (8) + three grand-total
      // rows (39) + a 12pt cushion for the footer below. If that
      // doesn't fit on the current page, force a new page now —
      // otherwise PDFKit auto-paginates mid-totals, creating phantom
      // pages whose footer ends up at unexpected Y positions on the
      // subsequent bufferedPageRange loop.
      const totalsHeightEstimate = 16 + (report.totalsByVatRate.length * 13) + 8 + 39 + 12;
      const footerReserve = 24; // 12 above + 12 of page-number text room
      if (y + 12 + totalsHeightEstimate + footerReserve > page.height - page.marginBottom) {
        doc.addPage({
          size: 'A4', layout: 'landscape',
          margins: {
            top: page.marginTop, bottom: page.marginBottom,
            left: page.marginLeft, right: page.marginRight,
          },
        });
        y = page.marginTop;
      }
      const totalsTop = y + 12;
      const totalsBoxWidth = 360;
      const totalsX = page.width - page.marginRight - totalsBoxWidth;

      doc.font(fonts.bold).fontSize(10).fillColor('#000')
        .text(t(useLocale, 'tax_totals_by_rate'), totalsX, totalsTop, {
          width: totalsBoxWidth, align: 'left',
        });

      let ty = totalsTop + 16;
      doc.font(fonts.body).fontSize(9);
      for (const bucket of report.totalsByVatRate) {
        const labelLeft = `${formatVatRate(bucket.vatRate, useLocale)}`;
        doc.text(labelLeft, totalsX, ty, { width: 80, align: 'left' });
        doc.text(formatMinor(bucket.netMinor, report.currency, intlLocale),
          totalsX + 80, ty, { width: 90, align: 'right' });
        doc.text(formatMinor(bucket.vatMinor, report.currency, intlLocale),
          totalsX + 175, ty, { width: 90, align: 'right' });
        doc.text(formatMinor(bucket.totalMinor, report.currency, intlLocale),
          totalsX + 270, ty, { width: 90, align: 'right' });
        ty += 13;
      }
      // Divider above grand totals.
      doc.moveTo(totalsX, ty + 2).lineTo(totalsX + totalsBoxWidth, ty + 2)
        .lineWidth(0.6).strokeColor('#000').stroke();
      ty += 6;
      doc.font(fonts.bold);
      doc.text(t(useLocale, 'tax_grand_total_net'), totalsX, ty, { width: 170, align: 'left' });
      doc.text(formatMinor(report.grandTotalNet, report.currency, intlLocale),
        totalsX + 175, ty, { width: 90, align: 'right' });
      ty += 13;
      doc.text(t(useLocale, 'tax_grand_total_vat'), totalsX, ty, { width: 170, align: 'left' });
      doc.text(formatMinor(report.grandTotalVat, report.currency, intlLocale),
        totalsX + 175, ty, { width: 90, align: 'right' });
      ty += 13;
      doc.text(t(useLocale, 'tax_grand_total_gross'), totalsX, ty, { width: 170, align: 'left' });
      doc.text(formatMinor(report.grandTotal, report.currency, intlLocale),
        totalsX + 270, ty, { width: 90, align: 'right' });

      // Cancelled footnote (bottom-left). Only when there are any.
      if (report.cancelledCount > 0) {
        doc.font(fonts.body).fontSize(8).fillColor('#555')
          .text(
            t(useLocale, 'tax_cancelled_footnote', { count: report.cancelledCount }),
            leftMargin, totalsTop,
            { width: page.contentWidth - totalsBoxWidth - 20, align: 'left' }
          );
      }

      // Page x of N footer (bottom-right). Done after all body
      // rendering via PDFKit's bufferPages so we know the final count
      // before stamping. Resets fill colour + font so the stamp looks
      // identical on every page regardless of where rendering ended.
      const range = doc.bufferedPageRange();
      for (let pageIdx = 0; pageIdx < range.count; pageIdx += 1) {
        doc.switchToPage(range.start + pageIdx);
        const pageLabel = t(useLocale, 'page_of', {
          current: pageIdx + 1, total: range.count,
        });
        // Position the page label just ABOVE the bottom margin —
        // keeping the baseline inside the content area prevents
        // PDFKit's layout engine from auto-paginating when the
        // 8pt-tall text wouldn't fit between the requested y and
        // the bottom of the page. The previous +6 offset pushed the
        // y into the margin, which made PDFKit add a fresh blank
        // page for every label, doubling the page count. Mirror the
        // safe `- 12` offset used by the invoice/quote renderer in
        // pdfService.renderDocument().
        doc.font(fonts.body).fontSize(8).fillColor('#888')
          .text(pageLabel,
            page.width - page.marginRight - 160,
            page.height - page.marginBottom - 12,
            { width: 160, align: 'right', lineBreak: false });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Render the tax report as a CSV string. Header row in the admin's
 * locale; numbers use a dot decimal separator (universal for CSV
 * import into Excel/Numbers/accounting software) so we don't have to
 * thread locale-specific formatting into the export.
 *
 *   renderTaxReportCsv({ from, to, currency, locale })
 *     → Promise<{ content, filename, contentType }>
 */
async function renderTaxReportCsv({ from, to, currency, locale } = {}) {
  const report = await getTaxReport({ from, to, currency });
  const useLocale = locale || 'en';

  const headers = [
    t(useLocale, 'tax_col_no'),
    t(useLocale, 'tax_col_date'),
    t(useLocale, 'tax_col_invoice'),
    t(useLocale, 'tax_col_customer'),
    t(useLocale, 'tax_col_event'),
    t(useLocale, 'tax_col_vat_rate'),
    `${t(useLocale, 'tax_col_net')} (${report.currency})`,
    `${t(useLocale, 'tax_col_vat')} (${report.currency})`,
    `${t(useLocale, 'tax_col_total')} (${report.currency})`,
    t(useLocale, 'tax_status_cancelled'),
    // Migration 126 — Skonto export. `tax_col_skonto` is the discount
    // amount in major units; admin's accountant reconciles the line.
    `${t(useLocale, 'tax_col_skonto')} (${report.currency})`,
  ];

  const escape = (cell) => {
    const s = cell === null || cell === undefined ? '' : String(cell);
    // RFC 4180: wrap in quotes when the value contains comma, quote,
    // or newline. We always wrap, simpler + bulletproof for Excel.
    return `"${s.replace(/"/g, '""')}"`;
  };

  const minorToDotDecimal = (m) => ((Number(m) || 0) / 100).toFixed(2);

  const lines = [headers.map(escape).join(',')];
  report.rows.forEach((row, i) => {
    lines.push([
      i + 1,
      row.issueDate,
      row.invoiceNumber,
      row.customerLabel,
      row.eventName,
      Number(row.vatRate).toFixed(2),
      minorToDotDecimal(row.netMinor),
      minorToDotDecimal(row.vatMinor),
      minorToDotDecimal(row.totalMinor),
      row.isCancelled ? '1' : '0',
      row.skontoApplied ? minorToDotDecimal(row.skontoAmountMinor) : '',
    ].map(escape).join(','));
  });
  // Trailing totals row: blank cells + grand totals at the end so
  // the column alignment matches the data rows when opened in Excel.
  lines.push('');
  lines.push([
    '', '', '',
    t(useLocale, 'tax_grand_total_gross'),
    '', '',
    minorToDotDecimal(report.grandTotalNet),
    minorToDotDecimal(report.grandTotalVat),
    minorToDotDecimal(report.grandTotal),
    '', '',
  ].map(escape).join(','));

  const content = lines.join('\r\n') + '\r\n';
  const filename = `tax_report_${report.period.from}_to_${report.period.to}_${report.currency}.csv`;
  return { content, filename, contentType: 'text/csv; charset=utf-8' };
}

module.exports = {
  getTaxReport,
  renderTaxReportPdf,
  renderTaxReportCsv,
  // Exposed for unit tests.
  _internal: { grossUpLateFee, computeReportedAmounts, buildCustomerLabel, formatVatRate },
};
