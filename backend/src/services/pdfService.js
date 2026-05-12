/**
 * pdfService — render quote / invoice PDFs.
 *
 * Built on PDFKit + swissqrbill (the latter ships the SwissQRBill class
 * for the QR-bill payment slip + a `Table` helper for the line items).
 * Same engine renders both quotes and invoices — they differ only in
 * title, lead-in text, optional Rabatt column (quotes only) and the
 * QR-bill section (invoices only, when qr_format = 'swiss').
 *
 * Public API:
 *   renderQuoteToBuffer(context)    → Promise<Buffer>
 *   renderInvoiceToBuffer(context)  → Promise<Buffer>
 *
 * The caller (quoteService / invoiceService) hydrates the `context` from
 * the DB and passes everything in — keeping pdfService a pure renderer
 * makes both unit-tests and preview-from-form (no DB write) trivial.
 *
 * Money: every "*_minor" field is treated as INTEGER minor units
 * (cents/Rappen) and rendered via Intl.NumberFormat using the supplied
 * locale + currency.
 *
 * Layout reference: the user's existing Angebot / Rechnung templates
 * (issuer block top-right, customer block left, "Datum" line, title,
 * salutation + lead-in, line-item table, totals box right-aligned,
 * payment conditions block, IBAN block, footer).
 */

const PDFDocument = require('pdfkit');
const { SwissQRBill, Table } = require('swissqrbill/pdf');
const { t } = require('./pdf-i18n');

// Page metrics in PDF points (1pt = 1/72in). A4 = 595.28 × 841.89.
const PAGE = {
  marginTop: 40,
  marginBottom: 40,
  marginLeft: 40,
  marginRight: 40,
  contentWidth: 595.28 - 80, // 515.28
};

const FONT_BODY = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

/**
 * Format a minor-unit BigInt-ish integer as a localised currency string.
 * Returns just the number portion ("750.00") not "CHF 750.00" — the
 * currency label is rendered separately in the totals box for layout
 * reasons (matches the reference PDFs).
 */
function formatMinor(minor, currency, locale = 'de-CH') {
  const value = Number(minor || 0) / 100;
  // We render only the number — currency renders as a separate column
  // to keep totals right-aligned cleanly.
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCurrencyLabel(currency) {
  // Render the ISO code; matches the user's reference PDFs which show
  // "Gesamtbetrag CHF 750.00".
  return (currency || '').toUpperCase();
}

function formatDate(value, locale) {
  if (!value) return '';
  const d = (value instanceof Date) ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // Match the user's reference layout: "02.12.25" / "30.01.26".
  try {
    return new Intl.DateTimeFormat(locale || 'de-CH', {
      day: '2-digit', month: '2-digit', year: '2-digit',
    }).format(d);
  } catch (_) {
    return d.toISOString().slice(0, 10);
  }
}

function localeForIntl(locale) {
  // pdf-i18n uses bare ISO 639 ('de', 'en'...). Intl wants BCP-47, so
  // upgrade to a region-anchored locale where helpful.
  const map = { de: 'de-CH', en: 'en-GB', fr: 'fr-CH', nl: 'nl-NL', pt: 'pt-PT', ru: 'ru-RU' };
  return map[locale] || locale || 'en-GB';
}

/**
 * Render the issuer block (top-right): company name bold + multiline
 * address + phone/mobile/email/website. Matches reference layout.
 */
function drawIssuerBlock(doc, issuer, x, y, width) {
  const startY = y;

  // Logo (top-right above the issuer text) — relative path stored
  // in business_profile.logo_path is resolved against the storage/
  // root. Drawn only if the file exists; absence is silent so an
  // unconfigured profile still renders cleanly.
  if (issuer.logoPath) {
    try {
      const path = require('path');
      const fs = require('fs');
      const candidates = [
        // Absolute path (admin pasted a full path).
        path.isAbsolute(issuer.logoPath) ? issuer.logoPath : null,
        // Under storage/ root (what the branding upload returns).
        path.join(process.cwd(), 'storage', issuer.logoPath.replace(/^\/+/, '')),
        // Already under public storage path.
        path.join(process.cwd(), 'storage', 'branding', path.basename(issuer.logoPath)),
      ].filter(Boolean);
      const found = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
      if (found) {
        const logoH = 50; // ~17.6mm tall — matches the reference letterhead
        const logoMaxW = Math.min(width, 160);
        // image() at (x, y) with fit:[w,h] preserves aspect ratio. We
        // right-anchor by placing the box such that its right edge
        // aligns with the issuer block's right edge.
        doc.image(found, x + width - logoMaxW, y, { fit: [logoMaxW, logoH], align: 'right' });
        y += logoH + 8;
      }
    } catch (_err) {
      // Logo failures don't break the whole PDF — just skip.
    }
  }

  doc.font(FONT_BOLD).fontSize(13);
  if (issuer.companyName) {
    doc.text(issuer.companyName, x, y, { width, align: 'right' });
    y = doc.y + 4;
  }
  doc.font(FONT_BODY).fontSize(9);
  const addressLines = [
    issuer.addressLine1,
    issuer.addressLine2,
    [issuer.postalCode, issuer.city].filter(Boolean).join(' '),
    issuer.state ? `${issuer.state}` : '',
    issuer.countryCode ? issuer.countryCode : '',
  ].filter(Boolean);
  for (const line of addressLines) {
    doc.text(line, x, y, { width, align: 'right' });
    y = doc.y;
  }
  y += 6;
  const contactLines = [
    issuer.phone   ? `Phone: ${issuer.phone}`     : null,
    issuer.mobile  ? `Mobile: ${issuer.mobile}`   : null,
    issuer.email   ? `Email: ${issuer.email}`     : null,
    issuer.website ? `Web: ${issuer.website}`     : null,
    issuer.vatId   ? `VAT: ${issuer.vatId}`       : null,
  ].filter(Boolean);
  for (const line of contactLines) {
    doc.text(line, x, y, { width, align: 'right' });
    y = doc.y;
  }
  return Math.max(y, startY + 80);
}

/**
 * Render the recipient block (top-left): company / name + multiline
 * address. recipient comes pre-shaped by the calling service.
 */
function drawRecipientBlock(doc, recipient, x, y, width) {
  doc.font(FONT_BODY).fontSize(8.5).fillColor('#666')
    .text(`${recipient.issuerLine || ''}`, x, y, { width });
  y = doc.y + 8;
  doc.font(FONT_BOLD).fontSize(11).fillColor('#000');
  if (recipient.companyName) {
    doc.text(recipient.companyName, x, y, { width });
    y = doc.y;
  }
  doc.font(FONT_BODY).fontSize(10);
  const lines = [
    recipient.attentionLine,
    recipient.addressLine1,
    recipient.addressLine2,
    [recipient.postalCode, recipient.city].filter(Boolean).join(' '),
    recipient.country,
  ].filter(Boolean);
  for (const line of lines) {
    doc.text(line, x, y, { width });
    y = doc.y;
  }
  return y;
}

function drawTitle(doc, title, x, y) {
  doc.font(FONT_BOLD).fontSize(20).fillColor('#000').text(title, x, y);
  return doc.y + 8;
}

function drawDate(doc, label, value, x, y, width) {
  doc.font(FONT_BODY).fontSize(10).fillColor('#000');
  const right = x + width;
  const labelWidth = 80;
  doc.text(`${label}:`, right - labelWidth - 80, y, { width: 80, align: 'right' });
  doc.text(value, right - 80, y, { width: 80, align: 'right' });
  return doc.y + 10;
}

/**
 * Render the line-items table via swissqrbill's Table helper. We supply
 * widths in points; the helper draws the borderless layout the
 * reference PDF uses.
 *
 * Columns (quotes):   Pos / Anzahl / Beschreibung / Rabatt / Einzelpreis / Summe
 * Columns (invoices): Pos / Anzahl / Beschreibung / Einzelpreis / Summe
 */
function drawLineItems(doc, ctx) {
  const { type, locale, lineItems, currency, intlLocale } = ctx;
  const labels = {
    pos:   t(locale, 'table_pos'),
    qty:   t(locale, 'table_qty'),
    desc:  t(locale, 'table_description'),
    disc:  t(locale, 'table_discount'),
    unit:  t(locale, 'table_unit_price'),
    total: t(locale, 'table_line_total'),
  };

  const showDiscount = type === 'quote' && lineItems.some((li) => Number(li.discountPercent) > 0);

  // Column widths sum to PAGE.contentWidth = 515.28. swissqrbill's
  // PDFColumn carries `width` + `align` directly on each cell; there
  // is NO top-level `columns: [...]` on the Table constructor. The
  // previous attempt to pass column widths separately was a no-op,
  // which is why numeric cells were left-aligned even though their
  // headers were right-aligned (header `textOptions.align` happened
  // to work on PDFKit's underlying text() call, but cell-level
  // alignment needs the API-supported `align` property).
  const widths = showDiscount
    ? [30, 40, 240, 50, 75, 80]
    : [30, 50, 280, 70, 85];

  const dataRow = (li, idx) => ({
    columns: showDiscount
      ? [
          { text: String(idx + 1),                                                  width: widths[0], align: 'left'  },
          { text: stripTrailingZeros(li.quantity),                                  width: widths[1], align: 'left'  },
          { text: li.description,                                                   width: widths[2], align: 'left'  },
          { text: `${stripTrailingZeros(li.discountPercent)}%`,                     width: widths[3], align: 'right' },
          { text: formatMinor(li.unitPriceMinor, currency, intlLocale),             width: widths[4], align: 'right' },
          { text: formatMinor(li.lineTotalMinor, currency, intlLocale),             width: widths[5], align: 'right' },
        ]
      : [
          { text: String(idx + 1),                                                  width: widths[0], align: 'left'  },
          { text: stripTrailingZeros(li.quantity),                                  width: widths[1], align: 'left'  },
          { text: li.description,                                                   width: widths[2], align: 'left'  },
          { text: formatMinor(li.unitPriceMinor, currency, intlLocale),             width: widths[3], align: 'right' },
          { text: formatMinor(li.lineTotalMinor, currency, intlLocale),             width: widths[4], align: 'right' },
        ],
  });

  const headerRow = {
    fontName: FONT_BOLD,
    fontSize: 9,
    columns: showDiscount
      ? [
          { text: labels.pos,   width: widths[0], align: 'left'  },
          { text: labels.qty,   width: widths[1], align: 'left'  },
          { text: labels.desc,  width: widths[2], align: 'left'  },
          { text: labels.disc,  width: widths[3], align: 'right' },
          { text: labels.unit,  width: widths[4], align: 'right' },
          { text: labels.total, width: widths[5], align: 'right' },
        ]
      : [
          { text: labels.pos,   width: widths[0], align: 'left'  },
          { text: labels.qty,   width: widths[1], align: 'left'  },
          { text: labels.desc,  width: widths[2], align: 'left'  },
          { text: labels.unit,  width: widths[3], align: 'right' },
          { text: labels.total, width: widths[4], align: 'right' },
        ],
  };

  const table = new Table({
    width: PAGE.contentWidth,
    rows: [headerRow, ...lineItems.map(dataRow)],
  });
  table.attachTo(doc);
  return doc.y;
}

function stripTrailingZeros(value) {
  if (value == null) return '';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  const s = num.toString();
  // Only strip zeros AFTER the decimal point. Naively replacing
  // `/\.?0+$/` also ate the trailing zero in whole numbers like
  // "10" → "1", which made a quantity of 10 render as 1 on the
  // PDF while the total (qty * unit) stayed correct: Anzahl=10,
  // Einzelpreis 123, Summe 1230, but the column read "1".
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '') || '0';
}

/**
 * Totals box, right-aligned. Two columns: label (left), value (right).
 * VAT row drops when rate is 0 + amount is 0? No — reference shows
 * "ges. MwSt. 0.0% 0.00" so we keep it visible.
 */
function drawTotals(doc, ctx, x, y, width) {
  const { locale, currency, intlLocale, totals } = ctx;
  const labelCol = 130;
  const valueCol = 80;
  const right = x + width;
  const labelX = right - labelCol - valueCol - 30;
  const rateX  = right - valueCol - 30;
  const valueX = right - valueCol;

  doc.font(FONT_BOLD).fontSize(10);
  doc.text(t(locale, 'totals_net'), labelX, y, { width: labelCol });
  doc.font(FONT_BODY);
  doc.text(formatMinor(totals.netAmountMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  y = doc.y + 4;

  doc.font(FONT_BOLD).text(t(locale, 'totals_shipping'), labelX, y, { width: labelCol });
  doc.font(FONT_BODY).text(formatMinor(totals.shippingAmountMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  y = doc.y + 4;

  doc.font(FONT_BOLD).text(t(locale, 'totals_vat'), labelX, y, { width: labelCol });
  doc.font(FONT_BODY).text(`${stripTrailingZeros(totals.vatRate)}%`, rateX, y, { width: 40, align: 'right' });
  doc.text(formatMinor(totals.vatAmountMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  y = doc.y + 10;

  // Divider line above grand total.
  doc.moveTo(labelX, y).lineTo(right, y).strokeColor('#000').lineWidth(0.8).stroke();
  y += 6;

  doc.font(FONT_BOLD).fontSize(12);
  doc.text(t(locale, 'totals_grand'), labelX, y, { width: labelCol });
  doc.text(formatCurrencyLabel(currency), rateX, y, { width: 40, align: 'right' });
  doc.text(formatMinor(totals.totalAmountMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  return doc.y + 10;
}

/**
 * Render the payment conditions + IBAN block. Two columns side by side
 * matching the reference layout:
 *   left: "Payment conditions: <text>. The amount must be paid within
 *         30 days from invoice date."
 *   right: "Please transfer the amount to the following bank account:
 *          <IBAN>"
 */
function drawPaymentBlock(doc, ctx, x, y, width) {
  const { locale, paymentTerm, bank, intlLocale, doc: docMeta } = ctx;
  const colWidth = (width - 20) / 2;
  const leftX = x;
  const rightX = x + colWidth + 20;
  const startY = y;

  doc.font(FONT_BOLD).fontSize(10).fillColor('#000');
  doc.text(t(locale, 'payment_conditions') + ':', leftX, y, { width: colWidth });
  y = doc.y + 2;
  doc.font(FONT_BODY).fontSize(10);
  if (paymentTerm?.description) {
    doc.text(paymentTerm.description, leftX, y, { width: colWidth });
    y = doc.y + 4;
  }
  if (paymentTerm?.netDays) {
    doc.text(
      `${paymentTerm.netDays} ${t(locale, 'net_days_suffix')}`,
      leftX, y, { width: colWidth }
    );
    y = doc.y + 4;
  }
  if (paymentTerm?.skontoPercent && paymentTerm?.skontoWithinDays) {
    doc.text(
      t(locale, 'skonto_phrase', {
        percent: stripTrailingZeros(paymentTerm.skontoPercent),
        days: paymentTerm.skontoWithinDays,
      }),
      leftX, y, { width: colWidth }
    );
    y = doc.y + 4;
  }
  // Late fee note for second-reminder invoices.
  if (docMeta?.lateFeeMinor && Number(docMeta.lateFeeMinor) > 0) {
    doc.fillColor('#a00').text(
      t(locale, 'late_fee_note', {
        amount: `${formatCurrencyLabel(ctx.currency)} ${formatMinor(docMeta.lateFeeMinor, ctx.currency, intlLocale)}`,
      }),
      leftX, y, { width: colWidth }
    );
    doc.fillColor('#000');
    y = doc.y + 4;
  }

  // Right column: IBAN.
  let ry = startY;
  if (bank) {
    doc.font(FONT_BOLD).fontSize(10);
    doc.text(t(locale, 'iban_intro'), rightX, ry, { width: colWidth });
    ry = doc.y + 4;
    doc.font(FONT_BODY).fontSize(10);
    if (bank.accountHolder) {
      doc.text(bank.accountHolder, rightX, ry, { width: colWidth });
      ry = doc.y;
    }
    if (bank.iban) {
      const formatted = bank.iban.replace(/(.{4})/g, '$1 ').trim();
      doc.text(formatted, rightX, ry, { width: colWidth });
      ry = doc.y;
    }
    if (bank.bic) {
      doc.text(`BIC: ${bank.bic}`, rightX, ry, { width: colWidth });
      ry = doc.y;
    }
  }
  return Math.max(y, ry) + 8;
}

function drawFooter(doc, issuer, locale) {
  const footerY = doc.page.height - PAGE.marginBottom + 5;
  doc.font(FONT_BODY).fontSize(8).fillColor('#888');
  const parts = [
    issuer.companyName,
    issuer.addressLine1,
    [issuer.postalCode, issuer.city].filter(Boolean).join(' '),
    issuer.countryCode,
  ].filter(Boolean);
  doc.text(parts.join(', '), PAGE.marginLeft, footerY, {
    width: PAGE.contentWidth, align: 'center',
  });
  if (issuer.footerLine) {
    doc.text(issuer.footerLine, PAGE.marginLeft, footerY + 12, {
      width: PAGE.contentWidth, align: 'center',
    });
  }
}

/**
 * Add the Swiss QR-bill payment slip on a fresh page. This is rendered
 * by the swissqrbill library — we just feed it the issuer/recipient/
 * amount. For non-swiss QR formats this returns without adding a page.
 *
 * The QR-bill spec REQUIRES the slip on a separate physical page, full
 * width at the bottom — swissqrbill handles all of that.
 */
function appendSwissQrBill(doc, ctx) {
  if (ctx.qrFormat !== 'swiss') return;
  const { issuer, bank, doc: docMeta, recipient } = ctx;
  if (!bank?.iban) return;

  doc.addPage();

  // swissqrbill expects amounts in major units (CHF, not Rappen).
  const totalMajor = Number(docMeta.totalAmountMinor || 0) / 100;

  try {
    const qr = new SwissQRBill({
      currency: (ctx.currency || 'CHF').toUpperCase() === 'EUR' ? 'EUR' : 'CHF',
      amount: totalMajor > 0 ? totalMajor : undefined,
      creditor: {
        name: bank.accountHolder || issuer.companyName || '',
        address: issuer.addressLine1 || '',
        zip: issuer.postalCode || '',
        city: issuer.city || '',
        country: (issuer.countryCode || 'CH').toUpperCase(),
        account: bank.iban.replace(/\s+/g, ''),
      },
      debtor: recipient?.companyName ? {
        name: recipient.companyName.slice(0, 70),
        address: recipient.addressLine1 || '',
        zip: recipient.postalCode || '',
        city: recipient.city || '',
        country: (recipient.countryCodeIso || 'CH').toUpperCase(),
      } : undefined,
      message: docMeta.invoiceNumber ? `${docMeta.invoiceNumber}` : undefined,
    });
    qr.attachTo(doc);
  } catch (err) {
    // Don't kill PDF rendering if QR generation fails — log + carry on.
    // The invoice without QR is still legally valid; admin gets a flag
    // via the calling service.
    const logger = require('../utils/logger');
    logger.warn('SwissQRBill render failed; emitting invoice without QR section', { err: err.message });
  }
}

/**
 * The main renderer. `type` is 'quote' | 'invoice'. Returns Buffer.
 */
function renderDocument(type, context) {
  return new Promise((resolve, reject) => {
    try {
      const ctx = normaliseContext(type, context);
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: PAGE.marginTop, bottom: PAGE.marginBottom,
          left: PAGE.marginLeft, right: PAGE.marginRight,
        },
        info: {
          Title: ctx.doc.invoiceNumber || ctx.doc.quoteNumber || (type === 'quote' ? 'Quote' : 'Invoice'),
          Author: ctx.issuer.companyName || 'picpeak',
        },
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ---- header row (issuer right, recipient left) ----------------
      const headerY = PAGE.marginTop;
      const halfWidth = (PAGE.contentWidth - 20) / 2;
      const leftX = PAGE.marginLeft;
      const rightX = PAGE.marginLeft + halfWidth + 20;

      const issuerEndY = drawIssuerBlock(doc, ctx.issuer, rightX, headerY, halfWidth);
      const recipientEndY = drawRecipientBlock(doc, ctx.recipient, leftX, headerY + 60, halfWidth);
      let y = Math.max(issuerEndY, recipientEndY) + 16;

      // ---- date row -------------------------------------------------
      y = drawDate(doc, t(ctx.locale, 'date'), formatDate(ctx.doc.issueDate, ctx.intlLocale),
                   leftX, y, PAGE.contentWidth);

      // ---- title ----------------------------------------------------
      const title = type === 'quote' ? t(ctx.locale, 'quote_title') : t(ctx.locale, 'invoice_title');
      y = drawTitle(doc, title, leftX, y + 4);

      // ---- salutation + lead-in ------------------------------------
      doc.font(FONT_BOLD).fontSize(10).fillColor('#000');
      doc.text(t(ctx.locale, 'salutation'), leftX, y, { width: PAGE.contentWidth });
      y = doc.y + 4;
      doc.font(FONT_BODY);
      const leadIn = type === 'quote'
        ? t(ctx.locale, 'lead_in_quote')
        : t(ctx.locale, 'lead_in_invoice');
      doc.text(leadIn, leftX, y, { width: PAGE.contentWidth });
      y = doc.y + 16;

      // ---- intro text override (admin-customisable) -----------------
      if (ctx.doc.introText) {
        doc.text(ctx.doc.introText, leftX, y, { width: PAGE.contentWidth });
        y = doc.y + 12;
      }

      // ---- line items table ----------------------------------------
      doc.y = y;
      doc.x = leftX;
      drawLineItems(doc, ctx);
      y = doc.y + 16;

      // ---- totals box (right-aligned) -------------------------------
      y = drawTotals(doc, ctx, leftX, y, PAGE.contentWidth);

      // ---- outro text -----------------------------------------------
      if (ctx.doc.outroText) {
        doc.font(FONT_BODY).fontSize(10).fillColor('#000');
        doc.text(ctx.doc.outroText, leftX, y, { width: PAGE.contentWidth });
        y = doc.y + 12;
      }

      // ---- payment conditions + IBAN block --------------------------
      y = drawPaymentBlock(doc, ctx, leftX, y, PAGE.contentWidth);

      // ---- footer ---------------------------------------------------
      drawFooter(doc, ctx.issuer, ctx.locale);

      // ---- swiss QR-bill on fresh page ------------------------------
      if (type === 'invoice') {
        appendSwissQrBill(doc, ctx);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Normalise + default the context shape so the rest of the renderer
 * can rely on it without optional-chaining everywhere.
 */
function normaliseContext(type, ctx) {
  const locale = ctx.locale || 'de';
  return {
    type,
    locale,
    intlLocale: localeForIntl(locale),
    currency: (ctx.currency || ctx.doc?.currency || ctx.issuer?.defaultCurrency || 'CHF').toUpperCase(),
    issuer: ctx.issuer || {},
    recipient: ctx.recipient || {},
    bank: ctx.bank || null,
    paymentTerm: ctx.paymentTerm || null,
    lineItems: Array.isArray(ctx.lineItems) ? ctx.lineItems : [],
    totals: ctx.totals || {},
    doc: ctx.doc || {},
    qrFormat: ctx.qrFormat || 'none',
  };
}

async function renderQuoteToBuffer(context) {
  return renderDocument('quote', context);
}

async function renderInvoiceToBuffer(context) {
  return renderDocument('invoice', context);
}

module.exports = {
  renderQuoteToBuffer,
  renderInvoiceToBuffer,
  // Exposed for unit tests + advanced callers.
  _internal: { formatMinor, formatDate, t },
};
