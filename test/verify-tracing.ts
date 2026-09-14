// The tracing indicator.
//
// Switching a cut style re-traces the whole outline. That work is synchronous
// and can run for over a second, and a blocked main thread paints nothing —
// so the naive version of this feature (set a flag, then compute in the same
// task) shows the flag only AFTER the work it was meant to announce has
// finished. The user reported exactly that: a preset change that looked like
// nothing happened for ~1500ms.
//
// This checks the ordering that fixes it: the class is on the body and the
// browser has had a frame to paint it before compute() runs. It samples from
// inside the page rather than polling from the test, because a poll can miss
// the whole window on a fast machine.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.APP_URL ?? 'http://localhost:3000/';

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
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1500, height: 940 });
  const errs: string[] = [];
  p.on('pageerror', (e: unknown) => { errs.push(e instanceof Error ? e.message : String(e)); });
  await p.goto(URL, { waitUntil: 'networkidle2' });
  await wait(6500);
  await p.evaluate(`document.querySelector('.tour-skip')?.click()`);
  await wait(400);

  await p.click('#btn-sample');
  await wait(4000);

  console.log('--- the indicator exists and is off at rest ---');
  check((await p.evaluate(`document.body.classList.contains('is-tracing')`)) === false,
    'nothing is claimed while idle');
  check((await p.evaluate(`
    !!getComputedStyle(document.getElementById('stage'), '::before').content
  `)) === true, 'the stage carries a progress bar element');

  console.log('\n--- changing a preset marks the app as working ---');
  // Watch the class from inside the page: the window can be short, and a
  // test-side poll would race it.
  const saw = (await p.evaluate(`
    new Promise(resolve => {
      let seen = false;
      const mo = new MutationObserver(() => {
        if (document.body.classList.contains('is-tracing')) seen = true;
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      document.querySelector('.cutstop[data-preset="loose"]').click();
      setTimeout(() => { mo.disconnect(); resolve(seen); }, 2500);
    })
  `)) as boolean;
  check(saw === true, 'is-tracing is applied when a preset is clicked');

  console.log('\n--- and it clears once the trace lands ---');
  await wait(1500);
  check((await p.evaluate(`document.body.classList.contains('is-tracing')`)) === false,
    'the indicator is gone when the work is done');
  check((await p.evaluate(`
    document.getElementById('in-offset').value
  `)) === '6', 'and the preset actually applied (offset 6 mm)');

  console.log('\n--- the class is set before the blocking work, not after ---');
  // The ordering that matters. If compute() ran first, the class would only
  // appear in the same frame the result does — this measures that it lands
  // strictly earlier.
  const order = (await p.evaluate(`
    new Promise(resolve => {
      const marks = {};
      const mo = new MutationObserver(() => {
        if (document.body.classList.contains('is-tracing') && !marks.classAt) {
          marks.classAt = performance.now();
        }
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      const before = performance.now();
      document.querySelector('.cutstop[data-preset="tight"]').click();
      // One frame later, is the class already up?
      requestAnimationFrame(() => {
        marks.frameAt = performance.now();
        marks.upByFirstFrame = document.body.classList.contains('is-tracing');
        setTimeout(() => { mo.disconnect(); resolve(JSON.stringify({ ...marks, before })); }, 2000);
      });
    })
  `)) as string;
  const o = JSON.parse(order);
  check(o.upByFirstFrame === true,
    'the indicator is up within one frame of the click, before compute runs');

  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join('; ') : ''}`);
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
