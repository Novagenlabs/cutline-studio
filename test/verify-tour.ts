// The first-run tour.
//
// Two things make this worth a test rather than a look. It must appear
// exactly once on its own — a tour that returns on every visit is worse than
// no tour — and it must adapt to what is on screen: the Elements panel does
// not exist until artwork is open, and a step pointing at a missing element
// would ring nothing and describe a control the user cannot see.
//
// The ? button is the escape hatch from "seen once, gone forever", so it is
// checked too.
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

  // A fresh context each time so localStorage genuinely starts empty; this is
  // about the first visit, and a reused profile has already had one.
  const fresh = async () => {
    const ctx = await b.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 1500, height: 940 });
    await p.goto(URL, { waitUntil: 'networkidle2' });
    await wait(6500); // splash (4s cap) + balance
    return { ctx, p };
  };

  console.log('--- it runs itself on a first visit ---');
  const { ctx, p } = await fresh();
  check((await p.evaluate(`!!document.querySelector('.tour')`)) === true,
    'the tour starts without being asked');
  check((await p.evaluate(`
    document.querySelector('.tour-ring')?.getBoundingClientRect().width > 0
  `)) === true, 'and rings something real');

  const first = String(await p.evaluate(`document.querySelector('.tour-count').textContent`));
  check(/^1 of \d+$/.test(first), `it starts at step one (got "${first}")`);

  console.log('\n--- the app stays live behind it ---');
  // A tour that traps you is a tax on everyone who already knows the product.
  check((await p.evaluate(`
    getComputedStyle(document.querySelector('.tour')).pointerEvents
  `)) === 'none', 'the tour layer does not swallow clicks by default');

  console.log('\n--- every step points at something on screen ---');
  let steps = 0;
  const missed: string[] = [];
  while (await p.evaluate(`!!document.querySelector('.tour')`)) {
    const ok = (await p.evaluate(`
      (() => {
        const r = document.querySelector('.tour-ring')?.getBoundingClientRect();
        const t = document.querySelector('.tour-title')?.textContent ?? '?';
        return JSON.stringify({ ok: !!r && r.width > 4 && r.height > 4, t });
      })()
    `)) as string;
    const { ok: ringed, t } = JSON.parse(ok);
    if (!ringed) missed.push(t);
    steps++;
    if (steps > 10) break;
    await p.click('.tour-next');
    await wait(700);
  }
  check(steps >= 4, `it walked a real sequence (${steps} steps)`);
  check(missed.length === 0, `every step ringed its target${missed.length ? ': ' + missed.join(', ') : ''}`);

  console.log('\n--- and it does not come back ---');
  await p.goto(URL, { waitUntil: 'networkidle2' });
  await wait(6000);
  check((await p.evaluate(`!!document.querySelector('.tour')`)) === false,
    'a second visit is not interrupted');

  console.log('\n--- the ? button replays it ---');
  check((await p.evaluate(`!!document.getElementById('btn-help')`)) === true,
    'the help button is in the top bar');
  await p.click('#btn-help');
  await wait(900);
  check((await p.evaluate(`!!document.querySelector('.tour')`)) === true,
    'clicking it starts the tour again');
  check((await p.evaluate(`
    document.getElementById('tab-simple').classList.contains('active')
  `)) === true, 'and switches to Simple, where every step lives');

  console.log('\n--- Escape gets out ---');
  await p.keyboard.press('Escape');
  await wait(500);
  check((await p.evaluate(`!!document.querySelector('.tour')`)) === false,
    'Escape ends it');
  await ctx.close();

  console.log('\n--- with artwork open, the Elements step appears ---');
  {
    const { ctx: c2, p: p2 } = await fresh();
    // Dismiss the first-run tour, open artwork, then replay: the step set is
    // computed per run, so this is the case where it should be longer.
    await p2.evaluate(`document.querySelector('.tour-skip')?.click()`);
    await wait(400);
    await p2.click('#btn-sample');
    await wait(4000);
    await p2.click('#btn-help');
    await wait(900);

    // Not "the tour got longer": opening artwork hides the dropzone as well
    // as revealing Elements, so the count stays the same and the SET changes.
    // Asserting a bigger number tested the wrong thing and failed while the
    // filter was working exactly as intended.
    const total = String(await p2.evaluate(`document.querySelector('.tour-count').textContent`));
    check((await p2.evaluate(`
      document.querySelector('.drop-row').getBoundingClientRect().width === 0
    `)) === true, 'the dropzone is gone once artwork is open');

    // Walk to the Elements step and confirm it is genuinely in the sequence.
    const titles: string[] = [];
    for (let i = 0; i < 10; i++) {
      if (!(await p2.evaluate(`!!document.querySelector('.tour')`))) break;
      titles.push(String(await p2.evaluate(`document.querySelector('.tour-title').textContent`)));
      await p2.click('.tour-next');
      await wait(600);
    }
    check(titles.some((t) => /parts separately/i.test(t)),
      `the Elements step is included (${total}, ${titles.length} seen)`);
    check(!titles.some((t) => /Start with your artwork/i.test(t)),
      'and the "open artwork" step is dropped, because there already is some');
    await c2.close();
  }

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
