'use strict';

/**
 * The PDF content checks themselves (#1445 contract attachments); the gate
 * that runs them under a heap limit is utils/pdfValidation.
 *
 * A file is judged by its bytes, never its name or declared type:
 *   - it must start with the `%PDF-` signature and parse with pdf-lib;
 *   - encrypted files are refused (they can't be merged and can't be
 *     checked);
 *   - active or embedded content is refused: JavaScript, launch, import and
 *     form-submit actions, document or page "additional actions", embedded
 *     files, XFA forms and rich media. Plain links (URI / GoTo actions) and
 *     an OpenAction that is only a destination are fine;
 *   - size and page-count caps keep a crafted file from exhausting the
 *     renderer.
 *
 * pdf-lib decompresses object streams on load, so the scan also sees
 * dictionaries that sit inside compressed streams.
 *
 * What is stored is what was checked: the caller writes the bytes pdf-lib
 * wrote back (`normalised`), not the upload. A file can define the same
 * object number twice — pdf-lib keeps the last definition, while a viewer
 * resolves through the xref table, which can point at the first. Storing the
 * re-serialised document drops everything the scan didn't see, so the two
 * can't disagree.
 */

const crypto = require('crypto');
const {
  PDFDocument, PDFDict, PDFName, PDFArray, EncryptedPDFError,
} = require('pdf-lib');
const { AppError } = require('./errors');

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 200;

// Keys whose presence alone means active or embedded content.
const FORBIDDEN_KEYS = new Set([
  '/JS', '/JavaScript', '/AA', '/EmbeddedFiles', '/EmbeddedFile', '/EF', '/XFA', '/RichMedia',
  '/RichMediaContent', '/Launch',
]);
// Values of /S (action type), /Subtype (annotation) or /Type that run code,
// leave the document, send data or carry a file.
const FORBIDDEN_NAMES = new Set([
  '/JavaScript', '/Launch', '/ImportData', '/SubmitForm', '/ResetForm', '/GoToR', '/GoToE',
  '/RichMediaExecute', '/Rendition', '/Sound', '/Movie', '/Hide', '/SetOCGState', '/GoTo3DView',
  '/EmbeddedFile', '/FileAttachment', '/RichMedia', '/Screen', '/3D',
]);
const TYPE_KEYS = new Set(['/S', '/Subtype', '/Type']);
// Nesting deeper than this in one object is itself suspicious.
const MAX_DEPTH = 32;

function refuse(message, code) {
  return new AppError(message, 400, code);
}

function hasPdfSignature(buffer) {
  // The header may follow a few junk bytes; the spec allows it within 1 KB.
  const head = buffer.subarray(0, 1024).toString('latin1');
  return head.includes('%PDF-');
}

/**
 * Walk a value's direct dictionaries and arrays. Actions, name trees and
 * form dictionaries are often nested directly inside another object (an
 * annotation's /A, the catalog's /Names or /AcroForm), so looking at
 * top-level keys alone would miss them. References aren't followed: every
 * indirect object is scanned on its own.
 */
function scanValue(value, depth) {
  if (depth > MAX_DEPTH) return 'nesting';
  if (value instanceof PDFDict) {
    for (const [key, inner] of value.entries()) {
      const name = key.asString();
      if (FORBIDDEN_KEYS.has(name)) return name;
      if (TYPE_KEYS.has(name) && inner instanceof PDFName && FORBIDDEN_NAMES.has(inner.asString())) {
        return inner.asString();
      }
      const hit = scanValue(inner, depth + 1);
      if (hit) return hit;
    }
  } else if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i += 1) {
      const hit = scanValue(value.get(i), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** The first forbidden key or name found anywhere in the document, or null. */
function findActiveContent(pdf) {
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    // A stream's dictionary carries its /Type and /Subtype.
    const hit = scanValue(object && object.dict instanceof PDFDict ? object.dict : object, 0);
    if (hit) return hit;
  }
  return null;
}

/**
 * Parse, scan and re-serialise one PDF. Throws a 400 AppError with a stable
 * code: PDF_TOO_LARGE, PDF_NOT_A_PDF, PDF_ENCRYPTED, PDF_MALFORMED,
 * PDF_ACTIVE_CONTENT, PDF_EMPTY, PDF_TOO_MANY_PAGES.
 *
 * Runs wherever it is called — the caller decides whether that is this
 * process or a worker with a heap limit (see pdfValidation.js).
 *
 * `normalised` is the document pdf-lib re-serialised from what this scan
 * saw, and `bytes` / `sha256` describe those bytes: store them, never the
 * upload.
 *
 * @returns {Promise<{ pages: number, bytes: number, sha256: string, normalised: Buffer }>}
 */
async function inspectPdf(buffer, { maxBytes = DEFAULT_MAX_BYTES, maxPages = DEFAULT_MAX_PAGES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw refuse('The file is empty', 'PDF_NOT_A_PDF');
  if (buffer.length > maxBytes) {
    throw refuse(`The PDF is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`, 'PDF_TOO_LARGE');
  }
  if (!hasPdfSignature(buffer)) throw refuse('The file is not a PDF', 'PDF_NOT_A_PDF');

  let pdf;
  try {
    pdf = await PDFDocument.load(buffer, { updateMetadata: false });
  } catch (err) {
    // pdf-lib's error classes don't set `name`; match the class, or its message.
    if (err instanceof EncryptedPDFError || /encrypted/i.test(String(err && err.message))) {
      throw refuse('Password-protected or encrypted PDFs can\'t be used', 'PDF_ENCRYPTED');
    }
    throw refuse('The PDF could not be read', 'PDF_MALFORMED');
  }

  const active = findActiveContent(pdf);
  if (active) {
    throw refuse('PDFs with scripts, actions, forms or embedded files can\'t be used', 'PDF_ACTIVE_CONTENT');
  }

  const pages = pdf.getPageCount();
  if (pages === 0) throw refuse('The PDF has no pages', 'PDF_EMPTY');
  if (pages > maxPages) throw refuse(`The PDF has more than ${maxPages} pages`, 'PDF_TOO_MANY_PAGES');

  // Only the objects this scan walked reach the stored file. Object streams
  // stay off so a re-read of the stored file scans the same flat objects.
  let normalised;
  try {
    normalised = Buffer.from(await pdf.save({ useObjectStreams: false }));
  } catch (err) {
    throw refuse('The PDF could not be read', 'PDF_MALFORMED');
  }
  if (normalised.length > maxBytes) {
    throw refuse(`The PDF is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`, 'PDF_TOO_LARGE');
  }

  return {
    pages,
    bytes: normalised.length,
    sha256: crypto.createHash('sha256').update(normalised).digest('hex'),
    normalised,
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_PAGES,
  inspectPdf,
  _internal: { hasPdfSignature, findActiveContent },
};
