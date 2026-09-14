// The first frame of a cold load.
//
// The splash is built in JS and cannot be appended until the bundle has
// downloaded, parsed and run. On a new browser that gap is long enough to see
// the studio — rail, canvas, top bar — flash past before the brand animation
// covers it, which is exactly backwards.
//
// A static cover in index.html holds the screen through that gap. Testing it
// means looking at the DOM *before* the bundle runs, so this throttles the
// network hard and screenshots the first paint rather than waiting for load.
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

  console.log('--- a cold load is covered from the first paint ---');
  {
    // A fresh context so sessionStorage is genuinely empty — this only
    // applies to someone arriving for the first time.
    const ctx = await b.createBrowserContext();
    const p = await ctx.newPage();
    const cdp = await p.createCDPSession();
    // Slow enough that the gap between first paint and the bundle running is
    // wide open. Without the cover this is where the studio shows through.
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 300,
      downloadThroughput: (200 * 1024) / 8,
      uploadThroughput: (200 * 1024) / 8,
    });

    // Sampled from inside the page as the HTML parses, not after an event:
    // app.js is a module, so it is deferred and runs BEFORE DOMContentLoaded.
    // Anything checked after that event is checked too late to see the frame
    // this is about — the first attempt at this test "failed" for exactly
    // that reason while the cover was working perfectly.
    await p.evaluateOnNewDocument(`
      window.__bootSamples = [];
      const sample = () => {
        window.__bootSamples.push({
          t: performance.now(),
          booting: document.documentElement.classList.contains('is-booting'),
          railVisible: !!document.querySelector('.rail'),
        });
        if (window.__bootSamples.length < 400) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    `);

    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    const samples = (await p.evaluate(`JSON.stringify(window.__bootSamples ?? [])`)) as string;
    const frames: { t: number; booting: boolean; railVisible: boolean }[] = JSON.parse(samples);

    check(frames.length > 0, `frames were sampled during boot (${frames.length})`);
    check(frames[0]?.booting === true, 'the very first painted frame is covered');

    // The bug, stated precisely: a frame where the studio markup exists and
    // nothing is covering it. That is the flash the user saw.
    const exposed = frames.filter((f) => f.railVisible && !f.booting);
    const firstUncovered = frames.findIndex((f) => !f.booting);
    check(
      exposed.length === 0 || firstUncovered === -1,
      exposed.length === 0
        ? 'no frame shows the studio uncovered'
        : `${exposed.length} frame(s) showed the studio uncovered`
    );

    check((await p.evaluate(`
      (() => {
        const cs = getComputedStyle(document.documentElement, '::before');
        return cs.position === 'fixed' || !document.documentElement.classList.contains('is-booting');
      })()
    `)) === true, 'the cover is a fixed full-screen layer while it lasts');

    await ctx.close();
  }

  console.log('\n--- it clears once the app is running ---');
  {
    const ctx = await b.createBrowserContext();
    const p = await ctx.newPage();
    await p.goto(URL, { waitUntil: 'networkidle2' });
    await wait(6000); // splash is capped at 4s

    check((await p.evaluate(
      `document.documentElement.classList.contains('is-booting')`
    )) === false, 'the cover is gone once the splash has taken over');
    check((await p.evaluate(
      `!!document.querySelector('.rail') && document.querySelector('.rail').offsetHeight > 0`
    )) === true, 'and the studio is usable');
    await ctx.close();
  }

  console.log('\n--- a repeat visit is not covered at all ---');
  {
    const ctx = await b.createBrowserContext();
    const p = await ctx.newPage();
    await p.goto(URL, { waitUntil: 'networkidle2' });
    await wait(5500);
    // Second navigation in the same context: splashSeen() is now true, so the
    // animation is skipped — and a cover with no splash behind it would be a
    // black flash for no reason.
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    check((await p.evaluate(
      `document.documentElement.classList.contains('is-booting')`
    )) === false, 'no cover when the splash has already been seen this session');
    await ctx.close();
  }

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
