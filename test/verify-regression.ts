// The four UI-side fixes from the v1-vs-current regression investigation.
//
// The tracer is identical to v1's; what changed is what the UI hands it and
// what the user can do by accident. Each check here is a user action that
// produced a wrong or dead result before the fix:
//
//   1. Detect (Simple tab) then a cut-style stop: the offset used to stay
//      frozen at the value Detect had seeded into every element, with the
//      new stop lit as if it had applied.
//   2. A press on the stop the knob is already parked on (custom Advanced
//      params) used to do nothing — Base UI drops an equal value.
//   3. In refine mode a drag that started on the artwork used to flood-remove
//      a whole same-colour area instead of panning.
//   4. After a background removal, SVG/PDF/PNG export used to send a blob:
//      URL the server refuses, failing with a bare 400.
//
// Checks 3 and 4 run on a white-flattened copy of the fixture: once removal
// is alpha-aware a transparent PNG has nothing to remove, which is correct,
// but it would leave these two with no refine session to test.
import puppeteer from 'puppeteer-core';
import { flatFixture } from './fixture-flat';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.APP_URL ?? 'http://localhost:3000';
const FIXTURE = 'test/fixtures/feelathome.png';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`);
  if (!ok) fails++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const flat = await flatFixture(FIXTURE);

  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1500, height: 940 });

  // Signed in with credits, and the export request captured — both answered
  // in the page, so no account is touched and nothing is charged.
  let exportBody: string | null = null;
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/me')) {
      void req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ signedIn: true, balance: 5, signupGrant: 3 }),
      });
      return;
    }
    if (url.includes('/api/export') && req.method() === 'POST') {
      exportBody = req.postData() ?? '';
      void req.respond({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'captured by verify:regression' }),
      });
      return;
    }
    void req.continue();
  });

  await p.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await wait(6500);
  await p.evaluate(`document.querySelector('.tour-skip')?.click()`);
  await wait(400);

  const cut = async () =>
    String(await p.evaluate(`document.getElementById('cut-path')?.getAttribute('d') || ''`));
  const text = async (sel: string) =>
    String(await p.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() ?? ''`));
  const stop = async (id: string) => {
    await p.evaluate(`document.querySelector('.cutstop[data-preset="${id}"]').click()`);
    await wait(2500);
  };

  const input = await p.$('input[type=file]');
  await input!.uploadFile(FIXTURE);
  await wait(5000);

  console.log('--- 1. Detect no longer freezes the cut style ---');
  await stop('tight');
  const tightBefore = await cut();
  check((await text('#out-cut-offset')) === '0.00 mm', 'Tight reads 0.00 mm before Detect');
  await stop('sticker');
  await p.evaluate(`document.getElementById('btn-detect-simple').click()`);
  await wait(3000);
  const rows = Number(await p.evaluate(`document.querySelectorAll('#el-list .el-row').length`));
  check(rows >= 2, `Detect found elements (${rows} rows)`);
  await stop('tight');
  check(
    (await text('#out-cut-offset')) === '0.00 mm',
    `Tight after Detect reads 0.00 mm (got "${await text('#out-cut-offset')}")`,
  );
  check(
    (await cut()) === tightBefore,
    'and the cut is byte-identical to Tight without Detect — elements follow the global offset',
  );
  await stop('sticker');

  console.log('\n--- 2. a press on the parked stop re-applies its preset ---');
  // Custom params, made the way a user makes them: dragging the Advanced
  // offset thumb. (Neither the hidden native input nor keyboard reaches this
  // Base UI control — its thumb is tabindex -1 — so those would test
  // nothing.) The knob then parks on the stop nearest the new value, and a
  // press on that stop is exactly what used to be dead.
  // A fresh load of the image first: Detect left element 1 selected, so the
  // Advanced offset would edit that element rather than the global value,
  // and its element list pushes the Advanced rows down the rail.
  await input!.uploadFile(FIXTURE);
  await wait(5000);
  await p.evaluate(`document.getElementById('tab-advanced').click()`);
  await wait(600);
  await p.evaluate(
    `document.getElementById('in-offset').closest('.row').scrollIntoView({ block: 'center' })`,
  );
  await wait(400);
  const offThumb = (await p.evaluateHandle(
    `document.getElementById('in-offset').closest('.row').querySelector('.bui-slider-thumb')`,
  )) as import('puppeteer-core').ElementHandle<Element>;
  const ob = await offThumb.boundingBox();
  check(ob !== null, 'the Advanced offset thumb is visible');
  await p.mouse.move(ob!.x + ob!.width / 2, ob!.y + ob!.height / 2);
  await p.mouse.down();
  await p.mouse.move(ob!.x + ob!.width / 2 + 40, ob!.y + ob!.height / 2, { steps: 8 });
  await p.mouse.up();
  await wait(2500);
  // The native input stays the model, and is the one readout that is live
  // while the Advanced tab is showing; the Simple tab's cut-style readout
  // only re-syncs when that tab is shown again.
  const customText = String(await p.evaluate(`document.getElementById('in-offset').value`));
  const custom = parseFloat(customText);
  check(
    Number.isFinite(custom) && Math.abs(custom - 3) > 0.2,
    `dragging the Advanced offset made custom params (offset ${customText} mm)`,
  );
  // Which stop the knob parks on: the nearest by offset, as the UI does.
  const stops: Array<[string, number]> = [['tight', 0], ['close', 1], ['sticker', 3], ['loose', 6]];
  const [nearestId, nearestMm] = stops.reduce((a, b) =>
    Math.abs(b[1] - custom) < Math.abs(a[1] - custom) ? b : a,
  );
  await p.evaluate(`document.getElementById('tab-simple').click()`);
  await wait(600);
  check(
    (await text('#out-cut-offset')) === `${custom.toFixed(2)} mm`,
    `the Simple tab shows the custom value (got "${await text('#out-cut-offset')}")`,
  );
  const thumb = await p.$('#mount-cutstyle .bui-slider-thumb');
  check(thumb !== null, 'the cut-style thumb exists');
  const tb = await thumb!.boundingBox();
  await p.mouse.click(tb!.x + tb!.width / 2, tb!.y + tb!.height / 2);
  await wait(2500);
  check(
    (await text('#out-cut-offset')) === `${nearestMm.toFixed(2)} mm`,
    `pressing the parked stop re-applied ${nearestId} (got "${await text('#out-cut-offset')}")`,
  );
  check(
    (await text('#out-offset')) === `${nearestMm.toFixed(1)} mm`,
    'and the Advanced offset followed',
  );

  console.log('\n--- 3. in refine mode a drag pans and a click corrects ---');
  await input!.uploadFile(flat);
  await wait(5000);
  await p.evaluate(`document.getElementById('btn-remove-bg').click()`);
  await wait(9000);
  check(
    (await p.evaluate(`document.body.classList.contains('is-refining-bg')`)) === true,
    'a refine session is open on the flattened image',
  );
  const box = (await p.evaluate(`(() => {
    const r = document.getElementById('preview').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`)) as { x: number; y: number; w: number; h: number };
  const transformBefore = await p.evaluate(
    `document.querySelector('#preview g[transform]')?.getAttribute('transform') ?? ''`,
  );
  // A drag: press on the artwork, travel well past the slop, release.
  const sx = box.x + box.w * 0.5;
  const sy = box.y + box.h * 0.5;
  await p.mouse.move(sx, sy);
  await p.mouse.down();
  await p.mouse.move(sx + 30, sy + 20, { steps: 6 });
  await p.mouse.move(sx + 80, sy + 50, { steps: 6 });
  await p.mouse.up();
  await wait(1500);
  check((await text('#bg-history-count')) === '0', `a drag recorded no correction (count ${await text('#bg-history-count')})`);
  const transformAfter = await p.evaluate(
    `document.querySelector('#preview g[transform]')?.getAttribute('transform') ?? ''`,
  );
  check(transformAfter !== transformBefore, `and it panned the view (${transformBefore} -> ${transformAfter})`);
  // A click still corrects, at the press point.
  await p.mouse.click(sx, sy);
  await wait(2000);
  check((await text('#bg-history-count')) === '1', `a click recorded one correction (count ${await text('#bg-history-count')})`);

  console.log('\n--- 4. export after a removal sends a data: URL ---');
  await p.evaluate(`document.getElementById('btn-bg-keep').click()`);
  await wait(6000);
  const artHref = String(await p.evaluate(`document.getElementById('art').getAttribute('href')`));
  check(artHref.startsWith('blob:'), 'the studio holds the cutout as a blob: URL (so the conversion is real)');
  await p.evaluate(`document.getElementById('btn-export').click()`);
  await wait(800);
  const sheetOpen = await p.evaluate(`!!document.getElementById('export-sheet')?.open`);
  check(sheetOpen === true, 'the export sheet opened');
  await p.evaluate(`document.querySelector('#export-sheet button[value="download"]').click()`);
  // The confirm-before-spend dialog, if it is not pre-confirmed by the sheet.
  await wait(800);
  await p.evaluate(`(() => {
    const d = document.getElementById('confirm-export');
    if (d && d.open) document.getElementById('confirm-go')?.click();
  })()`);
  // Encoding a multi-megapixel PNG to base64 takes a moment.
  for (let i = 0; i < 40 && exportBody === null; i++) await wait(500);
  check(exportBody !== null, 'an export request was sent');
  if (exportBody) {
    const body = JSON.parse(exportBody) as { format?: string; imageDataUrl?: string };
    check(
      typeof body.imageDataUrl === 'string' && body.imageDataUrl.startsWith('data:image/'),
      `imageDataUrl is a data: URL the server accepts (starts "${String(body.imageDataUrl).slice(0, 15)}")`,
    );
    check(body.format === 'SVG', `format is the sheet's default (${body.format})`);
  }

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
