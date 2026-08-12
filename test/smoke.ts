/**
 * Headless pipeline smoke test (no DOM): synthetic RGBA image -> engine ->
 * geometry assertions -> PDF/DXF export checks.
 * Run with: npm run smoke
 */
import { CutlineEngine, DEFAULT_PARAMS } from '../src/pipeline';
import type { CutlineParams, RasterImage } from '../src/pipeline';
import { buildPdf } from '../src/export/pdf';
import { buildDxf } from '../src/export/dxf';
import { buildSvg } from '../src/export/svg';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

// --- synthetic artwork: 400x300, alpha-transparent background ---
// circle r=60 @ (120,150); separate 60px square @ (280..340, 60..120);
// donut ring outer r=45 inner r=20 @ (300,220)
const W = 400;
const H = 300;
const data = new Uint8ClampedArray(W * H * 4);
function setPx(x: number, y: number) {
  const i = (y * W + x) * 4;
  data[i] = 200;
  data[i + 1] = 60;
  data[i + 2] = 90;
  data[i + 3] = 255;
}
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dCirc = Math.hypot(x - 120, y - 150);
    if (dCirc <= 60) setPx(x, y);
    if (x >= 280 && x <= 340 && y >= 60 && y <= 120) setPx(x, y);
    const dDonut = Math.hypot(x - 300, y - 220);
    if (dDonut <= 45 && dDonut >= 20) setPx(x, y);
  }
}
const img: RasterImage = { data, width: W, height: H };

const params: CutlineParams = {
  ...DEFAULT_PARAMS,
  dpi: 100, // ~3.9 px per mm -> 3mm offset ≈ 11.8 px
  offsetMm: 3,
};

console.log('— contour mode, holes dropped —');
const engine = new CutlineEngine(img, 1);
const r1 = engine.compute(params);
console.log('   timings:', JSON.stringify(r1.timings, (_k, v) => (typeof v === 'number' ? Math.round(v) : v)));
check('produces rings', r1.rings.length >= 2, `got ${r1.rings.length}`);
check('produces beziers + path', r1.beziers.length === r1.rings.length && r1.svgPath.includes('C'));
check(
  'offset expands bounds beyond artwork',
  r1.bbox.x < 60 - 5 && r1.bbox.y < 90 - 5 && r1.bbox.x + r1.bbox.w > 340 + 5,
  JSON.stringify(r1.bbox)
);
check('donut hole dropped by default', !ringNear(r1, 300, 220, 20), 'found inner ring near donut hole');
check('node count sane', r1.nodeCount > 8 && r1.nodeCount < 2000, `got ${r1.nodeCount}`);
check('used alpha channel', r1.usedAlpha);

console.log('— holes kept —');
const r2 = engine.compute({ ...params, keepHoles: true, minCornerRadiusMm: 0 });
check('donut hole survives when keepHoles', ringNear(r2, 300, 220, 20), `rings ${r2.rings.length}`);

console.log('— larger offset merges islands —');
const r3 = engine.compute({ ...params, offsetMm: 12 });
check('merge reduces ring count', r3.rings.length < r1.rings.length, `${r1.rings.length} -> ${r3.rings.length}`);

console.log('— bridge merges without inflating border —');
// At 3mm offset the three shapes stay separate; bridging 30mm merges them
// into one ring while the border stays ~3mm (bbox must NOT grow like r3's).
const rb = engine.compute({ ...params, bridgeMm: 30 });
check('bridge yields a single ring', rb.rings.length === 1, `got ${rb.rings.length}`);
check(
  'bridge keeps border tight',
  Math.abs(rb.bbox.x - r1.bbox.x) < 4 && rb.bbox.x > r3.bbox.x + 4,
  `x: r1=${r1.bbox.x.toFixed(1)} rb=${rb.bbox.x.toFixed(1)} r3=${r3.bbox.x.toFixed(1)}`
);

console.log('— hole min-size control —');
// keepHoles + huge fill threshold: the donut hole (r=20px ≈ 1250px² ≈ 81mm²
// at 100dpi) gets filled when the threshold is above its area.
const rh = engine.compute({ ...params, keepHoles: true, minCornerRadiusMm: 0, holeMinMm2: 100 });
check('large fill threshold fills the donut hole', !ringNear(rh, 300, 220, 20), `rings ${rh.rings.length}`);

console.log('— offset slider reuses cached EDT —');
const t0 = performance.now();
engine.compute({ ...params, offsetMm: 5 });
const dt = performance.now() - t0;
check('cached recompute < 150ms', dt < 150, `${dt.toFixed(0)}ms`);

console.log('— opaque image: flood-fill background removal —');
const data2 = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < data2.length; i += 4) {
  data2[i] = 240;
  data2[i + 1] = 240;
  data2[i + 2] = 238;
  data2[i + 3] = 255;
}
for (let y = 100; y < 200; y++) {
  for (let x = 150; x < 250; x++) {
    const i = (y * W + x) * 4;
    data2[i] = 30;
    data2[i + 1] = 30;
    data2[i + 2] = 200;
  }
}
const engine2 = new CutlineEngine({ data: data2, width: W, height: H }, 1);
const r4 = engine2.compute(params);
check('opaque image traced via flood fill', r4.rings.length === 1 && !r4.usedAlpha, `rings ${r4.rings.length}`);

console.log('— opaque JPEG-like gradient background —');
// vertical gradient spanning ~60 RGB units (wider than the 32 global
// tolerance) — needs the local-continuity rule to fill completely
const data3 = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  const t = y / H;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    data3[i] = Math.round(235 - 55 * t);
    data3[i + 1] = Math.round(233 - 48 * t);
    data3[i + 2] = Math.round(230 - 35 * t);
    data3[i + 3] = 255;
  }
}
for (let y = 120; y < 260; y++) {
  for (let x = 140; x < 300; x++) {
    const i = (y * W + x) * 4;
    data3[i] = 40;
    data3[i + 1] = 90;
    data3[i + 2] = 60;
  }
}
const engine3 = new CutlineEngine({ data: data3, width: W, height: H }, 1);
const r5 = engine3.compute(params);
const gradBboxOk =
  r5.rings.length === 1 &&
  r5.bbox.x > 100 && r5.bbox.x < 140 &&
  r5.bbox.y > 80 && r5.bbox.y < 120;
check('gradient background removed, subject traced', gradBboxOk, `rings ${r5.rings.length} bbox ${JSON.stringify(r5.bbox)}`);

console.log('— shapes —');
const rRect = engine.compute({ ...params, shape: 'rounded' });
check('rounded rect is one ring', rRect.rings.length === 1 && rRect.beziers[0].length === 8);
const rCirc = engine.compute({ ...params, shape: 'circle' });
check('circle is one 4-seg ring', rCirc.rings.length === 1 && rCirc.beziers[0].length === 4);

console.log('— exports —');
const pdfBytes = await buildPdf({
  srcW: W,
  srcH: H,
  dpi: params.dpi,
  beziers: r1.beziers,
  cutBbox: r1.bbox,
  spotName: 'CutContour',
});
const pdfText = new TextDecoder('latin1').decode(pdfBytes);
check('pdf has Separation colorspace', pdfText.includes('/Separation'));
check('pdf names the spot CutContour', pdfText.includes('/CutContour'));
check('pdf has overprint gstate', pdfText.includes('/OP true'));
check('pdf is a pdf', pdfText.startsWith('%PDF'));

const dxf = buildDxf({ rings: r1.rings, srcH: H, dpi: params.dpi, layerName: 'CutContour' });
check('dxf has layer + polyline', dxf.includes('CutContour') && dxf.includes('POLYLINE'));

const svg = buildSvg({
  srcW: W,
  srcH: H,
  dpi: params.dpi,
  svgPath: r1.svgPath,
  cutBbox: r1.bbox,
  halo: true,
  spotName: 'CutContour',
});
check('svg has cutline group + mm size', svg.includes('id="CutContour"') && svg.includes('mm"'));

function ringNear(result: { rings: { x: number; y: number }[][] }, cx: number, cy: number, maxR: number): boolean {
  // a ring whose every point is within maxR+offset of (cx,cy) => interior hole ring
  return result.rings.some((ring) => ring.every((p) => Math.hypot(p.x - cx, p.y - cy) < maxR + 6));
}

if (failures) {
  throw new Error(`${failures} smoke failure(s)`);
}
console.log('\nall smoke checks passed');
