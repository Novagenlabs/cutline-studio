import puppeteer from 'puppeteer-core';
import { CutlineEngine, DEFAULT_PARAMS } from '../src/pipeline/index';
import type { RasterImage } from '../src/pipeline/types';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DPI = 300, pxPerMm = DPI / 25.4;

function makeImg(w: number, h: number, cover: (x: number, y: number) => number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const SS = 8;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) acc += cover(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      const i = (y * w + x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = Math.round((255 * acc) / (SS * SS));
    }
  return { data, width: w, height: h };
}

async function renderText(text: string, fontPx: number): Promise<RasterImage> {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const d = await page.evaluate(({ text, fontPx }) => {
    const pad = 40;
    const c = document.createElement('canvas');
    const m = c.getContext('2d')!;
    m.font = `bold ${fontPx}px Helvetica, Arial, sans-serif`;
    const w = Math.ceil(m.measureText(text).width) + pad * 2;
    const h = Math.ceil(fontPx * 1.6) + pad * 2;
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    g.font = `bold ${fontPx}px Helvetica, Arial, sans-serif`;
    g.fillStyle = '#000'; g.textBaseline = 'middle';
    g.fillText(text, pad, h / 2);
    return { w, h, data: Array.from(g.getImageData(0, 0, w, h).data) };
  }, { text, fontPx });
  await browser.close();
  return { width: d.w, height: d.h, data: new Uint8ClampedArray(d.data) };
}

const base = { ...DEFAULT_PARAMS, dpi: DPI, minIslandMm2: 0.5, holeMinMm2: 0.5, keepHoles: true };
let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

(async () => {
  console.log('--- FIX 1: letters stay separate ("Hello" = 7 rings: 5 glyphs + 2 counters) ---');
  for (const fontPx of [60, 120, 240]) {
    const img = await renderText('Hello', fontPx);
    const v2 = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 0, engineVersion: 'v2' });
    const v3 = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 0, engineVersion: 'v3' });
    console.log(`  ${fontPx}px: v2=${v2.rings.length} rings  v3=${v3.rings.length} rings`);
    check(v3.rings.length === 7, `${fontPx}px v3 resolves all 7 contours`);
  }

  console.log('\n--- v3 is the default, and v2 is still reachable ---');
  {
    const img = await renderText('Hello', 120);
    const dflt = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 0 }); // no engineVersion
    const v3 = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 0, engineVersion: 'v3' });
    const v2 = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 0, engineVersion: 'v2' });
    check(DEFAULT_PARAMS.engineVersion === 'v3', 'DEFAULT_PARAMS selects v3');
    check(dflt.svgPath === v3.svgPath, 'default params produce v3 output byte-identically');
    // v2 must remain available and behave as it always did, so a job cut on
    // the old engine can still be reproduced exactly.
    check(v2.svgPath !== v3.svgPath, 'v2 is still a distinct engine, not an alias');
    check(v2.rings.length === 2, 'v2 still welds "Hello" at 120px as it always did');
  }

  console.log('\n--- FIX 2: offset accuracy across the old 2mm cutoff ---');
  {
    const W = 260, H = 140, L = 20.37, R = 26.37;
    const img = makeImg(W, H, (x, y) => (x >= L && x <= R && y >= 10 && y <= 50 ? 1 : 0));
    for (const off of [2.0, 2.2, 2.5, 3.0]) {
      const run = (v: 'v2' | 'v3') => {
        const res = new CutlineEngine(img, 1).compute({ ...base, offsetMm: off, minCornerRadiusMm: 0, engineVersion: v });
        let a = Infinity, b = -Infinity;
        for (const r of res.rings) for (const p of r) { a = Math.min(a, p.x); b = Math.max(b, p.x); }
        return { l: a - (L - off * pxPerMm), r: b - (R + off * pxPerMm) };
      };
      const e2 = run('v2'), e3 = run('v3');
      console.log(`  off=${off}mm  v2 L=${e2.l.toFixed(3)} R=${e2.r.toFixed(3)}   v3 L=${e3.l.toFixed(3)} R=${e3.r.toFixed(3)}`);
      check(Math.abs(e3.l) < 0.2 && Math.abs(e3.r) < 0.2, `off=${off}mm v3 within 0.2px on both edges`);
      check(Math.abs(Math.abs(e3.l) - Math.abs(e3.r)) < 0.15, `off=${off}mm v3 symmetric`);
    }
  }

  console.log('\n--- FIX 2: large offsets still merge touching bands (must not regress) ---');
  {
    const W = 400, H = 160;
    const img = makeImg(W, H, (x, y) => (y >= 40 && y <= 120 && ((x >= 40 && x <= 90) || (x >= 130 && x <= 180)) ? 1 : 0));
    // gap 40px ~ 3.4mm; offset 3mm each side => bands overlap => should merge to 1 ring
    const v3 = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 3, minCornerRadiusMm: 0, engineVersion: 'v3' });
    const v2 = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 3, minCornerRadiusMm: 0, engineVersion: 'v2' });
    console.log(`  offset=3mm over a 3.4mm gap: v2=${v2.rings.length} ring(s)  v3=${v3.rings.length} ring(s)`);
    check(v3.rings.length === 1, 'v3 still merges overlapping offset bands into one cut');
  }

  console.log('\n--- FIX 1: concave corner radius guarantee still enforced ---');
  {
    const W = 200, H = 200;
    const img = makeImg(W, H, (x, y) => ((x >= 20 && x <= 160 && y >= 20 && y <= 80) || (x >= 20 && x <= 80 && y >= 20 && y <= 160)) ? 1 : 0);
    const v3 = new CutlineEngine(img, 1).compute({ ...base, offsetMm: 0, minCornerRadiusMm: 1, engineVersion: 'v3' });
    let nearest = Infinity;
    for (const r of v3.rings) for (const p of r) nearest = Math.min(nearest, Math.hypot(p.x - 80, p.y - 80));
    console.log(`  L-shape concave corner (80,80): nearest traced point = ${nearest.toFixed(2)}px`);
    check(nearest > 1.5, 'v3 still rounds the concave corner for blade clearance');
  }

  console.log(fails === 0 ? '\nall v3 checks passed' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
