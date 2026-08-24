// The sign-in popup must never turn into a second copy of the studio.
//
// Regression test for the reported bug: the popup landed on /signin-done,
// window.close() was refused, and the fallback navigated it to '/' — so the
// whole app rendered inside the popup while the original window sat behind it
// untouched.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.APP_URL ?? 'http://localhost:3000';

let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 120_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  await p.goto(`${BASE}/signin-done`, { waitUntil: 'networkidle2' });

  console.log('--- /signin-done never renders the studio ---');
  const html = await p.content();
  // The tell from the screenshot: the cutter's own controls appearing in the
  // popup. If any of these are present, the popup has become the app.
  check(!html.includes('id="btn-svg"'), 'no download buttons');
  check(!html.includes('CUT STYLE') && !html.includes('cut-style'), 'no cut-style panel');
  check(!html.includes('id="stage"'), 'no canvas stage');
  check(/signed in/i.test(html), 'it says the sign-in finished');

  // Opened directly (no opener), it must stay put rather than redirect to '/'.
  await wait(2000);
  check(new URL(p.url()).pathname === '/signin-done',
    'opened directly it stays on /signin-done instead of loading the app');
  const hint = String(await p.evaluate(`(document.getElementById('hint')||{}).textContent || ''`));
  console.log(`  hint after close was refused: "${hint.trim()}"`);
  check(/close this window/i.test(hint),
    'and tells the user to close it, rather than cloning the studio');

  console.log('\n--- it notifies its opener ---');
  // window.open needs a user gesture, so the probe is driven by a real click
  // rather than called from an evaluate, which browsers block as a popup.
  const opener = await b.newPage();
  await opener.goto(BASE, { waitUntil: 'networkidle2' });
  await opener.evaluate(`(() => {
    window.__signedIn = false;
    window.addEventListener('message', (ev) => {
      if (ev.origin === window.location.origin && ev.data && ev.data.type === 'cutline:signed-in') {
        window.__signedIn = true;
      }
    });
    const btn = document.createElement('button');
    btn.id = 'probe-open';
    btn.style.position = 'fixed';
    btn.style.top = '0';
    btn.style.left = '0';
    btn.style.zIndex = '9999';
    btn.textContent = 'probe';
    btn.addEventListener('click', () => window.open('/signin-done', 'probe', 'width=400,height=400'));
    document.body.appendChild(btn);
  })()`);
  await opener.click('#probe-open');
  await opener.waitForFunction('window.__signedIn === true', { timeout: 12000 }).catch(() => {});
  check(await opener.evaluate(`window.__signedIn === true`) === true,
    'the popup posts cutline:signed-in to the window that opened it');

  await b.close();
  console.log(fails === 0 ? '\nall popup checks passed' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
