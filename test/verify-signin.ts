// Signed out, a download must offer sign-in ON THIS PAGE, and the job banner
// must only be visible while work is actually happening.
import puppeteer from 'puppeteer-core';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.APP_URL ?? 'http://localhost:3000';
const db = new PrismaClient();

let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 180_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1500, height: 950 });
  await p.goto(BASE, { waitUntil: 'networkidle2' });

  const input = await p.$('input[type=file]');
  await input!.uploadFile('test/fixtures/hello-large.png');
  await wait(3500);

  console.log('--- signed out, download asks to sign in without leaving ---');
  const before = p.url();
  await p.click('#btn-svg');
  await wait(900);

  check(await p.evaluate(`document.getElementById('signin-sheet').open`) === true,
    'the sign-in modal opens');
  check(await p.evaluate(`document.getElementById('confirm-export').open`) === false,
    'and the spend dialog does not, because there is nothing to spend yet');
  check(p.url() === before, 'the page did not navigate away');
  check(await p.evaluate(`document.querySelector('#stage svg') !== null`) === true,
    'the artwork is still loaded');

  const grant = String(await p.evaluate(`document.getElementById('signin-grant').textContent`));
  console.log(`  modal advertises ${grant} free credits`);
  check(grant === '20', 'it states the real signup grant, read from the server');

  console.log('\n--- the job banner does not show for a click that did no work ---');
  check(await p.evaluate(`document.getElementById('job').hidden`) === true,
    'no processing banner while the sign-in modal is up');

  console.log('\n--- dismissing leaves everything as it was ---');
  await p.evaluate(`document.getElementById('signin-cancel').click()`);
  await wait(500);
  check(await p.evaluate(`document.getElementById('signin-sheet').open`) === false,
    'the modal closes');
  check(await p.evaluate(`document.getElementById('job').hidden`) === true,
    'and still no job banner');
  check(p.url() === before, 'and still on the same page');

  console.log('\n--- signed in, the banner shows only while working ---');
  const u = await db.user.create({ data: { email: `sig-${randomUUID()}@example.com` } });
  await db.creditEntry.create({ data: { userId: u.id, amount: 20, reason: 'SIGNUP_GRANT' } });
  const token = randomUUID();
  await db.session.create({
    data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) },
  });
  await p.setCookie({ name: 'authjs.session-token', value: token, url: BASE });
  await p.goto(BASE, { waitUntil: 'networkidle2' });
  const input2 = await p.$('input[type=file]');
  await input2!.uploadFile('test/fixtures/hello-large.png');
  await wait(3500);

  await p.click('#btn-svg');
  // The gate re-checks the balance with the server before deciding, so the
  // dialog opens after a round trip rather than synchronously.
  await p.waitForFunction(
    "document.getElementById('confirm-export').open === true",
    { timeout: 15000 }
  ).catch(() => {});
  check(await p.evaluate(`document.getElementById('signin-sheet').open`) === false,
    'signed in, no sign-in modal');
  check(await p.evaluate(`document.getElementById('confirm-export').open`) === true,
    'the spend confirmation opens instead');
  await p.evaluate(`document.getElementById('confirm-go').click()`);

  let sawWorking = false;
  for (let i = 0; i < 60 && !sawWorking; i++) {
    if (await p.evaluate(`!document.getElementById('job').hidden`)) sawWorking = true;
    else await wait(60);
  }
  check(sawWorking, 'the banner appears while the export runs');

  // And is gone once the work finishes — not lingering with an outcome.
  let hidden = false;
  for (let i = 0; i < 150; i++) {
    if (await p.evaluate(`document.getElementById('job').hidden`)) { hidden = true; break; }
    await wait(100);
  }
  check(hidden, 'and disappears as soon as the work is done');
  const toasts = Number(await p.evaluate(`document.querySelectorAll('#toasts .toast').length`));
  check(toasts >= 1, 'the outcome is reported by a toast, not the banner');

  await b.close();
  await db.creditEntry.deleteMany({ where: { userId: u.id } });
  await db.download.deleteMany({ where: { userId: u.id } });
  await db.exportToken.deleteMany({ where: { userId: u.id } });
  await db.session.deleteMany({ where: { userId: u.id } });
  await db.user.delete({ where: { id: u.id } }).catch(() => {});
  await db.$disconnect();

  console.log(fails === 0 ? '\nall sign-in / job checks passed' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
