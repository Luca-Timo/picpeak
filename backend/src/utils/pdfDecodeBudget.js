'use strict';

/**
 * A budget on what pdf-lib actually decodes, measured where it grows.
 *
 * Every pdf-lib decoder — FlateStream, LZWStream, Ascii85Stream,
 * AsciiHexStream, RunLengthStream — extends `DecodeStream`, and all of its
 * output growth goes through `DecodeStream.prototype.ensureBuffer`. Metering
 * there counts exactly what the parser inflates, whatever framing the file
 * uses: `/Filter` chains, a zlib header the raw scan doesn't recognise,
 * `stream` followed by a space, an `/Length` pointing somewhere else.
 *
 * The raw-bytes pass in pdfInspect stays in front of it as a cheap first
 * refusal — it costs nothing on a legitimate file and stops the common bomb
 * before the parser is entered at all — but this is the guard that does not
 * depend on reading the container the same way pdf-lib does.
 *
 * `patch()` returns a `restore()`; the metering is global to the process
 * while it is in place, which is why the checks run one at a time (see
 * pdfValidation).
 */

const DecodeStream = require('pdf-lib/cjs/core/streams/DecodeStream').default;

class DecodeBudgetExceeded extends Error {
  constructor(budget) {
    super(`pdf decoding exceeded the ${budget} byte budget`);
    this.name = 'DecodeBudgetExceeded';
    this.code = 'PDF_DECODE_BUDGET';
  }
}

/**
 * Meter `DecodeStream` growth against `budget` bytes in total.
 * @returns {{ restore: () => void, spent: () => number }}
 */
function patch(budget) {
  const original = DecodeStream.prototype.ensureBuffer;
  let spent = 0;
  DecodeStream.prototype.ensureBuffer = function meteredEnsureBuffer(requested) {
    const before = this.buffer.byteLength;
    // Refuse the request that would cross the budget before it allocates,
    // then charge what was actually allocated: ensureBuffer grows by
    // doubling, so the realised growth is bigger than the request and
    // charging the request alone under-counts by most of the buffer.
    if (requested > before && spent + (requested - before) > budget) {
      throw new DecodeBudgetExceeded(budget);
    }
    const buffer = original.call(this, requested);
    spent += Math.max(0, buffer.byteLength - before);
    if (spent > budget) throw new DecodeBudgetExceeded(budget);
    return buffer;
  };
  return {
    restore: () => { DecodeStream.prototype.ensureBuffer = original; },
    spent: () => spent,
  };
}

module.exports = { patch, DecodeBudgetExceeded };
