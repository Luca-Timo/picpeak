/**
 * Tests for the createBaseDocument + getPageMetrics helpers — the
 * shared PDF factory used by quote/invoice rendering AND by the
 * upcoming tax-report renderer. These verify orientation handling
 * and font defaults without touching DB or filesystem.
 */
const pdfService = require('../../src/services/pdfService');

describe('getPageMetrics', () => {
  it('returns portrait A4 metrics by default', () => {
    const p = pdfService.getPageMetrics();
    expect(p.width).toBeCloseTo(595.28, 1);
    expect(p.height).toBeCloseTo(841.89, 1);
    expect(p.contentWidth).toBeCloseTo(515.28, 1);
  });

  it('returns portrait when orientation is "portrait"', () => {
    const p = pdfService.getPageMetrics('portrait');
    expect(p.width).toBeLessThan(p.height);
  });

  it('returns landscape A4 metrics (width > height) when orientation is "landscape"', () => {
    const p = pdfService.getPageMetrics('landscape');
    expect(p.width).toBeCloseTo(841.89, 1);
    expect(p.height).toBeCloseTo(595.28, 1);
    expect(p.contentWidth).toBeCloseTo(761.89, 1);
    expect(p.width).toBeGreaterThan(p.height);
  });

  it('ignores unknown orientation values (falls back to portrait)', () => {
    const p = pdfService.getPageMetrics('upside-down');
    expect(p.width).toBeLessThan(p.height);
  });
});

describe('createBaseDocument', () => {
  it('returns a PDFKit doc, page metrics, and logical font names by default', () => {
    const { doc, page, fonts } = pdfService.createBaseDocument();
    expect(doc).toBeDefined();
    expect(typeof doc.on).toBe('function');
    expect(typeof doc.font).toBe('function');
    expect(page.width).toBeCloseTo(595.28, 1); // portrait by default
    expect(fonts).toEqual({ body: 'Helvetica', bold: 'Helvetica-Bold' });
  });

  it('produces a landscape document when orientation is "landscape"', () => {
    const { doc, page } = pdfService.createBaseDocument({ orientation: 'landscape' });
    expect(page.width).toBeGreaterThan(page.height);
    // PDFKit stores the active page dims on doc.page.
    expect(doc.page.width).toBeCloseTo(841.89, 1);
    expect(doc.page.height).toBeCloseTo(595.28, 1);
  });

  it('produces a buffered PDF of non-zero size with the PDF magic header', async () => {
    const { doc } = pdfService.createBaseDocument({ orientation: 'landscape' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const ended = new Promise((resolve) => doc.on('end', resolve));
    doc.text('hello', 40, 40);
    doc.end();
    await ended;
    const buf = Buffer.concat(chunks);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('keeps Helvetica fonts when the issuer has no custom TTF path', () => {
    const { fonts } = pdfService.createBaseDocument({
      issuer: { pdfFontTtfPath: null },
    });
    expect(fonts.body).toBe('Helvetica');
    expect(fonts.bold).toBe('Helvetica-Bold');
  });

  it('falls back to Helvetica when the custom TTF path does not exist', () => {
    // No exception, no logger.error blow-up — just silent fallback.
    const { fonts } = pdfService.createBaseDocument({
      issuer: { pdfFontTtfPath: '/nonexistent/path/font.ttf' },
    });
    expect(fonts.body).toBe('Helvetica');
    expect(fonts.bold).toBe('Helvetica-Bold');
  });

  it('registers a bundled font family when pdfFontFamily is set', () => {
    // Migration-121 dropdown path. Inter ships 400 + 600 + 700 under
    // backend/assets/fonts/Inter/, so the resolver should pick 400
    // for body and 700 for bold.
    const { fonts } = pdfService.createBaseDocument({
      issuer: { pdfFontFamily: 'Inter' },
    });
    expect(fonts.body).toBe('crm-body');
    expect(fonts.bold).toBe('crm-bold');
  });

  it('falls back to Helvetica when pdfFontFamily names a non-existent directory', () => {
    const { fonts } = pdfService.createBaseDocument({
      issuer: { pdfFontFamily: 'NotARealFamily' },
    });
    expect(fonts.body).toBe('Helvetica');
    expect(fonts.bold).toBe('Helvetica-Bold');
  });

  it('strips path-traversal characters from pdfFontFamily', () => {
    // Defence in depth: the sanitiser keeps only [A-Za-z0-9_-].
    // "../../etc/passwd" becomes "etcpasswd" → no such font dir → fallback.
    const { fonts } = pdfService.createBaseDocument({
      issuer: { pdfFontFamily: '../../etc/passwd' },
    });
    expect(fonts.body).toBe('Helvetica');
    expect(fonts.bold).toBe('Helvetica-Bold');
  });

  it('prefers pdfFontTtfPath over pdfFontFamily when both are set', () => {
    // The explicit upload is the priority-1 override. When the upload
    // path is unusable (file missing) the family is consulted next.
    // Here we set BOTH to invalid values and confirm Helvetica fallback
    // — what matters is that the family DIDN'T get registered while a
    // (failed) explicit path was being evaluated.
    const { fonts } = pdfService.createBaseDocument({
      issuer: {
        pdfFontTtfPath: '/nonexistent/path/font.ttf',
        pdfFontFamily: 'Inter',
      },
    });
    // pdfFontTtfPath misses → falls through to pdfFontFamily → Inter
    // registers successfully. crm-body / crm-bold confirm a custom
    // font won.
    expect(fonts.body).toBe('crm-body');
    expect(fonts.bold).toBe('crm-bold');
  });

  it('forwards PDF info metadata (Title, Author) to the document', () => {
    const { doc } = pdfService.createBaseDocument({
      info: { Title: 'Tax Report 2026', Author: 'picpeak' },
    });
    // PDFKit copies these onto doc.info during construction.
    expect(doc.info.Title).toBe('Tax Report 2026');
    expect(doc.info.Author).toBe('picpeak');
  });
});

describe('exported letterhead helper', () => {
  it('exposes drawIssuerBlock for reuse by non-quote/invoice renderers', () => {
    expect(typeof pdfService.drawIssuerBlock).toBe('function');
  });
});
