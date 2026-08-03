/**
 * renderProofName — the configurable Beleg proof-attachment filename template.
 * Pure function; no DB. Covers token substitution, the multi-proof index
 * fallback, padding, and filesystem-safe sanitisation.
 */
const { renderProofName } = require('../../src/services/invoice/rebillProofs');

describe('renderProofName', () => {
  const base = { invoiceNumber: 'R-2026-0042', supplierName: 'ACME AG', seq: 1, hasMulti: false, issueDate: '2026-08-03' };

  it('defaults to Beleg-<invoice>.pdf', () => {
    expect(renderProofName('Beleg-{INVOICE}', base)).toBe('Beleg-R-2026-0042.pdf');
    expect(renderProofName('', base)).toBe('Beleg-R-2026-0042.pdf');
    expect(renderProofName(null, base)).toBe('Beleg-R-2026-0042.pdf');
  });

  it('substitutes every token incl. padded SEQ and date parts', () => {
    expect(renderProofName('{SUPPLIER}-{INVOICE}-{YEAR}{MONTH}-{SEQ:03d}', { ...base, seq: 7 }))
      .toBe('ACME-AG-R-2026-0042-202608-007.pdf');
  });

  it('appends an index for multiple proofs only when the template has no {SEQ}', () => {
    // No {SEQ} + multi → auto-suffixed with the index.
    expect(renderProofName('Beleg-{INVOICE}', { ...base, seq: 2, hasMulti: true })).toBe('Beleg-R-2026-0042-2.pdf');
    // Single proof → no suffix.
    expect(renderProofName('Beleg-{INVOICE}', { ...base, seq: 1, hasMulti: false })).toBe('Beleg-R-2026-0042.pdf');
    // Explicit {SEQ} → no double index even when multi.
    expect(renderProofName('Beleg-{INVOICE}-{SEQ}', { ...base, seq: 2, hasMulti: true })).toBe('Beleg-R-2026-0042-2.pdf');
  });

  it('sanitises unsafe characters and slashes, and always ends in a single .pdf', () => {
    expect(renderProofName('Beleg {INVOICE}', { ...base, invoiceNumber: '2026/0042' })).toBe('Beleg-2026-0042.pdf');
    // Author-supplied extension is stripped and re-added (no double .pdf).
    expect(renderProofName('{INVOICE}.pdf', base)).toBe('R-2026-0042.pdf');
    // Falls back to 'Beleg' if the template renders empty after sanitising.
    expect(renderProofName('{SUPPLIER}', { ...base, supplierName: '///' })).toBe('Beleg.pdf');
  });
});
