/**
 * The budget on what pdf-lib decodes, metered where it grows
 * (utils/pdfDecodeBudget).
 *
 * The raw-bytes pass in pdfInspect has to recognise a stream the way pdf-lib
 * frames it — the keyword's trailing whitespace, the zlib method nibble, a
 * `/Filter` chain — and every round of that is one parser differential behind.
 * This meters the decoders themselves, so the cap holds whatever framing the
 * file uses.
 */

const zlib = require('zlib');
const FlateStream = require('pdf-lib/cjs/core/streams/FlateStream').default;
const AsciiHexStream = require('pdf-lib/cjs/core/streams/AsciiHexStream').default;
const Stream = require('pdf-lib/cjs/core/streams/Stream').default;
const budget = require('../../src/utils/pdfDecodeBudget');

const MB = 1024 * 1024;
const deflated = (bytes) => zlib.deflateSync(Buffer.alloc(bytes, 0x20), { level: 9 });
const streamOf = (buffer) => new Stream(new Uint8Array(buffer));

function decodeWith(stream, cap) {
  const meter = budget.patch(cap);
  try {
    stream.decode();
    return { spent: meter.spent(), error: null };
  } catch (err) {
    return { spent: meter.spent(), error: err };
  } finally {
    meter.restore();
  }
}

test('a flate stream past the budget stops at it', () => {
  const compressed = deflated(8 * MB);
  expect(compressed.length).toBeLessThan(64 * 1024);

  const { error, spent } = decodeWith(new FlateStream(streamOf(compressed)), MB);
  expect(error).toBeInstanceOf(budget.DecodeBudgetExceeded);
  expect(error.code).toBe('PDF_DECODE_BUDGET');
  // Stopped at the budget rather than after the stream's own expansion.
  expect(spent).toBeLessThan(4 * MB);
});

test('a filter chain is metered too — the encoding it arrives in makes no difference', () => {
  // /ASCIIHexDecode then /FlateDecode: the bytes the raw scan sees are hex
  // text, which can only shrink, and the expansion happens one filter later.
  const hex = Buffer.from(`${deflated(8 * MB).toString('hex')}>`, 'latin1');
  const outer = new AsciiHexStream(streamOf(hex), hex.length);
  const { error } = decodeWith(new FlateStream(outer), MB);
  expect(error).toBeInstanceOf(budget.DecodeBudgetExceeded);
});

test('an ordinary stream decodes, and the meter comes off again', () => {
  const small = deflated(64 * 1024);
  const { error, spent } = decodeWith(new FlateStream(streamOf(small)), MB);
  expect(error).toBeNull();
  expect(spent).toBeGreaterThan(0);

  // Restored: the next decode outside a patch is unmetered.
  const plain = new FlateStream(streamOf(small));
  expect(plain.decode().length).toBe(64 * 1024);
});
