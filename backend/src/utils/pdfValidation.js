'use strict';

/**
 * The gate in front of the PDF content checks (#1445 contract attachments):
 * it runs utils/pdfInspect in a worker thread with a heap limit.
 *
 * pdf-lib inflates every object stream when it loads a document, and the
 * upload cap is on the compressed bytes, so a small crafted file can expand
 * into gigabytes. In the server process that takes the whole install down
 * (and the same file is parsed again on every send and preview). In a worker
 * with `resourceLimits` it only ends that thread, and the upload is refused
 * with PDF_TOO_COMPLEX.
 *
 * What the checks themselves are, and why the caller must store
 * `normalised` rather than the upload, is documented in pdfInspect.js.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { AppError } = require('./errors');
const {
  DEFAULT_MAX_BYTES, DEFAULT_MAX_PAGES, DEFAULT_MAX_INFLATE_BYTES, inspectPdf, _internal,
} = require('./pdfInspect');

// Enough for a legitimate 20 MB document (pdf-lib holds the parsed objects
// and the re-serialised copy), far below what a decompression bomb wants.
const WORKER_HEAP_MB = 512;
// A legitimate 200-page file parses in well under a second; a file that
// spends longer than this is not one we want to keep working on.
const WORKER_TIMEOUT_MS = 30000;
// Last line of defence, and the only one that doesn't depend on reading the
// file the way pdf-lib does: while a check runs, the process must not grow
// past this much above where it started. Typed arrays live outside the heap
// `resourceLimits` caps, so this is what catches anything the inflate budget
// and the decode meter didn't see. Generous enough that a legitimate 20 MB
// document never reaches it.
const RSS_CEILING_BYTES = 1024 * 1024 * 1024;
const RSS_SAMPLE_MS = 100;
const WORKER_FILE = path.join(__dirname, 'pdfInspectWorker.js');
// Each check may hold its inflate budget in memory, so they queue rather than
// run together: two admins uploading at once must not multiply the ceiling.
const MAX_CONCURRENT = 2;
let running = 0;
const waiting = [];

function acquire() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

const tooComplex = () => new AppError(
  'This PDF is too complex to check. Please save it again from your PDF program (print to PDF) and upload that file.',
  400, 'PDF_TOO_COMPLEX',
);

function rethrow(error) {
  const err = new AppError(error.message, error.statusCode || 400, error.code || 'PDF_MALFORMED');
  throw err;
}

/**
 * Check a PDF and describe it: `{ pages, bytes, sha256, normalised }`.
 * Throws a 400 AppError with a stable code (see pdfInspect, plus
 * PDF_TOO_COMPLEX when a file expands past the inflate budget, or the parse
 * outgrows the worker's heap or its time).
 *
 * `isolate: false` runs the checks in this process — for callers that
 * already hold bytes this gate accepted.
 */
async function validatePdf(buffer, options = {}) {
  // `heapMb` exists so a test can pin what happens when the parse outgrows
  // the limit; callers use the default.
  const { isolate = true, heapMb = WORKER_HEAP_MB, ...limits } = options;
  if (!isolate) return inspectPdf(buffer, limits);
  // Cheap refusals first, so an obviously wrong file costs no thread.
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError('The file is empty', 400, 'PDF_NOT_A_PDF');
  }
  const maxBytes = limits.maxBytes == null ? DEFAULT_MAX_BYTES : limits.maxBytes;
  if (buffer.length > maxBytes) {
    throw new AppError(`The PDF is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`, 400, 'PDF_TOO_LARGE');
  }

  await acquire();
  try {
    return await runInWorker(buffer, limits, heapMb);
  } finally {
    release();
  }
}

function runInWorker(buffer, limits, heapMb) {
  const bytes = new Uint8Array(buffer);
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_FILE, {
        workerData: { buffer: bytes, options: limits },
        transferList: [bytes.buffer],
        resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.min(64, heapMb) },
      });
    } catch (err) {
      // No worker available (an unusual runtime): fall back to this process
      // rather than refusing every upload.
      inspectPdf(buffer, limits).then(resolve, reject);
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, tooComplex()), WORKER_TIMEOUT_MS);
    // The worker shares this process's memory, so growth is measurable from
    // here — and terminating the thread frees it.
    const startedAt = process.memoryUsage().rss;
    const watchdog = setInterval(() => {
      if (process.memoryUsage().rss - startedAt > RSS_CEILING_BYTES) finish(reject, tooComplex());
    }, RSS_SAMPLE_MS);
    worker.on('message', (msg) => {
      if (msg && msg.ok) {
        finish(resolve, { ...msg.info, normalised: Buffer.from(msg.info.normalised) });
        return;
      }
      try {
        rethrow((msg && msg.error) || {});
      } catch (err) {
        finish(reject, err);
      }
    });
    worker.on('error', (err) => {
      // ERR_WORKER_OUT_OF_MEMORY, or the thread died parsing.
      finish(reject, err && err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? tooComplex()
        : new AppError('The PDF could not be read', 400, 'PDF_MALFORMED'));
    });
    worker.on('exit', () => finish(reject, tooComplex()));
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_INFLATE_BYTES,
  validatePdf,
  _internal,
};
