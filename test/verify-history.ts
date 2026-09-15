// Stepping back and forward through refine corrections.
//
// cutout.test.ts proves the matte maths: that redo's incremental append lands
// on the same pixels a full replay would. This checks the part that lives in
// the DOM and cannot be unit-tested — that the two arrows are actually wired,
// that each is disabled exactly when its stack is empty, that the count
// between them tracks the applied corrections, and above all that making a
// NEW correction after an undo throws the redo branch away.
//
// That last one is the rule most likely to be got wrong, and the most
// damaging: a redo that survives a new stroke would re-apply an edit from a
// history the user has already left.
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

  // Read the whole control in one go — disabled states and the count have to
  // agree with each other, so checking them separately would let a mismatch
  // through.
  const history = async () =>
    (await p.evaluate(`(() => {
      const u = document.getElementById('btn-bg-undo-stroke');
      const r = document.getElementById('btn-bg-redo-stroke');
      const c = document.getElementById('bg-history-count');
      return {
        undo: !!u && !u.disabled,
        redo: !!r && !r.disabled,
        count: c ? c.textContent.trim() : null,
      };
    })()`)) as { undo: boolean; redo: boolean; count: string | null };

  const input = await p.$('input[type=file]');
  await input!.uploadFile(IMAGE);
  await wait(4000);

  await p.click('#btn-remove-bg');
  await wait(8000);

  // The control lives in the Refine popover, so open it — and prove it opened,
  // since every assertion below would otherwise be reading hidden elements and
  // passing for the wrong reason.
  await p.click('#btn-bg-refine');
  await wait(600);
  const popOpen = async () =>
    await p.evaluate(`!document.getElementById('bg-pop').hidden`);

  console.log('--- a fresh refine session has no history ---');
  check((await popOpen()) === true, 'the refine popover is open');
  let h = await history();
  check(h.count !== null, 'the count element exists');
  check(h.undo === false, 'undo is disabled with nothing to undo');
  check(h.redo === false, 'redo is disabled with nothing to redo');
  check(h.count === '0', `the count reads zero (got "${h.count}")`);

  // Click the canvas to make real corrections. Three distinct points so each
  // is its own stroke rather than a repeat of the last.
  const box = await p.evaluate(`(() => {
    const r = document.getElementById('preview').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`) as { x: number; y: number; w: number; h: number };
  const corner = async (fx: number, fy: number) => {
    await p.mouse.click(box.x + box.w * fx, box.y + box.h * fy);
    await wait(1200);
  };

  console.log('\n--- corrections accumulate ---');
  await corner(0.06, 0.06);
  // Undo and redo are in this popover and a correction is the likeliest thing
  // to want undone, so the click that makes one must not dismiss them.
  check((await popOpen()) === true, 'making a correction leaves the popover open');
  h = await history();
  check(h.undo === true, 'undo becomes available after one correction');
  check(h.count === '1', `the count reads one (got "${h.count}")`);

  await corner(0.94, 0.06);
  await corner(0.94, 0.94);
  h = await history();
  check(h.count === '3', `three corrections are counted (got "${h.count}")`);
  check(h.redo === false, 'redo stays disabled while only moving forward');

  console.log('\n--- and step back one at a time ---');
  await p.click('#btn-bg-undo-stroke');
  await wait(1500);
  h = await history();
  check(h.count === '2', `undo drops the count to two (got "${h.count}")`);
  check(h.redo === true, 'redo becomes available once something is undone');

  await p.click('#btn-bg-undo-stroke');
  await wait(1500);
  await p.click('#btn-bg-undo-stroke');
  await wait(1500);
  h = await history();
  check(h.count === '0', `all the way back to zero (got "${h.count}")`);
  check(h.undo === false, 'undo is disabled at the start of history');
  check(h.redo === true, 'redo still offers the whole trail back');

  console.log('\n--- and forward again ---');
  await p.click('#btn-bg-redo-stroke');
  await wait(1500);
  h = await history();
  check(h.count === '1', `redo restores the first correction (got "${h.count}")`);
  check(h.undo === true, 'undo is available again');

  await p.click('#btn-bg-redo-stroke');
  await wait(1500);
  await p.click('#btn-bg-redo-stroke');
  await wait(1500);
  h = await history();
  check(h.count === '3', `redo walks back to the end (got "${h.count}")`);
  check(h.redo === false, 'redo is disabled at the end of history');

  console.log('\n--- a new correction abandons the redo branch ---');
  await p.click('#btn-bg-undo-stroke');
  await wait(1500);
  check((await history()).redo === true, 'redo is available after the undo');

  await corner(0.5, 0.94);
  h = await history();
  check(h.redo === false, 'making a new correction clears the redo trail');
  check(h.count === '3', `and the new correction is counted (got "${h.count}")`);

  console.log('\n--- undo all clears the whole history ---');
  await p.click('#btn-bg-undo');
  await wait(2500);
  h = await history();
  check(h.count === '0', `the count is back to zero (got "${h.count}")`);
  check(h.undo === false, 'undo is disabled');
  check(h.redo === false, 'and redo cannot resurrect the discarded strokes');

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
