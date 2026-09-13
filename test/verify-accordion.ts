// The Advanced rail as an accordion: four sections that fold away.
//
// Advanced is deep enough that finding one control means scrolling past three
// sections with nothing to do with the job. Each heading now collapses its own
// body. The risk worth testing is not the click — it is that the collapse
// fights the mode rules that already hide and show `.group`, which is the
// exact class of bug that bit #panel-elements. So this checks that collapsing
// hides only the intended body, that switching tabs does not resurrect a
// section the user closed, and that the AI copy no longer names the model.
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
  await wait(4500); // the splash owns the first four seconds

  await p.click('#tab-advanced');
  await wait(300);

  console.log('--- every advanced section has a trigger, and starts open ---');
  const names = (await p.evaluate(
    `[...document.querySelectorAll('.group-toggle span')].map(s => s.textContent)`
  )) as string[];
  check(names.length === 4, `four triggers (got ${names.length})`);
  for (const want of ['Artwork', 'Cut path', 'Die shape', 'Output']) {
    check(names.includes(want), `"${want}" is collapsible`);
  }
  check(
    (await p.evaluate(
      `[...document.querySelectorAll('.group-toggle')].every(t => t.getAttribute('aria-expanded') === 'true')`
    )) === true,
    'all four start expanded'
  );
  check(
    (await p.evaluate(
      `[...document.querySelectorAll('.group-body')].every(b => b.offsetHeight > 0)`
    )) === true,
    'and every body is actually on screen'
  );

  console.log('\n--- collapsing folds one section and leaves the rest ---');
  const heightBefore = (await p.evaluate(`document.querySelector('.rail').scrollHeight`)) as number;
  await p.evaluate(
    `[...document.querySelectorAll('.group-toggle')].find(t => t.textContent.includes('Artwork')).click()`
  );
  await wait(250);
  check(
    (await p.evaluate(`document.getElementById('in-dpi').closest('.group-body').hidden`)) === true,
    'Artwork body is hidden'
  );
  check(
    (await p.evaluate(
      `[...document.querySelectorAll('.group-toggle')].find(t => t.textContent.includes('Artwork')).getAttribute('aria-expanded')`
    )) === 'false',
    'and the trigger says so'
  );
  check(
    (await p.evaluate(`document.getElementById('in-spot').offsetHeight > 0`)) === true,
    'Output is untouched'
  );
  const heightAfter = (await p.evaluate(`document.querySelector('.rail').scrollHeight`)) as number;
  check(heightAfter < heightBefore, `the rail got shorter (${heightBefore} -> ${heightAfter})`);
  check(
    (await p.evaluate(`!!document.querySelector('.group-toggle').offsetHeight`)) === true,
    'the heading itself stays visible when closed'
  );

  console.log('\n--- a closed section stays closed across a mode round trip ---');
  await p.click('#tab-simple');
  await wait(250);
  await p.click('#tab-advanced');
  await wait(250);
  check(
    (await p.evaluate(`document.getElementById('in-dpi').closest('.group-body').hidden`)) === true,
    'Artwork is still folded after Simple -> Advanced'
  );
  check(
    (await p.evaluate(`document.getElementById('in-spot').offsetHeight > 0`)) === true,
    'and the open sections came back'
  );

  console.log('\n--- reopening restores the controls ---');
  await p.evaluate(
    `[...document.querySelectorAll('.group-toggle')].find(t => t.textContent.includes('Artwork')).click()`
  );
  await wait(250);
  check(
    (await p.evaluate(`document.getElementById('in-dpi').offsetHeight > 0`)) === true,
    'Print DPI is reachable again'
  );

  console.log('\n--- the rail never names the model ---');
  const rail = String(await p.evaluate(`document.querySelector('.rail').textContent`));
  for (const leak of ['BiRefNet', 'MB', 'model download', 'Neural matting']) {
    check(!rail.includes(leak), `no mention of "${leak}"`);
  }
  check(rail.includes('Smart edge detection'), 'the option is named by what it does');

  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join('; ') : ''}`);
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
