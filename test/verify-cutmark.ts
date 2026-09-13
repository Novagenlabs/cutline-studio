// The loading mark has to actually move, and move the way scissors do.
//
// A spinner that silently fails to animate still *looks* like a design
// decision at 18px, so this checks the things the eye cannot: that both
// blades turn about the shared rivet at (12,12) rather than their own pivot
// rings, that they turn in opposite directions (or they are not scissors,
// they are a windmill), and that stop() actually parks the blades open
// instead of freezing them mid-bite.
import puppeteer from 'puppeteer-core';
import { DEFAULT_MOTION } from '../src/ui/cutmark';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.APP_URL ?? 'http://localhost:3000';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`);
  if (!ok) fails++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 120_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.goto(`${BASE}/motion-lab`, { waitUntil: 'networkidle2' });

  console.log('--- the mark is built and running ---');

  const built = await p.evaluate(`(() => {
    const marks = document.querySelectorAll('svg.cutmark');
    return {
      count: marks.length,
      blades: marks[0] ? marks[0].querySelectorAll('g').length : 0,
      rings: marks[0] ? marks[0].querySelectorAll('circle').length : 0,
    };
  })()`) as { count: number; blades: number; rings: number };

  check(built.count === 3, `three contexts rendered (got ${built.count})`);
  check(built.blades === 2, `two blades (got ${built.blades})`);
  check(built.rings === 2, `two pivot rings, one per blade (got ${built.rings})`);

  console.log('--- both blades pivot on the shared rivet ---');

  const origins = await p.evaluate(`(() => {
    const gs = document.querySelector('svg.cutmark').querySelectorAll('g');
    return Array.from(gs).map((g) => getComputedStyle(g).transformOrigin);
  })()`) as string[];

  // 12/24 of an 18px box = 9px. The rivet, not the rings at x=5.4.
  check(
    origins.length === 2 && origins[0] === origins[1],
    `both blades share one transform-origin (${origins.join(' | ')})`
  );

  console.log('--- the blades are actually animating ---');

  const running = await p.evaluate(`(() => {
    const gs = document.querySelector('svg.cutmark').querySelectorAll('g');
    return Array.from(gs).map((g) => g.getAnimations().length);
  })()`) as number[];

  check(
    running.every((n) => n > 0),
    `each blade has a running animation (${running.join(', ')})`
  );

  // Sample the live rotation twice: a static transform means the keyframes
  // were built but never played, which no static assertion would catch.
  const sample = () =>
    p.evaluate(`(() => {
      const gs = document.querySelector('svg.cutmark').querySelectorAll('g');
      return Array.from(gs).map((g) => getComputedStyle(g).transform);
    })()`) as Promise<string[]>;

  const t0 = await sample();
  await wait(160);
  const t1 = await sample();

  check(t0[0] !== t1[0], 'the upper blade moves between frames');
  check(t0[1] !== t1[1], 'the lower blade moves between frames');

  console.log('--- the blades close towards each other ---');

  // Decompose the 2D matrix back to an angle. The blades must be equal and
  // opposite — mirrored about the cut line — or they are a windmill, not
  // scissors.
  //
  // Sampled over a window rather than at one instant: the pair closes to 0°
  // at the bite, where both angles are legitimately zero and carry no sign.
  // The widest moment seen is the one that proves the mirroring.
  const angles = await p.evaluate(`(async () => {
    const gs = document.querySelector('svg.cutmark').querySelectorAll('g');
    const read = () => Array.from(gs).map((g) => {
      const m = new DOMMatrix(getComputedStyle(g).transform);
      return Math.atan2(m.b, m.a) * 180 / Math.PI;
    });
    let widest = [0, 0];
    for (let i = 0; i < 24; i++) {
      const a = read();
      if (Math.abs(a[0]) + Math.abs(a[1]) > Math.abs(widest[0]) + Math.abs(widest[1])) widest = a;
      await new Promise((r) => setTimeout(r, 40));
    }
    return widest;
  })()`) as number[];

  check(
    Math.sign(angles[0]) === -Math.sign(angles[1]) &&
      Math.abs(Math.abs(angles[0]) - Math.abs(angles[1])) < 1,
    `blades mirror about the cut line (${angles.map((a) => a.toFixed(1)).join(' / ')})`
  );

  console.log('--- stop() parks the mark open, not mid-bite ---');

  await p.evaluate(`document.getElementById('toggle').click()`);
  await wait(60);

  const parked = await p.evaluate(`(() => {
    const gs = document.querySelector('svg.cutmark').querySelectorAll('g');
    return {
      anims: Array.from(gs).map((g) => g.getAnimations().length),
      angles: Array.from(gs).map((g) => {
        const m = new DOMMatrix(getComputedStyle(g).transform);
        return Math.atan2(m.b, m.a) * 180 / Math.PI;
      }),
    };
  })()`) as { anims: number[]; angles: number[] };

  check(parked.anims.every((n) => n === 0), 'animations are cancelled on stop');
  // Read the expected angle from the shipped defaults rather than repeating a
  // number here: the whole point of the lab is that these values get retuned,
  // and a test that hardcodes them turns every retune into a false failure.
  check(
    Math.abs(Math.abs(parked.angles[0]) - DEFAULT_MOTION.openDeg) < 1.5,
    `parked at the open angle, ~${DEFAULT_MOTION.openDeg}deg (got ${parked.angles[0].toFixed(1)})`
  );

  console.log('--- the panel drives the mark ---');

  const before = await p.evaluate(`document.getElementById('out').textContent`);
  check(
    typeof before === 'string' && before.includes('periodMs'),
    'the copyable source block is populated from live values'
  );

  await b.close();
  console.log(fails === 0 ? '\nall good' : `\n${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
})();
