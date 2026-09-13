// The cut-style slider's knob must sit on its track and on its ticks.
//
// The previous version of this file measured the <input type=range> box and
// reported 0.00px while the knob was visibly high — because a native range
// input's thumb is a vendor pseudo-element with no box you can query, so the
// test was measuring the container and calling it the handle. That is the
// whole reason this control is now Base UI: the thumb is a real DOM node, so
// these assertions measure the thing the user actually sees.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.APP_URL ?? 'http://localhost:3000/';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`);
  if (!ok) fails++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Centre of an element, or null when it is not on the page. */
const BOX = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}`;

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
  await p.evaluate(`window.__box = ${BOX}`);

  console.log('--- the slider renders as real elements ---');
  const parts = await p.evaluate(`(() => ({
    control: !!document.querySelector('.bui-slider-control'),
    track: !!document.querySelector('.bui-slider-track'),
    thumb: !!document.querySelector('.bui-slider-thumb'),
    ticks: document.querySelectorAll('.bui-slider-tick').length,
  }))()`) as Record<string, boolean | number>;

  check(parts.control === true && parts.track === true, 'control and track are present');
  // A real node, not a ::-webkit-slider-thumb — this is what makes the rest
  // of this file able to assert anything at all.
  check(parts.thumb === true, 'the thumb is a real element that can be measured');
  check(parts.ticks === 4, `four ticks, one per stop (got ${parts.ticks})`);

  console.log('\n--- the knob is centred on the track at every stop ---');
  const stops = ['tight', 'close', 'sticker', 'loose'];
  for (const name of stops) {
    await p.evaluate(`document.querySelector('.cutstop[data-preset="${name}"]').click()`);
    await wait(300);
    const m = await p.evaluate(`(() => {
      const t = window.__box('.bui-slider-track');
      const th = window.__box('.bui-slider-thumb');
      return { dy: Math.abs(t.cy - th.cy), thumbCx: th.cx, thumbW: th.w };
    })()`) as { dy: number; thumbCx: number; thumbW: number };
    check(m.dy <= 0.75, `${name}: knob centred on the track (off by ${m.dy.toFixed(2)}px vertically)`);
  }

  console.log('\n--- the knob lands on its tick ---');
  for (let i = 0; i < stops.length; i++) {
    await p.evaluate(`document.querySelector('.cutstop[data-preset="${stops[i]}"]').click()`);
    await wait(300);
    const m = await p.evaluate(`(() => {
      const th = window.__box('.bui-slider-thumb');
      const tick = document.querySelectorAll('.bui-slider-tick')[${i}].getBoundingClientRect();
      return { dx: Math.abs((tick.x + tick.width / 2) - th.cx) };
    })()`) as { dx: number };
    check(m.dx <= 0.75, `${stops[i]}: knob sits on its tick (off by ${m.dx.toFixed(2)}px)`);
  }

  console.log('\n--- the end stops stay inside the panel ---');
  const ends = await p.evaluate(`(async () => {
    const rail = document.querySelector('.rail').getBoundingClientRect();
    const read = async (name) => {
      document.querySelector('.cutstop[data-preset="' + name + '"]').click();
      await new Promise((r) => setTimeout(r, 250));
      const th = window.__box('.bui-slider-thumb');
      return { left: th.x - rail.x, right: rail.right - (th.x + th.w) };
    };
    const tight = await read('tight');
    const loose = await read('loose');
    return { tight, loose };
  })()`) as { tight: { left: number }; loose: { right: number } };

  check(ends.tight.left >= 10, `Tight clears the left gutter (${ends.tight.left.toFixed(1)}px)`);
  check(ends.loose.right >= 10, `Loose clears the right gutter (${ends.loose.right.toFixed(1)}px)`);

  console.log('\n--- the stops still drive the pipeline ---');
  const offsets: string[] = [];
  for (const [name, mm] of [['tight', '0.00'], ['close', '1.00'], ['sticker', '3.00'], ['loose', '6.00']] as const) {
    await p.evaluate(`document.querySelector('.cutstop[data-preset="${name}"]').click()`);
    await wait(300);
    const v = String(await p.evaluate(`document.getElementById('out-cut-offset').textContent`));
    offsets.push(`${name}=${v}`);
    check(v.startsWith(mm), `${name} sets ${mm} mm`);
  }
  console.log(`  ${offsets.join('  ')}`);

  console.log(errs.length ? '\nPAGE ERRORS: ' + errs.join(' | ') : '\nno page errors');
  console.log(fails === 0 ? 'all slider geometry checks passed' : `${fails} CHECK(S) FAILED`);
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})();
