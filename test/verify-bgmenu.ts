// What the background button does once something is already removed.
//
// It used to be one button labelled "Remove again" that re-ran the pass from
// the ORIGINAL upload — state.imageEl, which a removal never updates. So it
// discarded the previous result and every correction, and looked for all the
// world like an undo. Measured before the fix: after a correction brought the
// artwork to 12889 opaque pixels, pressing it returned exactly 13335 — the
// first-removal figure, byte for byte.
//
// Now the button opens a menu, and the three intentions are separate:
// another pass over the image as it stands, a restart from the upload, and
// undo. This checks each one acts on what its label claims.
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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

  // Opaque pixels in the artwork on the canvas — the measure of what has
  // actually been removed, rather than of which buttons are showing.
  const opaque = async () =>
    (await p.evaluate(`(async () => {
      const href = document.getElementById('art').getAttribute('href');
      const im = new Image();
      await new Promise((r) => { im.onload = r; im.src = href; });
      const c = document.createElement('canvas');
      c.width = 400; c.height = Math.round(400 * im.height / im.width);
      const x = c.getContext('2d');
      x.clearRect(0, 0, c.width, c.height);
      x.drawImage(im, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++;
      return n;
    })()`)) as number;

  const menuOpen = async () =>
    await p.evaluate(`!document.getElementById('bg-menu').hidden`);
  const label = async () =>
    String(await p.evaluate(`document.getElementById('bg-btn-label').textContent.trim()`));

  // The href itself, not the rendered pixels. Undo restores the artwork
  // byte-for-byte AND puts the halo setting back, and the halo paints white
  // under the artwork — so a pixel count sees the halo return and reports a
  // difference in an image that is in fact identical.
  const artHref = async () =>
    String(await p.evaluate(`document.getElementById('art').getAttribute('href')`));

  const input = await p.$('input[type=file]');
  await input!.uploadFile(IMAGE);
  await wait(4000);
  const onUpload = await opaque();
  const uploadHref = await artHref();

  console.log('--- before anything is removed it is a plain button ---');
  check((await label()) === 'Remove background', `it says what it does (got "${await label()}")`);
  await p.click('#btn-remove-bg');
  await wait(9000);
  check((await menuOpen()) === false, 'the first press removed rather than opening a menu');
  const afterFirst = await opaque();
  check(afterFirst !== onUpload, `and something was removed (${onUpload} -> ${afterFirst})`);

  console.log('\n--- afterwards it offers a choice ---');
  check((await label()) === 'Background', `the label stops claiming one action (got "${await label()}")`);
  await p.click('#btn-remove-bg');
  await wait(500);
  check((await menuOpen()) === true, 'pressing it opens the menu');

  // A correction, so there is something for "Remove again" to lose.
  await p.evaluate(`document.getElementById('bg-menu').hidden = true`);
  const box = (await p.evaluate(`(() => {
    const r = document.getElementById('preview').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`)) as { x: number; y: number; w: number; h: number };
  await p.evaluate(`document.getElementById('btn-bg-refine').click()`);
  await wait(500);
  await p.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.5);
  await wait(3000);
  await p.evaluate(`document.getElementById('btn-bg-keep').click()`);
  await wait(6000);
  const corrected = await opaque();
  check(corrected !== afterFirst, `the correction changed the artwork (${afterFirst} -> ${corrected})`);

  console.log('\n--- "Remove again" builds on what is there ---');
  await p.evaluate(`document.getElementById('btn-remove-bg').click()`);
  await wait(500);
  await p.evaluate(`document.getElementById('btn-bg-again').click()`);
  await wait(10000);
  const afterAgain = await opaque();
  check(
    afterAgain !== afterFirst,
    `it did not snap back to the first result (${afterFirst} vs ${afterAgain})`,
  );
  check(
    afterAgain <= corrected,
    `and kept the correction (${corrected} -> ${afterAgain}, never grows back)`,
  );

  console.log('\n--- "Start over" goes back to the upload ---');
  await p.evaluate(`document.getElementById('btn-remove-bg').click()`);
  await wait(500);
  await p.evaluate(`document.getElementById('btn-bg-restart').click()`);
  await wait(10000);
  const afterRestart = await opaque();
  check(
    afterRestart === afterFirst,
    `it reproduces the first removal exactly (${afterFirst} vs ${afterRestart})`,
  );

  console.log('\n--- "Undo removal" puts the original back ---');
  await p.evaluate(`document.getElementById('btn-remove-bg').click()`);
  await wait(500);
  await p.evaluate(`document.getElementById('btn-bg-undo-all').click()`);
  await wait(4000);
  check((await artHref()) === uploadHref, 'the artwork is the file as opened, byte for byte');
  check(
    (await label()) === 'Remove background',
    `and the button is a plain action again (got "${await label()}")`,
  );

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
