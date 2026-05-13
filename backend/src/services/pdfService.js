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
// 1mm = 2.834645669pt.
const MM = 2.834645669;
const PAGE = {
  // A4 ISO 216.
  width: 595.28,
  height: 841.89,
  marginTop: 40,
  marginBottom: 40,
  marginLeft: 40,
  marginRight: 40,
  contentWidth: 595.28 - 80, // 515.28
};

// DIN 5008 Form B address window — the standard window position for
// envelopes commonly used in DACH (B5 / C5-6 / DL with window). The
// window's top-left corner sits 45mm from the top and 20mm from the
// left of the A4 sheet, 85mm × 45mm in size. Picking Form B (the
// "newer" form) over Form A means the document still fits envelopes
// printed by every German/Swiss/Austrian/Liechtenstein vendor.
//
// We render INSIDE the window:
//   - Return address line (small grey "Absender" reference)
//     positioned in the upper ~5mm of the window
//   - The actual recipient address starts ~17.7mm below the top of
//     the window (DIN 5008 says address-line 1 starts on row 4 of
//     the window, which is 5mm down + 12.7mm of line-rows)
const ADDR_WINDOW = {
  left:   20 * MM,        // 56.69pt
  top:    45 * MM,        // 127.56pt
  width:  85 * MM,        // 240.94pt
  height: 45 * MM,        // 127.56pt
  // Vertical offsets inside the window.
  returnLineY: 47 * MM,   // 133.23pt — tiny "Absender" reference line
  addressY:    52 * MM,   // 147.40pt — first line of recipient address
};

// Default to PDFKit's built-in Helvetica. These constants are STILL
// used by the rest of the renderer as logical font names; when the
// admin has uploaded a custom TTF (business_profile.pdf_font_ttf_path),
// renderDocument registers it under these same names so every existing
// `doc.font(doc._fonts ? doc._fonts.body : FONT_BODY)` / `doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD)` call automatically
// picks it up. If only one weight is available we register it for both
// — bold falls back gracefully to regular.
const FONT_BODY = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const CUSTOM_BODY = 'crm-body';
const CUSTOM_BOLD = 'crm-bold';

/**
 * ISO 3166-1 alpha-2 → full country name, locale-aware. Falls back to
 * the bare code when not in the map (no need to maintain every nation
 * on earth — the user said de + en, with the issuer in LI/CH).
 *
 * Using `Intl.DisplayNames` would be neat but Node's built-in support
 * for German names is patchy across versions, so a small explicit
 * table is more reliable for the formats actually used.
 */
const COUNTRY_NAMES = {
  de: {
    LI: 'Liechtenstein', CH: 'Schweiz', AT: 'Österreich', DE: 'Deutschland',
    FR: 'Frankreich',    IT: 'Italien', ES: 'Spanien',    PT: 'Portugal',
    NL: 'Niederlande',   BE: 'Belgien', LU: 'Luxemburg',  GB: 'Vereinigtes Königreich',
    US: 'USA',           DK: 'Dänemark', SE: 'Schweden',  NO: 'Norwegen',
    FI: 'Finnland',      PL: 'Polen',   CZ: 'Tschechien', SK: 'Slowakei',
    HU: 'Ungarn',        IE: 'Irland',
  },
  en: {
    LI: 'Liechtenstein', CH: 'Switzerland', AT: 'Austria', DE: 'Germany',
    FR: 'France',        IT: 'Italy',       ES: 'Spain',   PT: 'Portugal',
    NL: 'Netherlands',   BE: 'Belgium',     LU: 'Luxembourg',
    GB: 'United Kingdom',US: 'United States',
    DK: 'Denmark',       SE: 'Sweden',      NO: 'Norway',
    FI: 'Finland',       PL: 'Poland',      CZ: 'Czechia', SK: 'Slovakia',
    HU: 'Hungary',       IE: 'Ireland',
  },
};

/**
 * Build the salutation line. When the customer record carries an
 * honorific (Herr / Frau / Mr. / Ms. / Dr.) AND a last name, we use
 * a personalised greeting; otherwise we fall back to the generic
 * locale-specific opening from the i18n dictionary.
 *
 * Recognised honorifics are matched loosely (lowercased + trimmed,
 * dot suffix stripped) so "Herr", "herr", "Mr.", "Mr" all hit. The
 * gendered forms only fire when we can pick a gender from the
 * honorific; ambiguous titles like "Dr." use the inclusive
 * "Sehr geehrte/r Dr. <last>," (German) or "Dear Dr. <last>,"
 * (English) variant.
 */
function personalSalutation(locale, salutation, lastName) {
  const honorific = (salutation || '').trim();
  const last = (lastName || '').trim();
  if (!honorific || !last) return null;
  const key = honorific.toLowerCase().replace(/\.+$/, '').trim();

  // gender from the honorific: 'm' / 'f' / null (ambiguous)
  let gender = null;
  if (['herr', 'mr', 'mister', 'monsieur', 'señor', 'senhor', 'meneer', 'sig', 'г-н', 'господин'].includes(key)) gender = 'm';
  if (['frau', 'mrs', 'ms', 'miss', 'madame', 'mademoiselle', 'señora', 'senhora', 'mevrouw', 'sig.ra', 'г-жа', 'госпожа'].includes(key)) gender = 'f';

  switch ((locale || 'de').toLowerCase()) {
  case 'de':
    if (gender === 'm') return `Sehr geehrter ${honorific} ${last},`;
    if (gender === 'f') return `Sehr geehrte ${honorific} ${last},`;
    return `Sehr geehrte/r ${honorific} ${last},`;
  case 'en':
    return `Dear ${honorific} ${last},`;
  case 'fr':
    if (gender === 'm') return `Cher ${honorific} ${last},`;
    if (gender === 'f') return `Chère ${honorific} ${last},`;
    return `Cher/Chère ${honorific} ${last},`;
  case 'nl':
    return `Geachte ${honorific} ${last},`;
  case 'pt':
    if (gender === 'm') return `Prezado ${honorific} ${last},`;
    if (gender === 'f') return `Prezada ${honorific} ${last},`;
    return `Prezado(a) ${honorific} ${last},`;
  case 'ru':
    return `Уважаемый(ая) ${honorific} ${last}!`;
  default:
    return `Dear ${honorific} ${last},`;
  }
}

function countryName(code, locale) {
  if (!code) return '';
  const upper = String(code).trim().toUpperCase().slice(0, 2);
  const dict = COUNTRY_NAMES[locale] || COUNTRY_NAMES.en;
  return dict[upper] || COUNTRY_NAMES.en[upper] || upper;
}

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

function formatDate(value, dateFormat) {
  if (!value) return '';
  const d = (value instanceof Date) ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // Respect the `general_date_format` app setting (read once in the
  // service layer and passed through ctx.dateFormat). We build the
  // string by hand instead of going through Intl.DateTimeFormat so
  // a chosen "DD.MM.YYYY" actually renders with dots even when the
  // customer's preferred_language maps to a locale that prints
  // slashes (en-GB → 02/12/2025).
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  const format = (dateFormat && dateFormat.format) || 'DD.MM.YYYY';
  switch (format) {
  case 'MM/DD/YYYY': return `${mm}/${dd}/${yyyy}`;
  case 'DD/MM/YYYY': return `${dd}/${mm}/${yyyy}`;
  case 'YYYY-MM-DD': return `${yyyy}-${mm}-${dd}`;
  case 'DD.MM.YYYY':
  default:
    return `${dd}.${mm}.${yyyy}`;
  }
}

function localeForIntl(locale) {
  // pdf-i18n uses bare ISO 639 ('de', 'en'...). Intl wants BCP-47, so
  // upgrade to a region-anchored locale where helpful.
  const map = { de: 'de-CH', en: 'en-GB', fr: 'fr-CH', nl: 'nl-NL', pt: 'pt-PT', ru: 'ru-RU' };
  return map[locale] || locale || 'en-GB';
}

/**
 * Render the issuer block (top-right): logo + company name as
 * a side-by-side banner, then the address block, then a tidy
 * label/value contact column. Matches the reference letterhead.
 *
 * Layout decisions:
 *   - Top banner: logo on the LEFT of the column with the company
 *     name vertically centred to the RIGHT of it (mirrors the
 *     "LUCA BRESCH MEDIA" branding screenshot). Either piece can be
 *     suppressed via issuer.showLogo / issuer.showCompanyName.
 *   - Address: line1 → "postal city" → CountryName, left-aligned
 *     within the right-side column.
 *   - Contact rows use two columns: "Phone:" labels at left,
 *     values aligned underneath each other. Looks like a small
 *     invisible table.
 */
function drawIssuerBlock(doc, issuer, x, y, width, locale) {
  const startY = y;
  const showLogo = issuer.showLogo !== false; // default true
  const showName = issuer.showCompanyName !== false; // default true

  // ---- top banner: logo (left) + company name (right of it) -----
  // Path resolution happens upstream in resolveLogoFile() — by the
  // time we get here, `issuer.logoPath` is either:
  //   - an absolute file path that has already been confirmed to
  //     exist on disk + filtered for PNG/JPEG, or
  //   - null when nothing resolved (logged upstream).
  // We still wrap doc.image() in try/catch because PDFKit can reject
  // valid-looking PNG/JPEG bytes (mislabelled extension, truncated
  // download, etc.) — we'd rather render the rest of the PDF than
  // crash on a broken logo.
  const logoFound = showLogo && issuer.logoPath ? issuer.logoPath : null;
  const drawLogoSafely = (file, opts) => {
    try {
      doc.image(file, opts.x, opts.y, { fit: [opts.w, opts.h] });
      return true;
    } catch (err) {
      const logger = require('../utils/logger');
      logger.warn('PDFKit failed to embed logo image', {
        path: file, err: err.message,
      });
      return false;
    }
  };

  const bannerH = 42; // shrunk from 56
  // Try to draw the logo per the chosen layout. If PDFKit rejects
  // the file (mislabelled extension, truncated bytes, etc.) we fall
  // back to the "name only" branch so the letterhead never goes
  // completely empty.
  let logoDrawn = false;
  if (logoFound && showName && issuer.companyName) {
    const logoW = Math.min(width * 0.42, 72);
    logoDrawn = drawLogoSafely(logoFound, { x, y, w: logoW, h: bannerH });
    if (logoDrawn) {
      const nameX = x + logoW + 8;
      const nameW = width - logoW - 8;
      const nameY = y + (bannerH - 12) / 2;
      doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(11).fillColor('#000')
        .text(issuer.companyName, nameX, nameY, { width: nameW, align: 'left', lineBreak: false });
      y += bannerH + 6;
    }
  } else if (logoFound) {
    logoDrawn = drawLogoSafely(logoFound, { x, y, w: width, h: bannerH });
    if (logoDrawn) y += bannerH + 6;
  }
  if (!logoDrawn && showName && issuer.companyName) {
    // Name-only branch — fires when the logo is missing, was skipped
    // by the resolver, or PDFKit refused to embed it.
    doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(12).fillColor('#000')
      .text(issuer.companyName, x, y, { width, align: 'left' });
    y = doc.y + 6;
  }

  // ---- address block (left-aligned within the column) -----------
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(8.5).fillColor('#000');
  const cityCountry = (() => {
    // Match the screenshot: "FL-9494 Schaan / Liechtenstein" on one
    // line. Fall back gracefully when fields are missing. The
    // country name comes from the explicit `countryName` override
    // when set (migration 107); otherwise we resolve it from the
    // ISO country code via the locale-aware COUNTRY_NAMES map.
    const cc = issuer.countryCode ? String(issuer.countryCode).toUpperCase() : '';
    const pc = issuer.postalCode || '';
    const city = issuer.city || '';
    const left = [cc && pc ? `${cc}-${pc}` : (pc || cc), city].filter(Boolean).join(' ');
    const country = issuer.countryName || countryName(issuer.countryCode, locale);
    return [left, country].filter(Boolean).join(' / ');
  })();
  const addressLines = [
    issuer.addressLine1,
    issuer.addressLine2,
    cityCountry,
  ].filter(Boolean);
  for (const line of addressLines) {
    doc.text(line, x, y, { width, align: 'left' });
    y = doc.y;
  }
  y += 6;

  // ---- contact rows (label / value, two columns) ----------------
  const labelCol = 38;
  const gap = 4;
  const valueCol = width - labelCol - gap;
  const labelX = x;
  const valueX = x + labelCol + gap;

  const contactRows = [
    issuer.phone   ? ['Phone:',  issuer.phone]   : null,
    issuer.mobile  ? ['Mobile:', issuer.mobile]  : null,
    issuer.email   ? ['Email:',  issuer.email]   : null,
    issuer.website ? ['Web:',    issuer.website] : null,
    issuer.vatId   ? ['VAT:',    issuer.vatId]   : null,
  ].filter(Boolean);
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(8.5);
  for (const [label, value] of contactRows) {
    const rowY = y;
    doc.text(label, labelX, rowY, { width: labelCol, align: 'left',  lineBreak: false });
    doc.text(value, valueX, rowY, { width: valueCol, align: 'left',  lineBreak: false });
    y = rowY + 11;
  }
  return Math.max(y, startY + 60);
}

/**
 * Render the recipient block INSIDE the DIN 5008 Form B address
 * window. Two parts:
 *
 *   1. Return address line (small grey "Absender" reference) at the
 *      top of the window — this is what's visible through window
 *      envelopes above the actual address, by convention separated
 *      with "*" or "·". Optional; suppressed when issuerLine is
 *      blank.
 *   2. Actual recipient block starting at ADDR_WINDOW.addressY:
 *      - With company → bold company name, then "z. Hd. <name>"
 *      - Without company → bold person name, NO attention line
 *        (avoids the "Noam Mayer / z. Hd. Noam Mayer" duplicate)
 *      - Address: Street → "POSTAL CITY" (no country prefix on
 *        postal — the country line below carries that already)
 *      - Country line in caps for window-envelope readability
 *
 * The block is positioned absolutely; the caller does not need to
 * thread a `y` cursor through. Returns the y of the next free row
 * AFTER the address window (useful when drawing the horizontal
 * divider below).
 */
function drawRecipientBlock(doc, recipient, locale) {
  const x = ADDR_WINDOW.left;
  const w = ADDR_WINDOW.width;

  // ---- tiny return address line at top of window ----------------
  if (recipient.issuerLine) {
    doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(7.5).fillColor('#555');
    doc.text(recipient.issuerLine, x, ADDR_WINDOW.returnLineY, {
      width: w, align: 'left', lineBreak: false,
    });
  }

  // ---- recipient address ----------------------------------------
  let y = ADDR_WINDOW.addressY;

  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(11).fillColor('#000');
  if (recipient.companyName) {
    doc.text(recipient.companyName, x, y, { width: w });
    y = doc.y;
  }
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(10);
  // Postal line mirrors the issuer block: "<CC>-<postal> <city>"
  // (e.g. "FL-9494 Schaan"). The country code prefix is dropped
  // when the customer has no countryCodeIso so the line still
  // reads cleanly. The country name on the line below comes from
  // the explicit `country` override (customer_accounts.country_name,
  // migration 107) or falls back to the locale-aware lookup.
  const cc = recipient.countryCodeIso ? String(recipient.countryCodeIso).toUpperCase() : '';
  const pc = recipient.postalCode || '';
  const postalLeft = cc && pc ? `${cc}-${pc}` : (pc || cc);
  const postalSegment = [postalLeft, recipient.city].filter(Boolean).join(' ');
  const lines = [
    recipient.hasCompany ? recipient.attentionLine : null,
    recipient.addressLine1,
    recipient.addressLine2,
    postalSegment,
    recipient.country || countryName(recipient.countryCodeIso, locale),
  ].filter(Boolean);
  for (const line of lines) {
    doc.text(line, x, y, { width: w });
    y = doc.y;
  }
  // Return position just below the address window so the caller
  // can position the date row / title underneath.
  return Math.max(y, ADDR_WINDOW.top + ADDR_WINDOW.height);
}

function drawTitle(doc, title, x, y) {
  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(20).fillColor('#000').text(title, x, y);
  return doc.y + 8;
}

function drawDate(doc, label, value, x, y, width) {
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(10).fillColor('#000');
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

  // Per-row padding — generous breathing room above + below the
  // text in each cell. 96pt top + 96pt bottom is intentionally
  // large; the maintainer wants the line items to feel airy.
  const ROW_PADDING = { top: 96, bottom: 96, left: 4, right: 4 };
  // Match the totals box font size; the maintainer wants the line
  // items and the billing totals to read at the same weight so the
  // eye doesn't bounce between two scales.
  const ROW_FONT_SIZE = 10;
  // Visual divider between items — thin grey rule under every data
  // row. swissqrbill PDFRow supports `borderWidth` as a 4-tuple
  // [top, right, bottom, left] and matching `borderColor`. We only
  // want the bottom line on each data row, and a slightly darker
  // bottom on the header row to anchor the column titles. The
  // grand-total divider above the sum row is drawn separately in
  // drawTotals; here we just delimit items from one another.
  const ROW_BORDER_BOTTOM_WIDTH = [0, 0, 0.5, 0];
  const ROW_BORDER_BOTTOM_COLOR = ['#000', '#000', '#cccccc', '#000'];
  const HEADER_BORDER_BOTTOM_WIDTH = [0, 0, 1, 0];
  const HEADER_BORDER_BOTTOM_COLOR = ['#000', '#000', '#000', '#000'];

  const dataRow = (li, idx) => ({
    padding: ROW_PADDING,
    fontSize: ROW_FONT_SIZE,
    borderWidth: ROW_BORDER_BOTTOM_WIDTH,
    borderColor: ROW_BORDER_BOTTOM_COLOR,
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
    // Table accepts any registered font name; if a custom font is in
    // use we route the bold row through it too.
    fontName: ctx.fonts?.bold || FONT_BOLD,
    fontSize: ROW_FONT_SIZE,
    padding: ROW_PADDING,
    borderWidth: HEADER_BORDER_BOTTOM_WIDTH,
    borderColor: HEADER_BORDER_BOTTOM_COLOR,
    header: true,
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
  // Layout: align the totals labels with the RIGHT column of the
  // payment block beneath (where "Please transfer the amount …",
  // "<Account holder>", and "<IBAN>" appear). Both columns of the
  // payment block split the page in half, so the right-column
  // anchor sits at `x + width/2 + 10` (mirrors drawPaymentBlock's
  // `rightX = x + colWidth + 20` with colWidth = (width-20)/2).
  // Values + VAT-rate column stay right-aligned to the page edge
  // so amounts still stack tabularly.
  const right = x + width;
  const valueCol = 80;
  const rateCol = 40;
  const valueX = right - valueCol;
  const rateX  = right - valueCol - rateCol;
  const labelX = x + (width - 20) / 2 + 20;  // matches drawPaymentBlock.rightX
  const labelCol = rateX - labelX - 6;       // small gap before rate column

  // Divider line ABOVE the totals block — spans the FULL page
  // content width (from the left margin to the right edge) so it
  // visually closes off the line-items table above and the totals
  // stack below as one continuous letterhead section.
  doc.moveTo(x, y).lineTo(right, y).strokeColor('#000').lineWidth(0.8).stroke();
  y += 6;

  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(10);
  doc.text(t(locale, 'totals_net'), labelX, y, { width: labelCol });
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY);
  doc.text(formatMinor(totals.netAmountMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  y = doc.y + 4;

  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).text(t(locale, 'totals_shipping'), labelX, y, { width: labelCol });
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).text(formatMinor(totals.shippingAmountMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  y = doc.y + 4;

  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).text(t(locale, 'totals_vat'), labelX, y, { width: labelCol });
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).text(`${stripTrailingZeros(totals.vatRate)}%`, rateX, y, { width: rateCol, align: 'right' });
  doc.text(formatMinor(totals.vatAmountMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  y = doc.y + 10;

  // Divider line above grand total — spans the right half of the
  // page only, from the label anchor to the right edge, so it sits
  // visually over the same column as "Please transfer …" below.
  doc.moveTo(labelX, y).lineTo(right, y).strokeColor('#000').lineWidth(0.8).stroke();
  y += 6;

  // Grand-total row uses the SAME font size as the rows above (and
  // as the line-item table) — the maintainer wants the billing
  // titles to read at one consistent scale instead of stair-
  // stepping up to a bigger headline. The row stays bold for
  // visual emphasis.
  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(10);
  doc.text(t(locale, 'totals_grand'), labelX, y, { width: labelCol });
  doc.text(formatCurrencyLabel(currency), rateX, y, { width: rateCol, align: 'right' });
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
  const { locale, paymentTerm, bank, intlLocale, totals, currency, doc: docMeta } = ctx;
  const colWidth = (width - 20) / 2;
  const leftX = x;
  const rightX = x + colWidth + 20;
  const startY = y;

  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(10).fillColor('#000');
  doc.text(t(locale, 'payment_conditions') + ':', leftX, y, { width: colWidth });
  y = doc.y + 2;
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(10);
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
    y = doc.y + 2;
    // Show the post-discount amount so the customer doesn't have to do
    // the math. Computed off the grand total (incl. VAT + shipping)
    // since that's what the discount % is applied to per CH/DE convention.
    const skontoTotalMinor = totals?.totalAmountMinor
      ? Math.round(Number(totals.totalAmountMinor) * (1 - Number(paymentTerm.skontoPercent) / 100))
      : null;
    if (skontoTotalMinor != null) {
      doc.fillColor('#444').text(
        `${t(locale, 'skonto_amount_label')}: ${formatCurrencyLabel(currency)} ${formatMinor(skontoTotalMinor, currency, intlLocale)}`,
        leftX, y, { width: colWidth }
      );
      doc.fillColor('#000');
      y = doc.y + 4;
    } else {
      y += 2;
    }
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
    doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(10);
    doc.text(t(locale, 'iban_intro'), rightX, ry, { width: colWidth });
    ry = doc.y + 4;
    doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(10);
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
  // Footer format (per design review):
  //   "<Company>, <Street>, <CC>-<PostalCode> <City>, <CountryName>"
  // e.g.
  //   "Luca Bresch Media, Im Fetzer 45a, FL-9494 Schaan, Liechtenstein"
  //
  // The previous version printed `<PostalCode> <City>, <CC>` which
  // dropped the country prefix from the postal block AND used the
  // bare ISO code instead of the full country name.
  //
  // Footer sits within the content area (above the bottom margin) —
  // writing past doc.page.height - marginBottom triggers PDFKit's
  // auto-page-break (the original bug behind the mysterious empty
  // trailing pages).
  const lineH = 12;
  const hasFooterLine = !!issuer.footerLine;
  const reserved = hasFooterLine ? lineH * 2 + 4 : lineH;
  const footerY = doc.page.height - PAGE.marginBottom - reserved;

  const cc = issuer.countryCode ? String(issuer.countryCode).toUpperCase() : '';
  const pc = issuer.postalCode || '';
  const postalLeft = cc && pc ? `${cc}-${pc}` : (pc || cc);
  const postalSegment = [postalLeft, issuer.city].filter(Boolean).join(' ');

  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(8).fillColor('#888');
  const parts = [
    issuer.companyName,
    issuer.addressLine1,
    postalSegment,
    // Prefer the explicit country_name override (migration 107)
    // before falling back to the COUNTRY_NAMES lookup.
    issuer.countryName || countryName(issuer.countryCode, locale),
  ].filter(Boolean);
  doc.text(parts.join(', '), PAGE.marginLeft, footerY, {
    width: PAGE.contentWidth, align: 'center', lineBreak: false,
  });
  if (hasFooterLine) {
    doc.text(issuer.footerLine, PAGE.marginLeft, footerY + lineH, {
      width: PAGE.contentWidth, align: 'center', lineBreak: false,
    });
  }
  // Reset fill colour so any code that runs after the footer (e.g.
  // the appendSwissQrBill page) doesn't inherit the grey.
  doc.fillColor('#000');
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

      // Optional custom font (business_profile.pdf_font_ttf_path).
      // Loaded from STORAGE_PATH/<path> if relative, or absolute as-is.
      // We rebind FONT_BODY/FONT_BOLD on the doc level by storing the
      // resolved name on `ctx.fonts`; helpers below read from there.
      // Falls back to Helvetica silently when the file is missing or
      // PDFKit fails to register it (woff2 etc.).
      // Helpers below read `doc._fonts` (one extra word per doc) so we
      // don't have to thread the font names through every drawing
      // function or fork the helpers per branding. Defaults to the
      // built-in Helvetica family.
      doc._fonts = { body: FONT_BODY, bold: FONT_BOLD };
      ctx.fonts = doc._fonts;
      if (ctx.issuer && ctx.issuer.pdfFontTtfPath) {
        try {
          const path = require('path');
          const fs = require('fs');
          const raw = ctx.issuer.pdfFontTtfPath;
          const candidates = [
            path.isAbsolute(raw) ? raw : null,
            path.join(process.cwd(), 'storage', raw.replace(/^\/+/, '')),
            path.join(process.cwd(), 'storage', 'fonts', path.basename(raw)),
          ].filter(Boolean);
          const found = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
          if (found && /\.(ttf|otf)$/i.test(found)) {
            doc.registerFont(CUSTOM_BODY, found);
            // PDFKit can't synthesise bold from a regular face, so
            // bold falls back to the same registered face. Admins who
            // want a proper bold should upload an OTF/TTF that bakes
            // it in — same convention as other PDF generators.
            doc.registerFont(CUSTOM_BOLD, found);
            doc._fonts = { body: CUSTOM_BODY, bold: CUSTOM_BOLD };
            ctx.fonts = doc._fonts;
          } else {
            const logger = require('../utils/logger');
            logger.warn('Custom PDF font path not usable; falling back to Helvetica', {
              raw, resolved: found || null,
            });
          }
        } catch (err) {
          const logger = require('../utils/logger');
          logger.warn('Failed to register custom PDF font', { err: err.message });
        }
      }

      // ---- header layout (DIN 5008 Form B) -------------------------
      //   - recipient block in the address window (top-left,
      //     45mm from top, 20mm from left, 85×45mm)
      //   - issuer block top-right (logo + company + address +
      //     contact) sized to NOT overlap the address window
      //
      // The two blocks are positioned absolutely; we keep a `y`
      // cursor for the body content that starts BELOW both blocks.
      const leftX = PAGE.marginLeft;
      // Sender block: narrower (180pt vs 220pt), further right, and
      // nudged down by 16pt so it doesn't crowd the very top of the
      // page. Leaves more breathing room for the logo + name banner.
      const issuerWidth = 180;
      const issuerX = PAGE.width - PAGE.marginRight - issuerWidth;
      const issuerY = PAGE.marginTop + 16;

      const issuerEndY = drawIssuerBlock(doc, ctx.issuer, issuerX, issuerY, issuerWidth, ctx.locale);
      const recipientEndY = drawRecipientBlock(doc, ctx.recipient, ctx.locale);
      // Start the body content below the header blocks AND the
      // address-window bottom edge — never let the date/title row
      // cut through the window region. The title position isn't
      // dictated by DIN 5008 (the spec only fixes the address window
      // position), so we pull it tight against the window's bottom
      // edge to give the body more vertical room.
      let y = Math.max(issuerEndY, recipientEndY, ADDR_WINDOW.top + ADDR_WINDOW.height) + 6;

      // ---- date row (right-aligned, matches reference) --------------
      y = drawDate(doc, t(ctx.locale, 'date'), formatDate(ctx.doc.issueDate, ctx.dateFormat),
                   leftX, y, PAGE.contentWidth);

      // ---- title ----------------------------------------------------
      const title = type === 'quote' ? t(ctx.locale, 'quote_title') : t(ctx.locale, 'invoice_title');
      y = drawTitle(doc, title, leftX, y + 2);

      // Invoice → source quote cross-reference. We deliberately keep
      // invoice numbers on a strict monotonic sequence (R-YYYY-NNNN)
      // for tax-compliance reasons (CH/LI/DE/AT require
      // "lückenlose Rechnungsnummern") — instead of mirroring the
      // quote number on the invoice, we surface the link as a small
      // "Bezug: Angebot Q-…" line under the title. Readers see the
      // provenance without breaking the numbering scheme. Only
      // rendered for invoices that came from a quote; no-op for
      // standalone invoices.
      if (type === 'invoice' && ctx.doc.sourceQuoteNumber) {
        doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(10).fillColor('#666');
        doc.text(
          `${t(ctx.locale, 'reference_label')}: ${t(ctx.locale, 'quote_title')} ${ctx.doc.sourceQuoteNumber}`,
          leftX, y, { width: PAGE.contentWidth }
        );
        y = doc.y + 6;
        doc.fillColor('#000');
      }

      // ---- salutation + lead-in ------------------------------------
      // Personalised greeting when the customer record has an
      // honorific + last name on file ("Sehr geehrter Herr Bresch,"),
      // otherwise the generic locale-specific opening from the i18n
      // dictionary ("Sehr geehrte Damen und Herren,").
      const greeting = personalSalutation(ctx.locale, ctx.recipient?.salutation, ctx.recipient?.lastName)
        || t(ctx.locale, 'salutation');
      doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(10).fillColor('#000');
      doc.text(greeting, leftX, y, { width: PAGE.contentWidth });
      y = doc.y + 4;
      doc.font(doc._fonts ? doc._fonts.body : FONT_BODY);
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
      // Top padding before the table — separates the lead-in text
      // from the header row so the items don't feel packed against
      // the salutation block.
      y += 24;
      doc.y = y;
      doc.x = leftX;
      drawLineItems(doc, ctx);
      // Bottom padding after the table — matches the top padding so
      // the line items sit visually balanced between the lead-in
      // above and the totals below.
      y = doc.y + 32;

      // ---- pin totals + payment to lower 1/3 ------------------------
      // The maintainer wants the totals + payment block anchored to
      // the lower third of the page regardless of how short the line
      // items are — short invoices should not leave a wide gap of
      // whitespace before the totals. We compute the anchor as
      // 2/3 of page height, and use max(currentY, anchor) so long
      // tables can still push everything down naturally (they'll
      // overflow to a new page via PDFKit's auto-paging).
      const LOWER_THIRD_Y = PAGE.height * 2 / 3; // ~561.26pt
      y = Math.max(y, LOWER_THIRD_Y);

      // ---- totals box (right-aligned) -------------------------------
      y = drawTotals(doc, ctx, leftX, y, PAGE.contentWidth);

      // ---- outro text -----------------------------------------------
      if (ctx.doc.outroText) {
        doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(10).fillColor('#000');
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
    // Date-format config from the `general_date_format` app setting.
    // Shape: `{ format: 'DD.MM.YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY' |
    // 'YYYY-MM-DD', locale?: string }`. The service layer hydrates
    // this; defaults to DD.MM.YYYY when unset.
    dateFormat: ctx.dateFormat || { format: 'DD.MM.YYYY' },
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
