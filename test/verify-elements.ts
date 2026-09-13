// The Elements list: does detection produce named, tunable rows in Simple?
//
// The per-element feature already worked, but it lived in Advanced behind
// chips labelled R1/R2/R3. This checks the thing a user can now actually do:
// load a logo, press Detect, and give the icon and the strapline different
// offsets without leaving the Simple tab.
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
  await p.setViewport({ width: 1600, height: 1000 });
  const errs: string[] = [];
  p.on('pageerror', (e: unknown) => { errs.push(e instanceof Error ? e.message : String(e)); });
  await p.goto(URL, { waitUntil: 'networkidle2' });

  console.log('--- the section stays out of the way until there is artwork ---');
  check(await p.evaluate(`document.getElementById('panel-elements').hidden`) === true,
    'hidden before an image is opened');

  const input = await p.$('input[type=file]');
  await input!.uploadFile('test/fixtures/feelathome.png');
  await wait(4000);

  check(await p.evaluate(`document.getElementById('panel-elements').hidden`) === false,
    'visible once artwork is open');
  check(String(await p.evaluate(`document.querySelector('#el-list').textContent`)).includes('Detect'),
    'and it says what Detect is for while the list is empty');

  console.log('\n--- detection fills the list with named rows ---');
  await p.evaluate(`document.getElementById('btn-detect-simple').click()`);
  await wait(3000);

  const rows = Number(await p.evaluate(`document.querySelectorAll('.el-row').length`));
  check(rows >= 2, `the logo splits into separate elements (got ${rows})`);

  const names = (await p.evaluate(
    `Array.from(document.querySelectorAll('.el-name')).map(e => e.textContent)`
  )) as string[];
  console.log(`  names: ${names.join(' | ')}`);
  check(names.every((n) => !/^R\d/.test(n)), 'rows are named, not numbered R1/R2');

  check(Number(await p.evaluate(`document.querySelectorAll('.el-row.active').length`)) === 1,
    'exactly one element is selected');

  console.log('\n--- each element carries its own offset ---');
  // Select the second element and move the offset slider; only that row's
  // number may change, or the per-element promise is not being kept.
  const before = (await p.evaluate(
    `Array.from(document.querySelectorAll('.el-mm')).map(e => e.textContent)`
  )) as string[];

  await p.evaluate(`document.querySelectorAll('.el-row')[1].click()`);
  await wait(400);
  await p.evaluate(`(() => {
    const el = document.querySelector('#in-offset');
    el.value = '5.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await wait(1500);

  const after = (await p.evaluate(
    `Array.from(document.querySelectorAll('.el-mm')).map(e => e.textContent)`
  )) as string[];
  console.log(`  before: ${before.join(' ')}   after: ${after.join(' ')}`);

  check(after[1] !== before[1], 'the selected element takes the new offset');
  check(
    after.filter((v, i) => v !== before[i]).length === 1,
    'and the others are left alone'
  );

  console.log(errs.length ? '\nPAGE ERRORS: ' + errs.join(' | ') : '\nno page errors');
  console.log(fails === 0 ? 'all element checks passed' : `${fails} CHECK(S) FAILED`);
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})();
