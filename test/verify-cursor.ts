// The refine cursor.
//
// A crosshair says "this click acts on the pixel under it"; the pan hand says
// the opposite. The rule existed but was written against #stage, while the
// SVG inside it sets its own `cursor: grab` — so it never reached the element
// the pointer is actually over and the hand stayed put through the whole
// refine session.
//
// Checked with getComputedStyle on #preview rather than by reading the
// stylesheet, because the bug was entirely about which element wins.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.APP_URL ?? 'http://localhost:3000/';
const IMAGE = process.env.CURSOR_FIXTURE ?? 'test/fixtures/feelathome.png';

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
  await p.goto(URL, { waitUntil: 'networkidle2' });
  await wait(6500);
  await p.evaluate(`document.querySelector('.tour-skip')?.click()`);
  await wait(400);

  const cursor = async () =>
    String(await p.evaluate(`getComputedStyle(document.getElementById('preview')).cursor`));

  console.log('--- the canvas pans by default ---');
  check((await cursor()) === 'grab', `grab before anything is opened (got "${await cursor()}")`);

  const input = await p.$('input[type=file]');
  await input!.uploadFile(IMAGE);
  await wait(4000);
  check((await cursor()) === 'grab', 'still grab with artwork open');

  console.log('\n--- and shows a crosshair while refining ---');
  await p.click('#btn-remove-bg');
  await wait(8000);

  const refining = await p.evaluate(`document.body.classList.contains('is-refining-bg')`);
  check(refining === true, 'the refine session started');
  check((await cursor()) === 'crosshair',
    `the cursor is a crosshair (got "${await cursor()}")`);

  // A drag during a refine session is still a correction, not a pan, so the
  // .panning variant must not restore the hand mid-stroke.
  await p.evaluate(`document.getElementById('preview').classList.add('panning')`);
  check((await cursor()) === 'crosshair', 'and stays one even mid-drag');
  await p.evaluate(`document.getElementById('preview').classList.remove('panning')`);

  console.log('\n--- and gives the hand back when the session ends ---');
  await p.click('#btn-bg-keep');
  await wait(3000);
  check((await p.evaluate(`document.body.classList.contains('is-refining-bg')`)) === false,
    'the session ended');
  check((await cursor()) === 'grab', `back to grab (got "${await cursor()}")`);

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
