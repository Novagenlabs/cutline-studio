// The credits dialog, signed out.
//
// It shipped saying "Not signed in left · 0 downloaded" above a Sign out
// button, to someone who was not signed in. Two separate faults produced
// that, and both are worth a test.
//
// The copy was one sentence with the balance interpolated into it, so the
// signed-out placeholder landed mid-sentence. The Sign out button had its
// `hidden` attribute set correctly and showed anyway: [hidden] is only
// display:none in the UA stylesheet, so `.btn { display: inline-flex }`
// outranked it. That second one is the dangerous one — `hidden` looks like
// it works everywhere, so the same trap is waiting for any component that
// sets its own display.
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

  console.log('--- `hidden` actually hides, whatever display a class sets ---');
  // Checked before the dialog is even opened: this is a CSS guarantee, and
  // every one of these elements carries the attribute at rest.
  check((await p.evaluate(`
    getComputedStyle(document.getElementById('credits-signout')).display
  `)) === 'none', 'a hidden .btn computes to display:none');
  check((await p.evaluate(`
    document.getElementById('btn-export-top').offsetHeight === 0
  `)) === true, 'and so does the top Export button before an image is open');

  console.log('\n--- signed out, the dialog says one coherent thing ---');
  await p.click('#st-credits');
  await wait(1500);

  const visible = (await p.evaluate(`
    JSON.stringify([...document.querySelectorAll('#credits-sheet .sheet-text')]
      .filter(el => el.offsetHeight > 0)
      .map(el => el.textContent.replace(/\\s+/g, ' ').trim()))
  `)) as string;
  const lines: string[] = JSON.parse(visible);
  const joined = lines.join(' ');

  check((await p.evaluate(`document.getElementById('credits-sheet').open`)) === true,
    'the dialog opened');
  check(!joined.includes('Not signed in left'),
    'no "Not signed in left ·" — the sentence that started this');
  check(!/—\s*left/.test(joined) && !/\bleft ·\s*—/.test(joined),
    'no em-dash placeholders standing in for numbers');
  check(joined.includes('Sign in to buy credits'),
    `it says what to do instead (got: "${lines[0] ?? ''}")`);

  console.log('\n--- and does not offer to sign you out ---');
  check((await p.evaluate(`
    document.getElementById('credits-signout').offsetHeight === 0
  `)) === true, 'Sign out is not shown to a signed-out visitor');
  // Scoped to the action row: the pack tiles are buttons too, and they are
  // meant to be there (disabled, checked below).
  check((await p.evaluate(`
    [...document.querySelectorAll('#credits-sheet .sheet-actions button')]
      .filter(x => x.offsetHeight > 0).map(x => x.textContent.trim()).join(',')
  `)) === 'Close', 'the only action offered is Close');

  console.log('\n--- the packs are shown but not buyable ---');
  check((await p.evaluate(`
    const p = [...document.querySelectorAll('#credits-packs .pack')];
    p.length > 0 && p.every(b => b.disabled)
  `)) === true, 'packs are listed and every one is disabled');

  console.log('\n--- un-hiding still works, so the rule did not over-reach ---');
  // The !important could have made `hidden = false` a no-op, which would
  // break the signed-in dialog instead. Same swap the signed-in path does.
  check((await p.evaluate(`
    const so = document.getElementById('credits-signout');
    const lineIn = document.getElementById('credits-line-in');
    so.hidden = false; lineIn.hidden = false;
    so.offsetHeight > 0 && lineIn.offsetHeight > 0
  `)) === true, 'clearing hidden brings an element back');

  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join('; ') : ''}`);
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
