/**
 * How a quote or invoice fills its pages (#1546).
 *
 * The totals used to be pinned to a fixed distance from the page bottom, and
 * the payment slip always took a page of its own. An invoice with three
 * detailed line items came out over three pages: items and a large gap on the
 * first, the totals alone at the bottom of the second, the slip on the third.
 *
 * What is pinned here:
 *   - the totals follow the line items, and only move to a new page when what
 *     is left of the current one can't hold them;
 *   - the QR-bill shares the last content page when the closing blocks leave
 *     it room, and keeps a page of its own when they don't;
 *   - on a page it shares, the footer and the page number move above the
 *     slip's reserved 105 mm, and that page still counts;
 *   - a continuation page names the document it belongs to;
 *   - references ("Bezug: …") are rows of the meta block, above the title;
 *   - a service date that only repeats the issue date is left out.
 */

const PDFDocument = require('pdfkit');
const { PDFDocument: PdfLib } = require('pdf-lib');
const pdfService = require('../../src/services/pdfService');
const { builtInTheme } = require('../../src/services/pdf/theme');
const { t } = require('../../src/services/pdf-i18n');

/** The slip's reserved area: the bottom 105 mm (62 mm receipt + 148 mm part). */
const BAND_HEIGHT = (105 / 25.4) * 72;

const issuer = {
  companyName: 'Studio Test', addressLine1: 'Weg 1', postalCode: '9490', city: 'Vaduz',
  countryCode: 'LI', phone: '+423 000 00 00', vatId: 'CHE-123.456.789 MWST',
  // Two footer lines: the layout has to keep the content clear of both.
  footerLine: 'Bank: Testbank',
};
const recipient = { companyName: 'Kunde AG', addressLine1: 'Gasse 2', postalCode: '8001', city: 'Zürich' };
const bank = { accountHolder: 'Studio Test', iban: 'CH93 0076 2011 6238 5295 7', bic: 'TESTLI22' };
const paymentTerm = {
  description: 'Zahlbar innert 30 Tagen netto.', netDays: 30, skontoPercent: 2, skontoWithinDays: 10,
};

const shortItem = (n) => ({
  quantity: 1, description: `Position ${n}`, unitPriceMinor: 15000, discountPercent: 0, lineTotalMinor: 15000,
});
const longItem = (n) => ({
  quantity: 1, discountPercent: 0, unitPriceMinor: 120000, lineTotalMinor: 120000,
  description: `Fotoreportage Tag ${n} — Reportage vor Ort inklusive Anfahrt, Aufbau und Abbau. `
    + 'Lieferung der bearbeiteten Bilder innert 10 Arbeitstagen über die Online-Galerie. '
    + 'Enthalten sind mindestens 120 ausgewählte und bearbeitete Aufnahmen in voller Auflösung. '
    + 'Nutzungsrechte zeitlich und räumlich unbeschränkt für die interne und externe Kommunikation.',
});

const totalsFor = (items) => {
  const net = items.reduce((sum, it) => sum + it.lineTotalMinor, 0);
  const vat = Math.round(net * 0.081);
  return {
    netAmountMinor: net, vatRate: 8.1, vatAmountMinor: vat,
    shippingAmountMinor: 0, totalAmountMinor: net + vat,
  };
};

const invoice = (items, extra = {}, docExtra = {}) => ({
  locale: 'de', currency: 'CHF', qrFormat: 'none', issuer, recipient, bank, paymentTerm,
  theme: builtInTheme('invoice'), lineItems: items, totals: totalsFor(items),
  doc: {
    kind: 'invoice', invoiceNumber: 'R-2026-0001', issueDate: '2026-09-14', dueDate: '2026-10-14',
    totalAmountMinor: totalsFor(items).totalAmountMinor, ...docExtra,
  },
  ...extra,
});

afterEach(() => jest.restoreAllMocks());

/**
 * Every string the render drew, with the position it was drawn at.
 *
 * The renderer measures its closing blocks by drawing them into a scrap
 * document first (measureClosingHeight), so the spy sees two documents. Only
 * the one that is actually emitted matters here, and it is the first one
 * constructed — the header is drawn before anything is measured.
 */
function recordDrawing() {
  const drawn = [];
  const original = PDFDocument.prototype.text;
  jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function record(text, x, y) {
    // The active size has to be read here: by the time the test looks, the
    // document has moved on.
    drawn.push({
      text: String(text),
      x: typeof x === 'number' ? x : null,
      y: typeof y === 'number' ? y : null,
      size: this._fontSize,
      doc: this,
    });
    return original.apply(this, arguments);
  });
  return () => drawn.filter((call) => call.doc === drawn[0].doc);
}

const find = (calls, needle) => calls.find((c) => c.text.includes(needle));
/** For a word that is also part of a label — "Rechnung" inside "Rechnungsnummer". */
const findExact = (calls, text) => calls.find((c) => c.text === text);
const pageCount = async (buffer) => (await PdfLib.load(buffer)).getPageCount();

const netLabel = t('de', 'totals_net');
const skontoLabel = t('de', 'skonto_amount_label');

const findAll = (calls, needle) => calls.filter((c) => c.text.includes(needle));
const amount = (text) => Number(String(text).replace(/[^\d.,-]/g, '').replace(/'/g, '').replace(',', '.'));
/** The figure in a table row: its cells are drawn in column order, empties included. */
const rowAmount = (calls, row) => {
  const at = calls.indexOf(row);
  return amount(calls.slice(at + 1, at + 6).find((c) => /\d/.test(c.text)).text);
};

describe('the totals', () => {
  test('are pinned to the foot of the last page, wherever the table ended', async () => {
    const drawn = recordDrawing();
    const short = await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)]));
    const shortY = find(drawn(), netLabel).y;

    jest.restoreAllMocks();
    const drawnLong = recordDrawing();
    const long = await pdfService.renderInvoiceToBuffer(invoice([longItem(1), longItem(2)]));

    // One short row or two long ones — the totals sit at the same height,
    // because they are anchored to the foot of the page rather than following
    // the table.
    expect(find(drawnLong(), netLabel).y).toBeCloseTo(shortY, 1);
    expect(await pageCount(short)).toBe(1);
    expect(await pageCount(long)).toBe(1);
  });

  test('flow instead of pinning when the closing text is taller than the page', async () => {
    // An outro is accepted up to 5000 characters. Measuring it on an A4 scrap
    // used to let PDFKit break the text and re-base the cursor, so the height
    // came back a page short and the blocks were pinned over the footer.
    const outroText = 'Lorem ipsum dolor sit amet, consetetur sadipscing elitr. '.repeat(90);
    const drawn = recordDrawing();
    const buffer = await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], {}, { outroText }));
    const calls = drawn();

    expect(await pageCount(buffer)).toBeGreaterThan(1);
    const footer = find(calls, issuer.footerLine);
    const lastClosingLine = find(calls, skontoLabel);
    expect(footer.y - lastClosingLine.y).toBeGreaterThan(6);
  });

  test('clear the footer, whatever the payment block holds', async () => {
    const items = Array.from({ length: 30 }, (_, i) => shortItem(i + 1));
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice(items, { qrFormat: 'swiss' }));

    // The closing blocks are pinned, so an underestimate of their height is
    // drawn straight over the footer rather than merely risking it.
    const lastClosingLine = find(drawn(), skontoLabel);
    const footer = find(drawn(), issuer.footerLine);
    expect(footer.y - lastClosingLine.y).toBeGreaterThan(6);
  });

  test('keep their distance from the last row rather than crowding it', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)]));
    const calls = drawn();
    expect(find(calls, netLabel).y).toBeGreaterThan(find(calls, 'Position 1').y);
  });
});

describe('drawIssuerBlock without a grid', () => {
  // The contract renderer and the tax report call it on their own, passing a
  // column but no grid. Its rows have to line up with that column, not with
  // whatever the invoice's meta block happened to measure.
  test('puts its contact rows at the column it was given', () => {
    const doc = new PDFDocument({ size: 'A4' });
    const drawn = recordDrawing();
    const left = 300;
    pdfService.drawIssuerBlock(doc, {
      companyName: 'Studio Test', addressLine1: 'Weg 1', postalCode: '9490', city: 'Vaduz',
      countryCode: 'LI', phone: '+423 000 00 00', email: 'me@example.com',
    }, left, 40, 180, 'de');
    const calls = drawn();

    expect(find(calls, 'Weg 1').x).toBe(left);
    expect(find(calls, `${t('de', 'contact_phone')}:`).x).toBe(left);
    expect(find(calls, `${t('de', 'contact_email')}:`).x).toBe(left);
  });
});

describe('the type scale', () => {
  const sizeOf = (calls, needle) => find(calls, needle).size;

  test('follows the theme\'s body size through the whole document', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)]));
    const standard = drawn();

    jest.restoreAllMocks();
    const drawnLarge = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], {
      theme: { ...builtInTheme('invoice'), bodySize: 12 },
    }));
    const large = drawnLarge();

    // The money blocks sit at the body size, the fine print two steps below.
    expect(sizeOf(standard, netLabel)).toBe(10);
    expect(sizeOf(standard, t('de', 'payment_conditions'))).toBe(10);
    expect(sizeOf(standard, issuer.footerLine)).toBe(8);

    expect(sizeOf(large, netLabel)).toBe(12);
    expect(sizeOf(large, t('de', 'payment_conditions'))).toBe(12);
    expect(sizeOf(large, issuer.footerLine)).toBe(10);
  });
});

describe('the carry-over', () => {
  const carry = t('de', 'table_carry_forward');

  test('closes a page that continues and opens the one that continues it', async () => {
    const items = Array.from({ length: 30 }, (_, i) => shortItem(i + 1));
    const drawn = recordDrawing();
    const buffer = await pdfService.renderInvoiceToBuffer(invoice(items));
    const rows = findAll(drawn(), carry);

    expect(await pageCount(buffer)).toBe(2);
    expect(rows).toHaveLength(2);
    // Drawn in that order: the row that closes the first page, then the one
    // that opens the second.
    expect(rows[0].y).toBeGreaterThan(600);
    expect(rows[1].y).toBeLessThan(150);
  });

  test('carries the running net of the rows above it, the same figure on both pages', async () => {
    const items = Array.from({ length: 30 }, (_, i) => shortItem(i + 1));
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice(items));
    const calls = drawn();

    // Each row is 150.00; the carry is a partial sum of them, so a whole
    // multiple of 150 that falls short of the 4'500.00 net.
    const rows = findAll(calls, carry);
    const carried = rows.map((row) => rowAmount(calls, row));
    expect(carried[0]).toBe(carried[1]);
    expect(carried[0] % 150).toBe(0);
    expect(carried[0]).toBeGreaterThan(0);
    expect(carried[0]).toBeLessThan(4500);
  });

  test('repeats for every break, carrying the cumulative net each time', async () => {
    const items = Array.from({ length: 60 }, (_, i) => shortItem(i + 1));
    const drawn = recordDrawing();
    const buffer = await pdfService.renderInvoiceToBuffer(invoice(items));
    const calls = drawn();
    const rows = findAll(calls, carry);

    // Three pages of table: two breaks, each printing the figure at the foot
    // of the page it closes and again at the head of the next.
    expect(await pageCount(buffer)).toBeGreaterThan(2);
    expect(rows).toHaveLength(4);

    const carried = rows.map((row) => rowAmount(calls, row));
    expect(carried[0]).toBe(carried[1]);
    expect(carried[2]).toBe(carried[3]);
    // Cumulative from the first row, not a per-page subtotal — which is what
    // makes "Übertrag" the right word for it.
    expect(carried[2]).toBeGreaterThan(carried[0]);
    expect(carried[2]).toBeLessThan(60 * 150);
    carried.forEach((amount) => expect(amount % 150).toBe(0));
  });

  test('is absent from a table that fits on one page', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1), shortItem(2)]));
    expect(findAll(drawn(), carry)).toHaveLength(0);
  });

  test('leaves an unbooked add-on out of the figure it carries', async () => {
    const items = Array.from({ length: 30 }, (_, i) => shortItem(i + 1));
    items[0] = { ...items[0], excluded: true };
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice(items));
    const calls = drawn();

    const rows = findAll(calls, carry);
    const carried = rowAmount(calls, rows[0]);
    // The excluded row's 150.00 is shown in parentheses and is not in the
    // total, so it is not in the carry either.
    expect(carried % 150).toBe(0);
    expect(carried).toBeGreaterThan(0);
  });
});

describe('the Swiss QR-bill', () => {
  const swiss = (items, docExtra = {}) => invoice(items, { qrFormat: 'swiss' }, docExtra);

  test('shares the last page when the closing blocks leave room for it', async () => {
    const items = [longItem(1), longItem(2), longItem(3)];
    const withSlip = await pdfService.renderInvoiceToBuffer(swiss(items));
    const withoutSlip = await pdfService.renderInvoiceToBuffer(invoice(items));

    // The slip costs nothing: the same document without one is just as long.
    expect(await pageCount(withSlip)).toBe(await pageCount(withoutSlip));
    expect(await pageCount(withSlip)).toBe(2);
  });

  test('keeps the footer and the page number clear of its reserved area', async () => {
    const drawn = recordDrawing();
    const buffer = await pdfService.renderInvoiceToBuffer(swiss([longItem(1), longItem(2), longItem(3)]));
    const bandTop = (await PdfLib.load(buffer)).getPage(1).getHeight() - BAND_HEIGHT;

    const footer = find(drawn(), issuer.footerLine);
    const pageLabel = find(drawn(), 'Seite 2');
    expect(footer.y).toBeLessThan(bandTop);
    expect(pageLabel.y).toBeLessThan(bandTop);
    // The footer stays above the number, the order a page without a slip has.
    expect(footer.y).toBeLessThan(pageLabel.y);
  });

  test('takes a page of its own when the content reaches into that area', async () => {
    const drawn = recordDrawing();
    // A single short item still fills the first page past the band: the DIN
    // 5008 header alone reaches the middle of the page.
    const buffer = await pdfService.renderInvoiceToBuffer(swiss([shortItem(1)]));

    expect(await pageCount(buffer)).toBe(2);
    // A page of its own is neither numbered nor counted, as before (#1445).
    expect(find(drawn(), t('de', 'page_of', { current: 1, total: 1 }))).toBeTruthy();
    expect(find(drawn(), 'Seite 2')).toBeUndefined();
  });

  test('leaves the page alone when the bank details give no slip to draw', async () => {
    const drawn = recordDrawing();
    // A QR-IBAN without a QR reference: swissqrbill refuses it, so there is no
    // slip. The page must not be laid out around one — and must not gain the
    // blank page the old code added before finding out.
    const buffer = await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], {
      qrFormat: 'swiss', bank: { ...bank, iban: 'CH44 3199 9123 0008 8901 2' },
    }));
    const height = (await PdfLib.load(buffer)).getPage(0).getHeight();

    expect(await pageCount(buffer)).toBe(1);
    // The footer stayed in the bottom margin, where a page without a slip
    // keeps it, rather than 105 mm up.
    expect(find(drawn(), issuer.footerLine).y).toBeGreaterThan(height - BAND_HEIGHT);
  });

  test('costs only the QR section when it throws while drawing', async () => {
    const { SwissQRBill } = require('swissqrbill/pdf');
    jest.spyOn(SwissQRBill.prototype, 'attachTo').mockImplementation(() => {
      throw new Error('slip render failed');
    });
    // The draw used to sit inside the same try as the construction. It must
    // stay wrapped: the admin gets an invoice without a QR, not no invoice.
    const buffer = await pdfService.renderInvoiceToBuffer(swiss([longItem(1), longItem(2), longItem(3)]));
    expect(await pageCount(buffer)).toBe(2);
  });

  test('is left off a Stornorechnung, which stays a single page', async () => {
    const buffer = await pdfService.renderInvoiceToBuffer(swiss([shortItem(1)], {
      kind: 'storno', invoiceNumber: 'S-2026-0002',
      cancelsInvoice: { number: 'R-2026-0001', issueDate: '2026-09-12' },
    }));
    expect(await pageCount(buffer)).toBe(1);
  });
});

describe('the page number', () => {
  test('names the document on a continuation page, and not on the first', async () => {
    const items = Array.from({ length: 30 }, (_, i) => shortItem(i + 1));
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice(items));

    const first = find(drawn(), t('de', 'page_of', { current: 1, total: 2 }));
    const second = find(drawn(), t('de', 'page_of', { current: 2, total: 2 }));
    expect(first.text).not.toContain('R-2026-0001');
    expect(second.text).toContain('R-2026-0001');
  });
});

describe('references', () => {
  test('a Storno names the invoice it reverses in the meta block, above the title', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], {}, {
      kind: 'storno', invoiceNumber: 'S-2026-0002',
      cancelsInvoice: { number: 'R-2026-0001', issueDate: '2026-09-12' },
    }));
    const calls = drawn();

    const reference = find(calls, t('de', 'reference_cancels'));
    expect(reference.text).toContain('R-2026-0001');
    expect(reference.text).toContain('12.09.2026');
    // Too long for the column beside the address field, so it reads as one
    // full-width row under it, label included.
    expect(reference.text).toContain(t('de', 'reference_label'));
    // Above the title, where the dates are — not under it.
    expect(reference.y).toBeLessThan(findExact(calls, t('de', 'storno_title')).y);
  });

  test('an invoice names the quote it came from', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], {}, { sourceQuoteNumber: 'Q-2026-0044' }));
    const calls = drawn();

    // Either as a row of the grid or, when too long for its value column, as
    // one full-width row under the address field — both carry the label.
    const value = find(calls, 'Q-2026-0044');
    expect(value).toBeTruthy();
    expect(findExact(calls, `${t('de', 'reference_label')}:`) || value.text.includes(t('de', 'reference_label')))
      .toBeTruthy();
    expect(value.y).toBeLessThan(findExact(calls, t('de', 'invoice_title')).y);
  });
});

describe('the service date', () => {
  const sameDay = { servicePeriod: { from: '2026-09-14' } };

  test('says so in words when it only repeats the issue date', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], {}, sameDay));
    const calls = drawn();

    // The row stays — MWSTG Art. 26 and §14(4) Nr. 6 UStG want the time of
    // supply on the document — but it doesn't print the same date twice.
    expect(find(calls, t('de', 'service_date'))).toBeTruthy();
    expect(find(calls, t('de', 'service_date_same_as_issue'))).toBeTruthy();
  });

  test('can be left out entirely', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], { serviceDateMode: 'omit' }, sameDay));
    expect(find(drawn(), t('de', 'service_date'))).toBeUndefined();
  });

  test('can repeat the date, as it did before', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], { serviceDateMode: 'repeat' }, sameDay));
    const calls = drawn();
    expect(find(calls, t('de', 'service_date'))).toBeTruthy();
    expect(find(calls, t('de', 'service_date_same_as_issue'))).toBeUndefined();
  });

  test('is printed as a date when it differs from the issue date', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], {}, {
      servicePeriod: { from: '2026-09-01' },
    }));
    const calls = drawn();
    expect(find(calls, t('de', 'service_date'))).toBeTruthy();
    expect(find(calls, '01.09.2026')).toBeTruthy();
  });
});

