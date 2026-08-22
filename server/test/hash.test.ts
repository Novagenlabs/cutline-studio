/**
 * The request-binding hash is pure, so it can be verified without a database.
 * It is what stops a token issued for one export being spent on another.
 */
import { describe, it, expect } from 'vitest';
import { hashExportRequest } from '../src/lib/credits';

describe('hashExportRequest', () => {
  it('is stable across key order', () => {
    expect(hashExportRequest({ a: 1, b: 2 })).toBe(hashExportRequest({ b: 2, a: 1 }));
  });
  it('is stable across nesting order', () => {
    expect(hashExportRequest({ x: { p: 1, q: 2 }, y: [1, 2] }))
      .toBe(hashExportRequest({ y: [1, 2], x: { q: 2, p: 1 } }));
  });
  it('changes when any value changes', () => {
    const base = { format: 'SVG', widthMm: 10 };
    expect(hashExportRequest(base)).not.toBe(hashExportRequest({ ...base, widthMm: 10.001 }));
    expect(hashExportRequest(base)).not.toBe(hashExportRequest({ ...base, format: 'PDF' }));
  });
  it('distinguishes array order (geometry is ordered)', () => {
    expect(hashExportRequest([1, 2])).not.toBe(hashExportRequest([2, 1]));
  });
  it('does not confuse a number with its string form', () => {
    expect(hashExportRequest({ n: 1 })).not.toBe(hashExportRequest({ n: '1' }));
  });
});
