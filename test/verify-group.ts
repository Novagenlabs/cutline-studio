import puppeteer from 'puppeteer-core';
import { extractMask } from '../src/pipeline/mask';
import { traceField } from '../src/pipeline/trace';
import { groupRings, suggestGapPx } from '../src/pipeline/group';
import type { RasterImage } from '../src/pipeline/types';
import type { TracedRing } from '../src/pipeline/trace';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DPI = 300, pxPerMm = DPI / 25.4;

let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

async function loadFixtures(names: string[]): Promise<Record<string, RasterImage>> {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2' });
  const out: Record<string, RasterImage> = {};
  for (const n of names) {
    const d = (await page.evaluate(`(async () => {
      const r = await fetch('/test/fixtures/${n}.png');
      const bmp = await createImageBitmap(await r.blob());
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const im = g.getImageData(0, 0, c.width, c.height);
      return { w: c.width, h: c.height, data: Array.from(im.data) };
    })()`)) as { w: number; h: number; data: number[] };
    out[n] = { width: d.w, height: d.h, data: new Uint8ClampedArray(d.data) };
  }
  await browser.close();
  return out;
}

function trace(img: RasterImage): TracedRing[] {
  const m = extractMask(img, { alphaThreshold: 128, bgTolerance: 32, pad: 8, denoiseSigma: 0.4, bodyMode: false });
  const f = m.field;
  for (let i = 0; i < f.length; i++) f[i] -= 128;
  return traceField(f, m.w, m.h, 0, 'gte', { keepHoles: true, minHoleAreaPx2: 4 });
}

(async () => {
  const imgs = await loadFixtures(['feelathome', 'hello-large']);

  console.log('--- multi-element logo separates into its three elements ---');
  {
    const rings = trace(imgs['feelathome']);
    const gap = suggestGapPx(rings);
    const groups = groupRings(rings, gap);
    console.log(`  ${groups.length} groups at gap=${gap.toFixed(0)}px`);
    groups.forEach((g, i) =>
      console.log(`   [${i}] ${g.members.length} rings  ${(g.bbox.w / pxPerMm).toFixed(0)}x${(g.bbox.h / pxPerMm).toFixed(0)}mm  stroke=${(g.strokeWidth / pxPerMm).toFixed(2)}mm`)
    );
    check(groups.length === 3, 'icon + display text + strapline = 3 groups');
    if (groups.length === 3) {
      check(groups[0].strokeWidth > groups[1].strokeWidth, 'icon is the heaviest element');
      check(groups[1].strokeWidth > groups[2].strokeWidth, 'display text is heavier than the strapline');
      check(groups[2].bbox.y > groups[1].bbox.y, 'strapline sits below the display text');
      // every traced ring lands in exactly one group
      const seen = new Set<number>();
      let dupes = 0;
      for (const g of groups) for (const m of g.members) { if (seen.has(m)) dupes++; seen.add(m); }
      check(dupes === 0, 'no ring belongs to two groups');
      check(seen.size === rings.length, `every ring assigned (${seen.size}/${rings.length})`);
    }
  }

  console.log('\n--- a single word stays one group ---');
  {
    const rings = trace(imgs['hello-large']);
    const groups = groupRings(rings, suggestGapPx(rings));
    console.log(`  ${groups.length} group(s)`);
    check(groups.length === 1, '"Hello" is one element, not five letters');
    check(groups[0].members.length === rings.length, 'all 7 contours (5 glyphs + 2 counters) in it');
  }

  console.log('\n--- grouping is stable across gap settings ---');
  {
    const rings = trace(imgs['feelathome']);
    const auto = suggestGapPx(rings);
    const counts = [0.7, 1, 1.3].map((m) => groupRings(rings, auto * m).length);
    console.log(`  gap x0.7/x1.0/x1.3 -> ${counts.join('/')} groups`);
    check(counts.every((c) => c === 3), 'stays at 3 groups across a +/-30% gap change');
  }

  console.log('\n--- degenerate inputs ---');
  {
    check(groupRings([], 10).length === 0, 'no rings -> no groups');
    const holeOnly: TracedRing[] = [{ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], isHole: true }];
    check(groupRings(holeOnly, 10).length === 0, 'holes with no exterior -> no groups');
  }

  console.log(fails === 0 ? '\nall grouping checks passed' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
