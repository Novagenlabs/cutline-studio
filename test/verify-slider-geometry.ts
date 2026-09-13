// The cut-style slider's knob must land on its ticks.
//
// A range input centres its thumb at (thumbW / 2) from each end, so the thumb
// travels over an area inset by half a thumb on both sides — not the full
// track. Ticks laid out across the whole width therefore drift away from the
// stops they mark, worst at the two ends: this was 7px out at Tight and
// Loose, which reads as a knob that never quite sits on anything.
//
// Nothing about that is visible in a screenshot diff at a glance, and the
// numbers only disagree once you compute where the browser actually puts the
// thumb — so it is pinned here.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.APP_URL ?? 'http://localhost:3000/';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`);
  if (!ok) fails++;
};

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1600, height: 1000 });
  const errs: string[] = [];
  p.on('pageerror', (e: unknown) => { errs.push(e instanceof Error ? e.message : String(e)); });
  await p.goto(URL, { waitUntil: 'networkidle2' });

  console.log('--- the knob is sized for the track it sits on ---');
  const size = await p.evaluate(`(() => {
    const wrap = document.querySelector('.cutslider');
    const knob = parseFloat(getComputedStyle(wrap).getPropertyValue('--knob'));
    const track = document.querySelector('.cutslider-track').getBoundingClientRect();
    const tick = document.querySelector('.cutslider-tick').getBoundingClientRect();
    return { knob, trackH: track.height, tickW: tick.width };
  })()`) as { knob: number; trackH: number; tickW: number };
  console.log(`  knob ${size.knob}px, track ${size.trackH}px, tick ${size.tickW}px`);

  // 22px on a 4px track was wider than the gap between stops, so the handle
  // covered the ticks it was meant to point at.
  check(size.knob <= 18, `the knob is not oversized (${size.knob}px)`);
  check(size.knob >= 12, `but stays big enough to grab (${size.knob}px)`);
  check(size.tickW < size.knob, 'the tick reads as a marker, not a second handle');

  console.log('\n--- every stop lines up with its tick ---');
  const geom = await p.evaluate(`(() => {
    const input = document.getElementById('in-cutstyle');
    const r = input.getBoundingClientRect();
    const knob = parseFloat(getComputedStyle(document.querySelector('.cutslider')).getPropertyValue('--knob'));
    const ticks = [...document.querySelectorAll('.cutslider-tick')]
      .map((t) => { const b = t.getBoundingClientRect(); return b.x + b.width / 2; });
    // Where the browser actually centres the thumb for each value.
    const thumbs = [0, 1, 2, 3].map((i) => r.x + knob / 2 + (i / 3) * (r.width - knob));
    return { ticks, thumbs };
  })()`) as { ticks: number[]; thumbs: number[] };

  const names = ['Tight', 'Close', 'Sticker', 'Loose'];
  geom.ticks.forEach((tick, i) => {
    const delta = Math.abs(tick - geom.thumbs[i]);
    check(delta <= 0.75, `${names[i]}: knob sits on its tick (off by ${delta.toFixed(2)}px)`);
  });

  console.log('\n--- the track begins and ends at the outer stops ---');
  // Run full-width, the grey bar carries on past the knob at either end and
  // the handle reads as pushed off the end of its own rail. It should stop
  // exactly where the travel does.
  const ends = await p.evaluate(`(() => {
    const track = document.querySelector('.cutslider-track').getBoundingClientRect();
    const input = document.getElementById('in-cutstyle').getBoundingClientRect();
    const knob = parseFloat(getComputedStyle(document.querySelector('.cutslider')).getPropertyValue('--knob'));
    return {
      trackStart: track.x,
      trackEnd: track.right,
      firstStop: input.x + knob / 2,
      lastStop: input.x + knob / 2 + (input.width - knob),
    };
  })()`) as Record<string, number>;

  check(Math.abs(ends.trackStart - ends.firstStop) <= 0.75,
    `the track starts at the first stop (off by ${Math.abs(ends.trackStart - ends.firstStop).toFixed(2)}px)`);
  check(Math.abs(ends.trackEnd - ends.lastStop) <= 0.75,
    `and ends at the last one (off by ${Math.abs(ends.trackEnd - ends.lastStop).toFixed(2)}px)`);

  console.log('\n--- the end stops are not jammed against the panel ---');
  // The knob's outer half overhangs the last stop; without an inset it sits
  // flush to the rail gutter and reads as falling off the edge.
  const gutter = await p.evaluate(`(() => {
    const rail = document.querySelector('.rail').getBoundingClientRect();
    const input = document.getElementById('in-cutstyle').getBoundingClientRect();
    const knob = parseFloat(getComputedStyle(document.querySelector('.cutslider')).getPropertyValue('--knob'));
    const lastKnobEdge = input.x + knob / 2 + (input.width - knob) + knob / 2;
    const firstKnobEdge = input.x;
    return { right: rail.right - lastKnobEdge, left: firstKnobEdge - rail.x };
  })()`) as { right: number; left: number };

  check(gutter.right >= 20, `the knob clears the right gutter (${gutter.right.toFixed(1)}px)`);
  check(Math.abs(gutter.left - gutter.right) <= 1.5,
    `and both ends are inset equally (${gutter.left.toFixed(1)}px / ${gutter.right.toFixed(1)}px)`);

  console.log('\n--- the thumb is centred on the track ---');
  const vert = await p.evaluate(`(() => {
    const input = document.getElementById('in-cutstyle').getBoundingClientRect();
    const track = document.querySelector('.cutslider-track').getBoundingClientRect();
    return { inputMid: input.y + input.height / 2, trackMid: track.y + track.height / 2 };
  })()`) as { inputMid: number; trackMid: number };
  const vDelta = Math.abs(vert.inputMid - vert.trackMid);
  check(vDelta <= 0.75, `vertically centred (off by ${vDelta.toFixed(2)}px)`);

  console.log(errs.length ? '\nPAGE ERRORS: ' + errs.join(' | ') : '\nno page errors');
  console.log(fails === 0 ? 'all slider geometry checks passed' : `${fails} CHECK(S) FAILED`);
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})();
