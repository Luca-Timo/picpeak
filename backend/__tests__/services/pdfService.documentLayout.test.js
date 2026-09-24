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

/** Every string the render drew, with the position it was drawn at. */
function recordDrawing() {
  const spy = jest.spyOn(PDFDocument.prototype, 'text');
  return () => spy.mock.calls.map(([text, x, y]) => ({
    text: String(text),
    y: typeof y === 'number' ? y : null,
  }));
}

const find = (calls, needle) => calls.find((c) => c.text.includes(needle));
/** For a word that is also part of a label — "Rechnung" inside "Rechnungsnummer". */
const findExact = (calls, text) => calls.find((c) => c.text === text);
const pageCount = async (buffer) => (await PdfLib.load(buffer)).getPageCount();

const netLabel = t('de', 'totals_net');
const skontoLabel = t('de', 'skonto_amount_label');

describe('the totals', () => {
  test('follow the line items instead of the page bottom', async () => {
    const drawn = recordDrawing();
    const buffer = await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)]));

    // The old layout put them at a fixed offset from the bottom edge, around
    // y=570 on A4 whatever the table did. One short item leaves them far above
    // that, right under the table.
    expect(find(drawn(), netLabel).y).toBeLessThan(500);
    expect(await pageCount(buffer)).toBe(1);
  });

  test('sit lower when the items reach further down, rather than at a fixed anchor', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)]));
    const short = find(drawn(), netLabel).y;

    jest.restoreAllMocks();
    const drawnLong = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([longItem(1), longItem(2)]));

    expect(find(drawnLong(), netLabel).y).toBeGreaterThan(short);
  });

  test('start at the top of a new page when the table leaves no room for them', async () => {
    const drawn = recordDrawing();
    const buffer = await pdfService.renderInvoiceToBuffer(invoice([longItem(1), longItem(2), longItem(3)]));

    expect(await pageCount(buffer)).toBe(2);
    // Near the top margin of the second page, not pinned above its footer —
    // where they used to land, under an empty half-page.
    expect(find(drawn(), netLabel).y).toBeLessThan(150);
  });

  test('stay with the last row when the table itself runs onto a second page', async () => {
    const items = Array.from({ length: 30 }, (_, i) => shortItem(i + 1));
    const drawn = recordDrawing();
    const buffer = await pdfService.renderInvoiceToBuffer(invoice(items));
    const calls = drawn();

    expect(await pageCount(buffer)).toBe(2);
    expect(find(calls, netLabel).y - find(calls, 'Position 30').y).toBeLessThan(60);
  });

  test('never overlap a two-line footer', async () => {
    const items = Array.from({ length: 30 }, (_, i) => shortItem(i + 1));
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice(items, { qrFormat: 'swiss' }));

    const lastClosingLine = find(drawn(), skontoLabel);
    const footer = find(drawn(), issuer.footerLine);
    expect(lastClosingLine.y).toBeLessThan(footer.y);
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

    expect(findExact(calls, `${t('de', 'reference_label')}:`)).toBeTruthy();
    const value = find(calls, 'Q-2026-0044');
    expect(value.y).toBeLessThan(findExact(calls, t('de', 'invoice_title')).y);
  });
});

describe('the service date', () => {
  test('is left out when it only repeats the issue date', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], {}, {
      servicePeriod: { from: '2026-09-14' },
    }));
    expect(find(drawn(), t('de', 'service_date'))).toBeUndefined();
  });

  test('is printed when it differs from the issue date', async () => {
    const drawn = recordDrawing();
    await pdfService.renderInvoiceToBuffer(invoice([shortItem(1)], {}, {
      servicePeriod: { from: '2026-09-01' },
    }));
    expect(find(drawn(), t('de', 'service_date'))).toBeTruthy();
  });
});
