import { CutlineEngine, DEFAULT_PARAMS } from '../src/pipeline/index';
import type { RasterImage, Pt, RegionOverride } from '../src/pipeline/types';

const DPI = 300, pxPerMm = DPI / 25.4;

let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

function makeImg(w: number, h: number, cover: (x: number, y: number) => number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const SS = 6;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) acc += cover(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      const i = (y * w + x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = Math.round((255 * acc) / (SS * SS));
    }
  return { data, width: w, height: h };
}

const base = { ...DEFAULT_PARAMS, dpi: DPI, minIslandMm2: 0.2, holeMinMm2: 0.2, minCornerRadiusMm: 0, engineVersion: 'v3' as const };

// Two squares far apart: left gets a big offset, right a small one.
const W = 900, H = 300;
const LEFT = { x0: 60, y0: 100, x1: 160, y1: 200 };
const RIGHT = { x0: 600, y0: 100, x1: 700, y1: 200 };
const img = makeImg(W, H, (x, y) =>
  (x >= LEFT.x0 && x <= LEFT.x1 && y >= LEFT.y0 && y <= LEFT.y1) ||
  (x >= RIGHT.x0 && x <= RIGHT.x1 && y >= RIGHT.y0 && y <= RIGHT.y1) ? 1 : 0);

function extentsOf(rings: Pt[][]) {
  // split rings by which square they surround
  const out: { left?: { x0: number; x1: number }, right?: { x0: number; x1: number } } = {};
  for (const r of rings) {
    let x0 = Infinity, x1 = -Infinity;
    for (const p of r) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); }
    const cx = (x0 + x1) / 2;
    if (cx < W / 2) out.left = { x0, x1 };
    else out.right = { x0, x1 };
  }
  return out;
}

console.log('--- per-element offset: each element grows by its own distance ---');
{
  const regions: RegionOverride[] = [
    { x: 40, y: 80, w: 140, h: 140, offsetMm: 3 },
    { x: 580, y: 80, w: 140, h: 140, offsetMm: 0.5 },
  ];
  const res = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 3, regions });
  const e = extentsOf(res.rings);
  console.log(`  rings=${res.rings.length}`);
  if (e.left && e.right) {
    const leftGrow = LEFT.x0 - e.left.x0;
    const rightGrow = RIGHT.x0 - e.right.x0;
    console.log(`  left grew ${leftGrow.toFixed(1)}px (${(leftGrow/pxPerMm).toFixed(2)}mm, want 3.00)`);
    console.log(`  right grew ${rightGrow.toFixed(1)}px (${(rightGrow/pxPerMm).toFixed(2)}mm, want 0.50)`);
    check(Math.abs(leftGrow / pxPerMm - 3) < 0.25, 'left element offset ~3mm');
    check(Math.abs(rightGrow / pxPerMm - 0.5) < 0.25, 'right element offset ~0.5mm');
    check(leftGrow > rightGrow * 3, 'the two elements really differ');
  } else {
    check(false, 'both elements present');
  }
}

console.log('\n--- contours outside every region keep the global offset ---');
{
  const regions: RegionOverride[] = [{ x: 40, y: 80, w: 140, h: 140, offsetMm: 0.5 }];
  const res = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 3, regions });
  const e = extentsOf(res.rings);
  if (e.left && e.right) {
    const leftGrow = LEFT.x0 - e.left.x0;
    const rightGrow = RIGHT.x0 - e.right.x0;
    console.log(`  left(region 0.5mm)=${(leftGrow/pxPerMm).toFixed(2)}mm  right(global 3mm)=${(rightGrow/pxPerMm).toFixed(2)}mm`);
    check(Math.abs(leftGrow / pxPerMm - 0.5) < 0.25, 'region element uses its own 0.5mm');
    check(Math.abs(rightGrow / pxPerMm - 3) < 0.25, 'unassigned element keeps global 3mm');
  } else check(false, 'both elements present');
}

console.log('\n--- colliding bands union into one path, not overlapping paths ---');
{
  // squares close together, both grown enough to overlap
  const W2 = 400, H2 = 300;
  const A = { x0: 100, y0: 100, x1: 180, y1: 200 };
  const B = { x0: 220, y0: 100, x1: 300, y1: 200 };
  const img2 = makeImg(W2, H2, (x, y) =>
    (x >= A.x0 && x <= A.x1 && y >= A.y0 && y <= A.y1) ||
    (x >= B.x0 && x <= B.x1 && y >= B.y0 && y <= B.y1) ? 1 : 0);
  const regions: RegionOverride[] = [
    { x: 80, y: 80, w: 120, h: 140, offsetMm: 3 },
    { x: 210, y: 80, w: 120, h: 140, offsetMm: 3 },
  ];
  const res = new CutlineEngine(img2, 1).compute({ ...base, offsetMm: 3, regions });
  console.log(`  gap=40px, both grown 3mm (=35px each side): rings=${res.rings.length}`);
  check(res.rings.length === 1, 'overlapping bands merge into a single cut path');
}

console.log('\n--- v2 ignores per-element offsets (regression guard) ---');
{
  const regions: RegionOverride[] = [
    { x: 40, y: 80, w: 140, h: 140, offsetMm: 3 },
    { x: 580, y: 80, w: 140, h: 140, offsetMm: 0.5 },
  ];
  const withR = new CutlineEngine(img, 1).compute({ ...base, engineVersion: 'v2', offsetMm: 3, regions });
  const without = new CutlineEngine(img, 1).compute({ ...base, engineVersion: 'v2', offsetMm: 3, regions: [] });
  check(withR.svgPath === without.svgPath, 'v2 output unchanged by offsetMm regions');
}

console.log('\n--- no offsetMm regions -> identical to plain v3 ---');
{
  const a = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 2, regions: [] });
  const b = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 2, regions: [{ x: 40, y: 80, w: 140, h: 140, denoisePx: 0.4 }] });
  check(a.rings.length === b.rings.length, 'mask-only regions do not trigger the per-element path');
}

console.log(fails === 0 ? '\nall per-element offset checks passed' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
