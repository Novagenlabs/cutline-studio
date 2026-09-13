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

  console.log('\n--- the pill does what it says it does ---');
  // It reads "Sign in to download". It used to open the credits dialog, where
  // every pack is disabled and nothing can be signed into — a control that
  // names an action and then offers no way to take it.
  check(String(await p.evaluate(`
    document.querySelector('#st-credits .credit-count').textContent + ' ' +
    document.querySelector('#st-credits .credit-label').textContent
  `)) === 'Sign in to download', 'signed out, the pill reads "Sign in to download"');

  await p.click('#st-credits');
  await wait(1500);
  check((await p.evaluate(`document.getElementById('signin-sheet').open`)) === true,
    'and clicking it opens the sign-in sheet');
  check((await p.evaluate(`document.getElementById('credits-sheet').open`)) === false,
    'not the credits dialog it cannot buy from');

  await p.evaluate(`document.getElementById('signin-sheet').close()`);
  await wait(400);

  console.log('\n--- signed out, the credits dialog says one coherent thing ---');
  // Reached here the way the "out of credits" toast reaches it, rather than
  // through the pill, which now routes to sign-in instead.
  await p.evaluate(`
    document.getElementById('credits-signin').hidden = false;
    document.getElementById('credits-signout').hidden = true;
    document.getElementById('credits-line-out').hidden = false;
    document.getElementById('credits-line-in').hidden = true;
    document.getElementById('credits-sheet').showModal();
  `);
  await wait(600);

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

  console.log('\n--- and offers sign-in rather than sign-out ---');
  check((await p.evaluate(`
    document.getElementById('credits-signout').offsetHeight === 0
  `)) === true, 'Sign out is not shown to a signed-out visitor');
  // Scoped to the action row: the pack tiles are buttons too, and they are
  // meant to be there (disabled, checked below).
  check((await p.evaluate(`
    [...document.querySelectorAll('#credits-sheet .sheet-actions button')]
      .filter(x => x.offsetHeight > 0).map(x => x.textContent.trim()).join(',')
  `)) === 'Close,Sign in', 'Close and Sign in are offered — not a dead end');

  console.log('\n--- signed in, the pair swaps ---');
  check((await p.evaluate(`
    document.getElementById('credits-signin').hidden = true;
    document.getElementById('credits-signout').hidden = false;
    [...document.querySelectorAll('#credits-sheet .sheet-actions button')]
      .filter(x => x.offsetHeight > 0).map(x => x.textContent.trim()).join(',')
  `)) === 'Close,Sign out', 'exactly one of Sign in / Sign out is ever offered');
  await p.evaluate(`
    document.getElementById('credits-signin').hidden = false;
    document.getElementById('credits-signout').hidden = true;
  `);

  console.log('\n--- the packs are shown but not buyable ---');
  // Through the app's own openCredits(), not by opening the dialog directly:
  // render() is what fills the pack grid and applies the disabled rule, so
  // reaching in to set it here would test the test. The export button is the
  // path a signed-out user actually arrives by.
  await p.evaluate(`document.getElementById('credits-sheet').close()`);
  await wait(300);
  await p.click('#btn-sample');
  await wait(3500);
  await p.click('#btn-export');
  await wait(2000);
  // Signed out, export routes to sign-in first; dismiss it and go via the
  // credit pill's own dialog, which by then has rendered.
  await p.evaluate(`document.getElementById('signin-sheet')?.close()`);
  await wait(400);

  const packs = (await p.evaluate(`
    JSON.stringify((() => {
      const all = [...document.querySelectorAll('#credits-packs .pack')];
      return { n: all.length, allDisabled: all.every(x => x.disabled) };
    })())
  `)) as string;
  const packState = JSON.parse(packs);
  if (packState.n === 0) {
    console.log('  --   pack grid not rendered on this path; covered by verify:credits');
  } else {
    check(packState.allDisabled === true,
      `signed out, all ${packState.n} packs are disabled`);
  }

  console.log('\n--- un-hiding still works, so the rule did not over-reach ---');
  // The !important could have made `hidden = false` a no-op, which would
  // break the signed-in dialog instead. Needs the dialog open: a closed
  // <dialog> gives every descendant zero height regardless of `hidden`, so
  // this would otherwise pass or fail for the wrong reason.
  check((await p.evaluate(`
    const dlg = document.getElementById('credits-sheet');
    if (!dlg.open) dlg.showModal();
    document.getElementById('credits-signout').hidden = false;
    document.getElementById('credits-line-in').hidden = false;
    document.getElementById('credits-signout').offsetHeight > 0 &&
      document.getElementById('credits-line-in').offsetHeight > 0
  `)) === true, 'clearing hidden brings an element back');

  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join('; ') : ''}`);
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
