// Drives the real UI: do the simple-mode presets set the parameters they
// claim, and does Tight actually cut on the edge?
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.APP_URL ?? 'http://localhost:3000/';

let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

const read = (p: any, sel: string) => p.evaluate(`document.querySelector('${sel}').textContent`);

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 180_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1600, height: 1000 });
  const errs: string[] = [];
  p.on('pageerror', (e: unknown) => { errs.push(e instanceof Error ? e.message : String(e)); });
  await p.goto(URL, { waitUntil: 'networkidle2' });

  console.log('--- simple mode is the default ---');
  check(await p.evaluate(`document.body.classList.contains('mode-simple')`) === true,
    'body is in simple mode on load');
  check(await p.evaluate(`getComputedStyle(document.querySelector('#panel-simple')).display`) !== 'none',
    'the cut-style panel is visible');
  // Advanced controls must be hidden, not merely present.
  const advVisible = await p.evaluate(
    `Array.from(document.querySelectorAll('.rail > .group'))
       .filter(g => g.id !== 'panel-simple' && !g.classList.contains('always-on'))
       .some(g => getComputedStyle(g).display !== 'none')`
  );
  check(advVisible === false, 'advanced sections are hidden in simple mode');
  check(await p.evaluate(`getComputedStyle(document.querySelector('#btn-svg').closest('.group')).display`) !== 'none',
    'the download buttons stay visible in simple mode');

  console.log('\n--- Tight cuts on the edge ---');
  await p.click('.preset[data-preset="tight"]');
  await new Promise((r) => setTimeout(r, 500));
  await p.click('#tab-advanced');
  await new Promise((r) => setTimeout(r, 300));
  const t = {
    offset: await read(p, '#out-offset'),
    corner: await read(p, '#out-corner'),
    precision: await read(p, '#out-precision'),
    smooth: await read(p, '#out-smooth'),
  };
  console.log(`  offset=${t.offset} corner=${t.corner} precision=${t.precision} smoothness=${t.smooth}`);
  check(String(t.offset).startsWith('0.0'), 'offset is 0.00 mm');
  check(String(t.corner).startsWith('0.0'), 'min corner radius is 0');
  check(String(t.precision).includes('0.02'), 'precision is +/-0.02 mm');
  check(String(t.smooth) === '0', 'smoothing is off');

  console.log('\n--- looser presets step up from there ---');
  for (const [preset, mm] of [['close', '1.0'], ['sticker', '3.0'], ['loose', '6.0']] as const) {
    await p.click('#tab-simple');
    await new Promise((r) => setTimeout(r, 200));
    await p.click(`.preset[data-preset="${preset}"]`);
    await new Promise((r) => setTimeout(r, 400));
    await p.click('#tab-advanced');
    await new Promise((r) => setTimeout(r, 250));
    const off = String(await read(p, '#out-offset'));
    const corner = String(await read(p, '#out-corner'));
    console.log(`  ${preset}: offset=${off} corner=${corner}`);
    check(off.startsWith(mm), `${preset} sets ${mm} mm offset`);
    check(parseFloat(corner) > 0, `${preset} gives the blade corner relief`);
  }

  console.log('\n--- the two hole checkboxes are one setting ---');
  await p.click('#tab-simple');
  await new Promise((r) => setTimeout(r, 200));
  await p.click('#in-holes-simple');
  await new Promise((r) => setTimeout(r, 400));
  check(await p.evaluate(`document.querySelector('#in-holes').checked`) === true,
    'ticking the simple box ticks the advanced one');
  await p.click('#tab-advanced');
  await new Promise((r) => setTimeout(r, 250));
  await p.click('#in-holes');
  await new Promise((r) => setTimeout(r, 400));
  check(await p.evaluate(`document.querySelector('#in-holes-simple').checked`) === false,
    'and unticking the advanced one unticks the simple one');

  console.log('\n--- an advanced tweak stops claiming to be a preset ---');
  await p.evaluate(`(() => {
    const el = document.querySelector('#in-offset');
    el.value = '4.35';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  await p.click('#tab-simple');
  await new Promise((r) => setTimeout(r, 300));
  const lit = await p.evaluate(`document.querySelectorAll('.preset.active').length`);
  check(lit === 0, 'no preset is highlighted after a manual change');
  check(String(await read(p, '#preset-hint')).toLowerCase().includes('custom'),
    'the hint says the settings are custom');

  console.log(errs.length ? '\nPAGE ERRORS: ' + errs.join(' | ') : '\nno page errors');
  console.log(fails === 0 ? 'all preset checks passed' : `${fails} CHECK(S) FAILED`);
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})();
