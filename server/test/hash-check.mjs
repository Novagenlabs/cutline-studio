// Standalone check of the canonical-hash logic (no Prisma import needed).
import { createHash } from 'node:crypto';

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
const h = (x) => createHash('sha256').update(stableStringify(x)).digest('hex');

let fail = 0;
const ck = (ok, m) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${m}`); if (!ok) fail++; };

ck(h({ a: 1, b: 2 }) === h({ b: 2, a: 1 }), 'stable across key order');
ck(h({ x: { p: 1, q: 2 }, y: [1, 2] }) === h({ y: [1, 2], x: { q: 2, p: 1 } }), 'stable across nesting order');
ck(h({ format: 'SVG', widthMm: 10 }) !== h({ format: 'SVG', widthMm: 10.001 }), 'detects a changed number');
ck(h({ format: 'SVG' }) !== h({ format: 'PDF' }), 'detects a changed format');
ck(h([1, 2]) !== h([2, 1]), 'array order is significant (geometry is ordered)');
ck(h({ n: 1 }) !== h({ n: '1' }), 'number is not confused with its string form');
ck(h({ a: undefined }) === h({ a: undefined }), 'undefined is handled without throwing');
ck(h(null) === h(null), 'null is handled');

// The property that matters: a request the user could tamper with must not
// collide with the one that was authorised.
const authorised = { format: 'SVG', beziers: [[[0, 0]]], widthMm: 100, heightMm: 50, dpi: 300 };
const tampered = { ...authorised, widthMm: 5000 };
ck(h(authorised) !== h(tampered), 'an enlarged job does not match its authorisation');

console.log(fail === 0 ? '\nall hash checks passed' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
