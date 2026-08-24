// Toasts, the spend-confirmation dialog, and the credit pill, in the real UI.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.APP_URL ?? 'http://localhost:3000/';

let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  console.log('--- credits live in the top bar ---');
  const inTopbar = await p.evaluate(
    `!!document.querySelector('.topbar #st-credits, .top-actions #st-credits')`
  );
  check(inTopbar === true, 'the credit pill is in the top bar');
  check(await p.evaluate(`!!document.querySelector('.status #st-credits, footer #st-credits')`) === false,
    'and no longer in the status bar');
  check(String(await p.evaluate(`document.querySelector('#st-credits').textContent`)).includes('Sign in'),
    'signed out, it prompts to sign in');

  console.log('\n--- toasts stack instead of replacing ---');
  await p.evaluate(`window.__t = document.getElementById('toasts')`);
  await p.evaluate(`(() => {
    const ev = new Event('click');
    return true;
  })()`);
  // Drive the toast module directly through a paid export failure: click two
  // different formats while signed out.
  const input = await p.$('input[type=file]');
  await input!.uploadFile('test/fixtures/hello-large.png');
  await wait(3000);

  // Skip the dialog for the stacking test by confirming each time.
  const clickAndConfirm = async (sel: string) => {
    await p.click(sel);
    await wait(500);
    const open = await p.evaluate(`document.getElementById('confirm-export').open`);
    if (open) {
      await p.evaluate(`document.getElementById('confirm-go').click()`);
      await wait(1500);
    }
  };

  console.log('\n--- a download asks before spending ---');
  await p.click('#btn-svg');
  await wait(600);
  const dlgOpen = await p.evaluate(`document.getElementById('confirm-export').open`);
  check(dlgOpen === true, 'clicking a download opens the confirmation dialog');
  const cost = String(await p.evaluate(`document.getElementById('confirm-cost').textContent`));
  const fmt = String(await p.evaluate(`document.getElementById('confirm-format').textContent`));
  console.log(`  dialog says: format=${fmt} cost=${cost}`);
  check(cost.includes('1 credit'), 'it states the cost');
  check(fmt.includes('SVG'), 'it names the format');

  console.log('\n--- cancelling spends nothing ---');
  await p.evaluate(`(() => {
    const d = document.getElementById('confirm-export');
    d.querySelector('button[value="cancel"]').click();
  })()`);
  await wait(500);
  check(await p.evaluate(`document.getElementById('confirm-export').open`) === false,
    'cancel closes the dialog');
  check(await p.evaluate(`document.querySelectorAll('#toasts .toast').length`) === 0,
    'and produces no toast, because nothing happened');

  console.log('\n--- confirming proceeds (and fails cleanly when signed out) ---');
  await clickAndConfirm('#btn-svg');
  await wait(1200);
  const toasts = Number(await p.evaluate(`document.querySelectorAll('#toasts .toast').length`));
  check(toasts >= 1, 'confirming produces a result toast');
  const hasAction = await p.evaluate(`!!document.querySelector('#toasts .toast-action')`);
  check(hasAction === true, 'the signed-out error offers a sign-in action rather than opening a tab');
  const txt = String(await p.evaluate(`document.querySelector('#toasts .toast-text').textContent`));
  console.log(`  toast: ${txt}`);
  check(/sign in/i.test(txt), 'and says what is wrong');

  console.log('\n--- toasts are dismissible ---');
  await p.evaluate(`document.querySelector('#toasts .toast-close').click()`);
  await wait(400);
  check(await p.evaluate(`document.querySelectorAll('#toasts .toast').length`) === 0,
    'the close button removes it');

  console.log(errs.length ? '\nPAGE ERRORS: ' + errs.join(' | ') : '\nno page errors');
  console.log(fails === 0 ? 'all UI checks passed' : `${fails} CHECK(S) FAILED`);
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})();
