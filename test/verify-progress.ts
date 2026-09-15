// The caption during a first background removal.
//
// The model is tens of megabytes and downloads on first use. The worker
// already measured that download — a real percentage from Content-Length
// against bytes read — and the main thread dropped every message into
// console.info. So the overlay sat on a motionless "Removing the background"
// for the whole fetch, which on a slow connection is indistinguishable from
// a hang. Reported as: the user does not know it is downloading.
//
// progress.test.ts covers the message translation. This checks the part that
// only exists in the browser: that the overlay is actually on screen, that
// its caption changes as progress arrives, and that what lands there is the
// download figure rather than the backend name.
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
  // The worker's raw messages, which reach the page as console.info. They are
  // the ground truth for whether a download actually happened: elapsed time is
  // not, because against a local server the whole fetch finishes in seconds.
  const rawWorker: string[] = [];
  p.on('console', (m) => {
    const t = m.text();
    if (t.includes('[matte]')) rawWorker.push(t);
  });
  // The model is a normal HTTP GET, so Chrome caches it and a second run
  // never downloads. That made this check toothless: with the caption update
  // commented out it still reported all-passed, because "no download ran"
  // excused the silence. Disabling the cache forces a real download every
  // run, which is the state the user is actually in on first use.
  await p.setCacheEnabled(false);
  await p.setViewport({ width: 1500, height: 940 });
  await p.goto(URL, { waitUntil: 'networkidle2' });
  await wait(6500);
  await p.evaluate(`document.querySelector('.tour-skip')?.click()`);
  await wait(400);

  // What the overlay is showing: whether it is up, and its caption.
  const overlay = async () =>
    (await p.evaluate(`(() => {
      const el = document.querySelector('.loading');
      const t = document.querySelector('.loading-text');
      return {
        on: !!el && el.classList.contains('is-on'),
        text: t ? t.textContent.trim() : null,
      };
    })()`)) as { on: boolean; text: string | null };

  console.log('--- the overlay exists and can be captioned ---');
  // Drive the real showLoading/loadingText pair through the module the app
  // itself uses, so this tests the shipped wiring rather than a copy of it.
  const wired = await p.evaluate(`(async () => {
    const m = await import('/cutline/loading.js').catch(() => null);
    return !!(m && m.showLoading && m.loadingText && m.humaneProgress);
  })()`);

  if (wired !== true) {
    // The bundle is not split per-module, so reach the behaviour through the
    // app instead: run a real removal and watch the caption while it works.
    console.log('  (module not separately importable — driving the real app)');
  }

  // A photograph-like image with no flat background forces the neural path,
  // which is the one that downloads the model.
  const noisy = await p.evaluate(`(() => {
    const c = document.createElement('canvas');
    c.width = 900; c.height = 700;
    const x = c.getContext('2d');
    const im = x.createImageData(c.width, c.height);
    for (let i = 0; i < im.data.length; i += 4) {
      im.data[i] = 40 + Math.random() * 170;
      im.data[i + 1] = 60 + Math.random() * 150;
      im.data[i + 2] = 80 + Math.random() * 140;
      im.data[i + 3] = 255;
    }
    x.putImageData(im, 0, 0);
    return c.toDataURL('image/png');
  })()`);

  // Feed it in the way a file drop would.
  await p.evaluate(`(async (url) => {
    const res = await fetch(url);
    const blob = await res.blob();
    const file = new File([blob], 'noise.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })(${JSON.stringify(noisy)})`);
  await wait(5000);

  // Watch the caption for the whole removal, sampling fast enough to catch
  // the download messages as they go past.
  const seen: string[] = [];
  await p.evaluate(`window.__caps = new Set();
    window.__capTimer = setInterval(() => {
      const t = document.querySelector('.loading-text');
      const el = document.querySelector('.loading');
      if (t && el && el.classList.contains('is-on')) window.__caps.add(t.textContent.trim());
    }, 60);`);

  // The cache is off, so this download is real every time.
  await p.evaluate(`document.getElementById('btn-remove-bg').click()`);
  const start = Date.now();
  // Poll until the overlay lifts, or give up after a generous wait.
  for (;;) {
    const o = await overlay();
    if (o.on && o.text) seen.push(o.text);
    if (!o.on && Date.now() - start > 4000) break;
    if (Date.now() - start > 120_000) break;
    await wait(150);
  }
  const captured = (await p.evaluate(
    `(() => { clearInterval(window.__capTimer); return Array.from(window.__caps); })()`,
  )) as string[];

  const all = Array.from(new Set([...seen, ...captured])).filter(Boolean);
  console.log('\n  captions seen:');
  for (const c of all) console.log(`    "${c}"`);

  console.log('\n--- what the user was told ---');
  check(all.length > 0, 'the overlay showed at least one caption');

  const downloadish = all.filter((c) => /download/i.test(c));
  const progressish = all.filter((c) => /\d+\s*%|\d+(\.\d+)?\s*MB/i.test(c));

  // Did the worker actually report a download? This, not elapsed time, is
  // what decides whether silence on screen is a bug. An earlier version
  // guessed from the clock and had no teeth at all: against a local server
  // the fetch finishes in about four seconds, so "too quick to have
  // downloaded" waved through a run where the model demonstrably downloaded.
  const elapsed = Date.now() - start;
  const workerDownloaded = rawWorker.some((t) => /download/i.test(t));
  console.log(`  (the removal took ${(elapsed / 1000).toFixed(1)}s)`);
  console.log(`  (the worker reported a download: ${workerDownloaded})`);

  if (workerDownloaded) {
    check(
      downloadish.length > 0,
      `the download the worker reported reached the screen${
        downloadish.length ? '' : ` — the user only saw "${all[0] ?? ''}"`
      }`,
    );
    check(progressish.length > 0, 'and carried a figure the user can watch move');
    check(
      downloadish.some((c) => /one time/i.test(c)),
      'and said it happens only once',
    );
    check(
      all.length > 1,
      `the caption moved rather than sitting on one line (saw ${all.length})`,
    );
  } else {
    console.log('  (no download this run — nothing to report)');
  }

  console.log('\n--- and what it did not say ---');
  const leaked = all.filter((c) => /webgpu|wasm|birefnet|onnx/i.test(c));
  check(leaked.length === 0, `no backend or model names leaked${leaked.length ? `: ${leaked.join(' | ')}` : ''}`);

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
