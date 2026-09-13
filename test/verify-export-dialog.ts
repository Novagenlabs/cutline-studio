// The export dialog's format choice and its save-as-default switch.
//
// Two bugs live here if nobody watches. The switch is an <input type=checkbox>
// wearing a different shape, so a generic checkbox rule can silently steal its
// knob geometry — it once rendered as a 4x8px sliver of the checkmark instead
// of a 21px circle. And the dialog repaints when a format is chosen, which
// once reset the toggle out from under the user.
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
  await p.evaluate(`localStorage.removeItem('cutline.defaultFormat')`);

  await p.evaluate(`document.getElementById('btn-sample').click()`);
  await wait(1200);
  await p.evaluate(`document.getElementById('btn-export').click()`);
  await wait(500);

  console.log('--- the switch is a switch, not a checkbox ---');
  const knob = await p.evaluate(`(() => {
    const s = document.getElementById('export-save-default');
    const cs = getComputedStyle(s);
    const a = getComputedStyle(s, '::after');
    return { trackW: cs.width, trackH: cs.height, knobW: a.width, knobH: a.height };
  })()`) as Record<string, string>;
  console.log(`  track ${knob.trackW}x${knob.trackH}, knob ${knob.knobW}x${knob.knobH}`);

  check(knob.trackW === '42px' && knob.trackH === '25px', 'the track keeps its own size');
  // The regression: the checkmark rule is 4x8. A square knob proves the
  // generic checkbox styling is not reaching this control.
  check(knob.knobW === knob.knobH, `the knob is round, not a checkmark sliver (${knob.knobW}x${knob.knobH})`);
  check(parseFloat(knob.knobW) > 15, 'and it fills the track rather than hiding in a corner');

  console.log('\n--- the switch survives choosing a format ---');
  // This is the interaction that used to silently undo the user's choice.
  await p.evaluate(`document.getElementById('export-save-default').click()`);
  await wait(200);
  const afterToggle = await p.evaluate(`document.getElementById('export-save-default').checked`);
  check(afterToggle === true, 'clicking it turns it on');

  await p.evaluate(`document.querySelector('#export-sheet [data-format="SVG"]').click()`);
  await wait(300);
  check(await p.evaluate(`document.getElementById('export-save-default').checked`) === true,
    'clicking the already-selected format leaves it on');

  console.log('\n--- changing format re-asks the question ---');
  await p.evaluate(`document.querySelector('#export-sheet [data-format="PDF"]').click()`);
  await wait(300);
  check(await p.evaluate(`document.getElementById('export-save-default').checked`) === false,
    'switching to a format that is not the default clears it');
  check(String(await p.evaluate(`document.getElementById('export-save-label').textContent`)).includes('PDF'),
    'and the label names the new format');

  console.log('\n--- the default is actually saved ---');
  await p.evaluate(`document.getElementById('export-save-default').click()`);
  await wait(200);
  await p.evaluate(`document.querySelector('#export-sheet button[value="download"]').click()`);
  await wait(800);

  check(await p.evaluate(`localStorage.getItem('cutline.defaultFormat')`) === 'PDF',
    'the chosen format is stored');
  check(String(await p.evaluate(`document.getElementById('export-default').textContent`)).includes('PDF'),
    'and the rail caption says so');

  console.log('\n--- a saved default comes back preselected ---');
  await p.evaluate(`document.getElementById('btn-export').click()`);
  await wait(500);
  check(await p.evaluate(`document.querySelector('#export-sheet .fmt.is-on').dataset.format`) === 'PDF',
    'reopening preselects the saved format');
  check(await p.evaluate(`document.getElementById('export-save-default').checked`) === true,
    'and shows it is already the default');
  check(Number(await p.evaluate(`document.querySelectorAll('#export-sheet .fmt-default').length`)) === 1,
    'exactly one row carries the DEFAULT badge');

  console.log(errs.length ? '\nPAGE ERRORS: ' + errs.join(' | ') : '\nno page errors');
  console.log(fails === 0 ? 'all export-dialog checks passed' : `${fails} CHECK(S) FAILED`);
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})();
