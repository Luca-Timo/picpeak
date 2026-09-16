/**
 * PDF content checks (#1445 attachments): a file is judged by its bytes.
 */

const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const { validatePdf } = require('../../src/utils/pdfValidation');

async function makePdf({ pages = 1, mutate } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200, 200]);
  if (mutate) await mutate(doc);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function codeOf(promise) {
  try { await promise; return null; } catch (err) { return err.code; }
}

const addAnnotation = (doc, action) => {
  const page = doc.getPage(0);
  const annot = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], A: action,
  }));
  page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
};

const crypto = require('crypto');

test('a plain PDF passes and is described', async () => {
  const buffer = await makePdf({ pages: 3 });
  const info = await validatePdf(buffer);
  expect(info.pages).toBe(3);
  // bytes and sha256 describe the bytes the caller is meant to store: what
  // was checked, not the upload.
  expect(info.bytes).toBe(info.normalised.length);
  expect(info.sha256).toBe(crypto.createHash('sha256').update(info.normalised).digest('hex'));
});

test('an object defined twice cannot smuggle an action past the scan', async () => {
  // pdf-lib keeps the LAST definition of an object number; a viewer resolves
  // through the xref table, which can point at the first. So the scan sees
  // the harmless /GoTo while the file on disk would have offered the viewer
  // /JavaScript. What is stored is what was checked, so the JavaScript
  // object is not in it.
  const body = [
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R/OpenAction 5 0 R>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>> endobj',
    '5 0 obj <</S/JavaScript/JS(app.alert\\(1\\))>> endobj',
    '5 0 obj <</S/GoTo/D[3 0 R /Fit]>> endobj',
    'trailer <</Size 6/Root 1 0 R>>',
    '%%EOF',
  ].join('\n');
  const info = await validatePdf(Buffer.from(body, 'latin1'));
  const stored = info.normalised.toString('latin1');
  expect(stored).not.toContain('/JavaScript');
  expect(stored).not.toContain('app.alert');
  // And the stored file passes the scan on its own terms.
  await expect(validatePdf(info.normalised)).resolves.toEqual(expect.objectContaining({ pages: 1 }));
});

test('a web link is not active content', async () => {
  const buffer = await makePdf({
    mutate: (doc) => addAnnotation(doc, { S: 'URI', URI: PDFString.of('https://example.com') }),
  });
  await expect(validatePdf(buffer)).resolves.toEqual(expect.objectContaining({ pages: 1 }));
});

test('an OpenAction that is only a destination is fine', async () => {
  const buffer = await makePdf({
    mutate: (doc) => doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj([doc.getPage(0).ref, PDFName.of('Fit')])),
  });
  await expect(validatePdf(buffer)).resolves.toEqual(expect.objectContaining({ pages: 1 }));
});

test('a file that is not a PDF is refused, whatever its name', async () => {
  expect(await codeOf(validatePdf(Buffer.from('hello, I am a text file')))).toBe('PDF_NOT_A_PDF');
  expect(await codeOf(validatePdf(Buffer.alloc(0)))).toBe('PDF_NOT_A_PDF');
});

test('a truncated PDF is refused', async () => {
  const buffer = (await makePdf()).subarray(0, 60);
  expect(['PDF_MALFORMED', 'PDF_EMPTY']).toContain(await codeOf(validatePdf(buffer)));
});

test('an encrypted PDF is refused', async () => {
  const plain = (await makePdf()).toString('latin1');
  const encrypted = Buffer.from(plain.replace('/Root', '/Encrypt 1 0 R\n/Root'), 'latin1');
  expect(await codeOf(validatePdf(encrypted))).toBe('PDF_ENCRYPTED');
});

test.each([
  ['JavaScript on open', (doc) => doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({
    Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert(1)'),
  }))],
  ['a page action', (doc) => doc.getPage(0).node.set(PDFName.of('AA'), doc.context.obj({
    O: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') },
  }))],
  ['a launch action', (doc) => addAnnotation(doc, { S: 'Launch', F: PDFString.of('calc.exe') })],
  ['a form submission', (doc) => addAnnotation(doc, { S: 'SubmitForm', F: PDFString.of('https://example.com') })],
  ['an embedded file', (doc) => doc.attach(Buffer.from('payload'), 'payload.txt', { mimeType: 'text/plain' })],
  ['an XFA form', (doc) => doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({
    Fields: [], XFA: PDFString.of('<xdp:xdp/>'),
  }))],
])('refuses %s', async (_label, mutate) => {
  const buffer = await makePdf({ mutate });
  expect(await codeOf(validatePdf(buffer))).toBe('PDF_ACTIVE_CONTENT');
});

test('the size and page caps apply', async () => {
  const buffer = await makePdf({ pages: 3 });
  expect(await codeOf(validatePdf(buffer, { maxPages: 2 }))).toBe('PDF_TOO_MANY_PAGES');
  expect(await codeOf(validatePdf(buffer, { maxBytes: 100 }))).toBe('PDF_TOO_LARGE');
});
