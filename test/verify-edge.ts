// Edge-accuracy regression: the traced contour must sit ON the artwork edge.
//
// Measured against exact analytic geometry (not a sampled reference), so the
// numbers are true error, not measurement bias.
import { extractMask } from '../src/pipeline/mask';
import { traceField } from '../src/pipeline/trace';
import type { RasterImage, Pt } from '../src/pipeline/types';

let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

function makeImg(w: number, h: number, cov: (x: number, y: number) => number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const SS = 16;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) acc += cov(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
    data[(y * w + x) * 4 + 3] = Math.round((255 * acc) / (SS * SS));
  }
  return { data, width: w, height: h };
}

function rawTrace(img: RasterImage, pad = 6): Pt[][] {
  const m = extractMask(img, { alphaThreshold: 128, bgTolerance: 32, pad, denoiseSigma: 0, bodyMode: false });
  const f = m.field;
  for (let i = 0; i < f.length; i++) f[i] -= 128;
  const tr = traceField(f, m.w, m.h, 0, 'gte', { keepHoles: true, minHoleAreaPx2: 1 });
  return tr.map((t) => t.points.map((p) => ({ x: p.x - pad, y: p.y - pad })));
}

console.log('--- straight edges land on the exact edge (no half-pixel bias) ---');
{
  // Square with edges at deliberately non-integer positions.
  const L = 20.37, R = 61.63, T = 15.24, B = 55.76;
  const img = makeImg(90, 80, (x, y) => (x >= L && x <= R && y >= T && y <= B ? 1 : 0));
  const rings = rawTrace(img);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const e = [x0 - L, x1 - R, y0 - T, y1 - B];
  console.log(`  left ${e[0].toFixed(3)}  right ${e[1].toFixed(3)}  top ${e[2].toFixed(3)}  bottom ${e[3].toFixed(3)} px`);
  // 0.09px is the theoretical floor for reconstructing an edge from box-filter
  // coverage sampled at pixel centres (see test/dilation.ts) — the information
  // is not in the pixels. For scale: a cutting plotter's own mechanical
  // tolerance is ~0.1mm, which is 1.2px at 300dpi.
  for (const v of e) check(Math.abs(v) < 0.09, `edge within the 0.09px sampling floor (${v.toFixed(3)})`);
  // Bias would shift all four the SAME way; a symmetric shape hides it in the
  // width, so check the centre too.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  check(Math.abs(cx - (L + R) / 2) < 0.05, `centre x unbiased (${(cx - (L + R) / 2).toFixed(3)}px)`);
  check(Math.abs(cy - (T + B) / 2) < 0.05, `centre y unbiased (${(cy - (T + B) / 2).toFixed(3)}px)`);
}

console.log('\n--- a circle is traced to its true radius everywhere ---');
{
  const C = { x: 100.3, y: 99.7 }, R = 60;
  const img = makeImg(200, 200, (x, y) => (Math.hypot(x - C.x, y - C.y) <= R ? 1 : 0));
  const rings = rawTrace(img);
  const errs: number[] = [];
  for (const r of rings) for (const p of r) errs.push(Math.hypot(p.x - C.x, p.y - C.y) - R);
  errs.sort((a, b) => a - b);
  const med = errs[errs.length >> 1];
  const maxAbs = Math.max(Math.abs(errs[0]), Math.abs(errs[errs.length - 1]));
  console.log(`  radial error: median ${med.toFixed(3)}px, max |err| ${maxAbs.toFixed(3)}px`);
  check(Math.abs(med) < 0.05, 'median radial error under 0.05px');
  check(maxAbs < 0.35, 'worst radial error under 0.35px');
}

console.log('\n--- centre of mass is not displaced (the half-pixel bug) ---');
{
  // An L-shape: asymmetric, so a uniform shift moves its centroid.
  const img = makeImg(160, 160, (x, y) =>
    ((x >= 20 && x <= 120 && y >= 20 && y <= 60) || (x >= 20 && x <= 60 && y >= 20 && y <= 140)) ? 1 : 0);
  const rings = rawTrace(img);
  // polygon centroid of the traced ring
  let cx = 0, cy = 0, a2 = 0;
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    const cr = p.x * q.y - q.x * p.y;
    a2 += cr; cx += (p.x + q.x) * cr; cy += (p.y + q.y) * cr;
  }
  cx /= 3 * a2; cy /= 3 * a2;
  // exact centroid of the L
  const A1 = 100 * 40, A2 = 40 * 120;
  const ov = 40 * 40;
  const ex = (A1 * 70 + A2 * 40 - ov * 40) / (A1 + A2 - ov);
  const ey = (A1 * 40 + A2 * 80 - ov * 40) / (A1 + A2 - ov);
  console.log(`  centroid traced (${cx.toFixed(2)}, ${cy.toFixed(2)})  exact (${ex.toFixed(2)}, ${ey.toFixed(2)})`);
  check(Math.abs(cx - ex) < 0.1 && Math.abs(cy - ey) < 0.1, 'centroid within 0.1px of exact');
}

console.log(fails === 0 ? '\nall edge-accuracy checks passed' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
