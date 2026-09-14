// Sign-in completing when the popup cannot report back.
//
// The popup navigates to Google and back. That cross-origin round trip is
// enough for Safari to sever window.opener, so /signin-done has nobody to
// postMessage — and `popup.closed` is no help either, because it reads false
// indefinitely for a popup the opener no longer owns. With only those two
// exits the studio waited forever and kept showing "Sign in to download"
// until the user reloaded by hand.
//
// Chrome will not reproduce that on its own, so this simulates it: the
// message is swallowed and `closed` is pinned to false, leaving the server
// poll as the only way out. If the studio still notices the session, the
// Safari path works.
import puppeteer from 'puppeteer-core';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const SECURE = BASE.startsWith('https://');
const COOKIE = SECURE ? '__Secure-authjs.session-token' : 'authjs.session-token';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`);
  if (!ok) fails++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = new PrismaClient();

(async () => {
  const u = await db.user.create({ data: { email: `safari-${randomUUID()}@example.invalid` } });
  const token = randomUUID();
  await db.session.create({
    data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 900_000) },
  });

  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1400, height: 900 });

  // Break both of the mechanisms Safari breaks, before any app code runs.
  await p.evaluateOnNewDocument(`
    // A popup whose opener has been severed: never reports closed, and its
    // postMessage goes nowhere.
    const realOpen = window.open;
    window.open = function (...args) {
      const w = realOpen.apply(this, args);
      if (w) {
        try {
          Object.defineProperty(w, 'closed', { get: () => false, configurable: true });
        } catch (e) {}
      }
      return w;
    };
    // Swallow the handshake, as a severed opener would.
    const realAdd = window.addEventListener.bind(window);
    window.addEventListener = function (type, fn, opts) {
      if (type === 'message') return;
      return realAdd(type, fn, opts);
    };
  `);

  await p.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(6500);
  await p.evaluate(`document.querySelector('.tour-skip')?.click()`);
  await wait(400);

  console.log('--- signed out to begin with ---');
  check((await p.evaluate(`
    document.querySelector('#st-credits .credit-count')?.textContent
  `)) === 'Sign in', 'the pill offers sign-in');

  console.log('\n--- a session appears while the popup cannot report back ---');
  // The popup never opens in headless Chrome the way it would for a real
  // user, so this grants the session directly — which is precisely the state
  // Safari reaches after consent, with no way to tell the opener about it.
  await p.setCookie({ name: COOKIE, value: token, url: BASE, secure: SECURE });

  // Open the sign-in sheet and press the button, then wait out the poll.
  await p.evaluate(`document.getElementById('st-credits').click()`);
  await wait(1200);
  const sheetOpen = await p.evaluate(`document.getElementById('signin-sheet')?.open === true`);
  check(sheetOpen === true, 'the sign-in sheet opened');

  if (sheetOpen) {
    await p.evaluate(`document.getElementById('signin-go')?.click()`);

    // Waited for rather than slept past: the poll runs every 1200ms and the
    // balance fetch that follows takes a cold Neon connection, so a fixed
    // sleep is a coin toss. The first version of this test used one and
    // failed once for that reason alone.
    const updated = await p
      .waitForFunction(
        `document.querySelector('#st-credits .credit-count')?.textContent !== 'Sign in'`,
        { timeout: 25_000, polling: 300 }
      )
      .then(() => true)
      .catch(() => false);

    check((await p.evaluate(`document.getElementById('signin-sheet')?.open === true`)) === false,
      'the sheet closed once the server confirmed the session');
    const count = String(await p.evaluate(`
      document.querySelector('#st-credits .credit-count')?.textContent
    `));
    check(updated, `the pill updated without a reload (now "${count}")`);
  }

  await b.close();
  await db.session.deleteMany({ where: { userId: u.id } });
  await db.creditEntry.deleteMany({ where: { userId: u.id } });
  await db.user.delete({ where: { id: u.id } }).catch(() => {});
  await db.$disconnect();

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
