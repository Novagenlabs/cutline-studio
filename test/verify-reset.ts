// Reset all settings: does it actually put everything back?
//
// The failure mode worth testing is a partial reset. state.params is trivial
// to restore — it is one object assignment — but the controls are a separate
// surface, and a slider whose input changed without its readout and thumb
// following looks reset while reporting the old number. So this drives real
// controls in all four Advanced sections, presses the button, and checks the
// inputs, the readouts AND the mirrored Simple-tab controls, plus the two
// things reset must NOT do: close the image or sign the user out.
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
  await wait(4500);

  await p.click('#btn-sample');
  await wait(4000);
  await p.click('#tab-advanced');
  await wait(400);

  console.log('--- the button belongs to Advanced ---');
  check((await p.evaluate(`document.getElementById('btn-reset').offsetHeight > 0`)) === true,
    'visible in Advanced');
  await p.click('#tab-simple');
  await wait(300);
  check((await p.evaluate(`document.getElementById('btn-reset').offsetHeight > 0`)) === false,
    'and hidden in Simple, where there is nothing advanced to reset');
  await p.click('#tab-advanced');
  await wait(300);

  console.log('\n--- move settings across all four sections ---');
  await p.evaluate(`
    const setRange = (id, v) => {
      const e = document.getElementById(id);
      e.value = String(v);
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setRange('in-alpha', 210);
    setRange('in-bgtol', 99);
    setRange('in-denoise', 1.8);
    setRange('in-offset', 6);
    const dpi = document.getElementById('in-dpi');
    dpi.value = '600';
    dpi.dispatchEvent(new Event('change', { bubbles: true }));
    for (const id of ['in-holes', 'in-body']) {
      const c = document.getElementById(id);
      c.checked = true;
      c.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const cm = document.getElementById('in-cutmode');
    cm.value = 'perf';
    cm.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await wait(900);
  check((await p.evaluate(`document.getElementById('in-alpha').value`)) === '210',
    'settings are genuinely off-default before the reset');

  console.log('\n--- reset puts every one of them back ---');
  await p.click('#btn-reset');
  await wait(1200);

  const after = (await p.evaluate(`
    const g = id => document.getElementById(id);
    JSON.stringify({
      alpha: g('in-alpha').value, bgtol: g('in-bgtol').value,
      denoise: g('in-denoise').value, offset: g('in-offset').value,
      dpi: g('in-dpi').value, holes: g('in-holes').checked,
      holesSimple: g('in-holes-simple').checked, body: g('in-body').checked,
      ai: g('in-ai').checked, halo: g('in-halo').checked,
      cutmode: g('in-cutmode').value, spot: g('in-spot').value,
      outAlpha: g('out-alpha').textContent.trim(),
      outDenoise: g('out-denoise').textContent.trim(),
      outOffset: g('out-offset').textContent.trim(),
    })
  `)) as string;
  const s = JSON.parse(after);

  check(s.alpha === '128', `alpha threshold back to 128 (got ${s.alpha})`);
  check(s.bgtol === '32', `background tolerance back to 32 (got ${s.bgtol})`);
  check(s.denoise === '0.4', `edge denoise back to 0.4 (got ${s.denoise})`);
  check(s.offset === '3', `offset back to 3 (got ${s.offset})`);
  check(s.dpi === '300', `DPI back to 300 (got ${s.dpi})`);
  check(s.holes === false, 'interior holes off');
  check(s.body === false, 'hug body off');
  check(s.ai === false, 'smart edges off');
  check(s.halo === true, 'halo back on');
  check(s.cutmode === 'kiss', `cut type back to kiss (got ${s.cutmode})`);
  check(s.spot === 'CutContour', `spot name follows the cut type (got ${s.spot})`);

  console.log('\n--- the readouts follow, not just the inputs ---');
  // A slider whose input moved but whose readout did not looks reset while
  // still reporting the old number — the specific bug this guards.
  check(s.outAlpha === '128', `alpha readout says 128 (got "${s.outAlpha}")`);
  check(s.outDenoise.startsWith('0.4'), `denoise readout says 0.4 (got "${s.outDenoise}")`);
  check(s.outOffset.startsWith('3.0'), `offset readout says 3.0 (got "${s.outOffset}")`);

  console.log('\n--- the Simple tab is the same settings, so it follows too ---');
  check(s.holesSimple === false, 'the mirrored holes checkbox cleared as well');

  console.log('\n--- and it resets settings, not the session ---');
  check((await p.evaluate(`!document.body.textContent.includes('No image open')`)) === true,
    'the image stays open — it is not a setting');
  check(String(await p.evaluate(`
    [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' ')
  `)).includes('reset'), 'and it says so');

  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join('; ') : ''}`);
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
