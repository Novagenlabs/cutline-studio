// The cutline follows the cutout, without waiting for Done.
//
// The cut is generated from the tracer's own copy of the artwork. That copy
// was only rebuilt when Done was pressed, so throughout a refine session the
// cut described the ORIGINAL image — background included — while the canvas
// showed the cutout. Every advanced setting touched in between operated on the
// wrong picture. Reported as the settings "not working as good" until the
// background was marked done.
//
// Measured before the fix: the cut path was byte-identical before and during
// the session (6 rings, 20333 chars) and only changed at Done (4 rings).
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

  // The path data itself, so a change in the cut cannot hide behind a
  // coincidentally equal ring count.
  const cut = async () =>
    String(
      await p.evaluate(`document.getElementById('cut-path')?.getAttribute('d') || ''`),
    );
  const rings = (d: string) => (d.match(/M/g) || []).length;

  const input = await p.$('input[type=file]');
  await input!.uploadFile(IMAGE);
  await wait(4000);
  const original = await cut();
  check(original.length > 0, `there is a cut to begin with (${rings(original)} rings)`);

  console.log('--- removing the background retraces the cut ---');
  await p.click('#btn-remove-bg');
  await wait(9000);
  const removed = await cut();
  check(removed !== original, 'the cut changed when the background went');
  check(
    rings(removed) !== rings(original),
    `and follows the cutout, not the photo (${rings(original)} rings -> ${rings(removed)})`,
  );

  console.log('\n--- and a correction retraces it again ---');
  const box = (await p.evaluate(`(() => {
    const r = document.getElementById('preview').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`)) as { x: number; y: number; w: number; h: number };

  // The stroke has to CHANGE the artwork or the cut is right to stay put and
  // the check passes for the wrong reason. Measured: a keep-stroke at the
  // centre restores nothing — that area is already opaque artwork — so this
  // drops a region of the subject instead, and the pixel count is asserted
  // rather than assumed.
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

  const beforeStroke = await opaque();
  await p.evaluate(`document.getElementById('btn-bg-refine').click()`);
  await wait(500);
  await p.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.5);
  await wait(3000);
  const afterStroke = await opaque();
  check(
    afterStroke !== beforeStroke,
    `the correction changed the artwork (${beforeStroke} -> ${afterStroke} opaque)`,
  );

  const corrected = await cut();
  check(corrected !== removed, 'and the cut changed with it, without pressing Done');

  console.log('\n--- so Done has nothing left to catch up on ---');
  await p.evaluate(`document.getElementById('btn-bg-keep').click()`);
  await wait(6000);
  const done = await cut();
  check(
    done === corrected,
    'the cut after Done is the cut the user was already looking at',
  );

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
