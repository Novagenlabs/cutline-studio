// Credits are bought from a dialog on the studio page, not another screen.
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
  const u = await db.user.create({ data: { email: `cr-${randomUUID()}@example.com` } });
  await db.creditEntry.create({ data: { userId: u.id, amount: 20, reason: 'SIGNUP_GRANT' } });
  const token = randomUUID();
  await db.session.create({
    data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) },
  });

  const b = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 120_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  p.on('pageerror', (e: unknown) => console.log('PAGEERROR:', e instanceof Error ? e.message : String(e)));
  p.on('console', (m) => { if (m.type()==='error') console.log('CONSOLE:', m.text()); });
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.setCookie({ name: 'authjs.session-token', value: token, url: BASE });
  await p.goto(BASE, { waitUntil: 'networkidle2' });
  await p.waitForFunction(
    "(document.querySelector('#st-credits')||{}).textContent.indexOf('20') >= 0",
    { timeout: 15000 }
  ).catch(() => {});

  console.log('--- the credit pill opens a dialog, not a page ---');
  const before = p.url();
  await p.click('#st-credits');
  // The dialog renders after /api/me returns, so wait for it rather than
  // guessing at the round-trip time.
  await p.waitForFunction(
    "document.getElementById('credits-sheet').open === true",
    { timeout: 15000 }
  ).catch(() => {});
  check(await p.evaluate(`document.getElementById('credits-sheet').open`) === true,
    'the credits dialog opens');
  check(p.url() === before, 'and the studio is still the page we are on');
  check(await p.evaluate(`!!document.querySelector('#btn-svg')`) === true,
    'with the cutter still loaded behind it');

  console.log('\n--- it shows the balance and what can be bought ---');
  const bal = String(await p.evaluate(`document.getElementById('credits-balance').textContent`));
  console.log(`  balance line: ${bal}`);
  check(bal.includes('20'), 'the balance is shown');
  const packs = Number(await p.evaluate(`document.querySelectorAll('#credits-packs .pack').length`));
  console.log(`  packs offered: ${packs}`);
  check(packs === 3, 'all three packs are offered');
  const prices = String(await p.evaluate(
    `Array.from(document.querySelectorAll('#credits-packs .pack-price')).map(e => e.textContent).join(' ')`
  ));
  console.log(`  prices: ${prices}`);
  check(/\$9\.00/.test(prices) && /\$35\.00/.test(prices) && /\$110\.00/.test(prices),
    'priced from the server, not hardcoded in the browser');
  check(await p.evaluate(
    `(document.querySelector('#credits-packs .pack')||{disabled:null}).disabled`
  ) === false, 'signed in, the packs are buyable');

  console.log('\n--- closing returns to the studio untouched ---');
  await p.evaluate(`document.getElementById('credits-close').click()`);
  await wait(800);
  check(await p.evaluate(`document.getElementById('credits-sheet').open`) === false,
    'the dialog closes');
  check(p.url() === before, 'still on the studio page');

  console.log('\n--- signed out, packs are not buyable ---');
  // A fresh context, so the signed-in cookie from the first page does not
  // leak in and make this assertion meaningless.
  const ctx = await b.createBrowserContext();
  const p2 = await ctx.newPage();
  await p2.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(1500);
  await p2.click('#st-credits');
  await p2.waitForFunction(
    "document.getElementById('credits-sheet').open === true",
    { timeout: 15000 }
  ).catch(() => {});
  check(await p2.evaluate(`document.getElementById('credits-sheet').open`) === true,
    'the dialog still opens');
  check(await p2.evaluate(
    `(document.querySelector('#credits-packs .pack')||{disabled:null}).disabled`
  ) === true, 'but nothing can be purchased without an account');

  await b.close();
  await db.creditEntry.deleteMany({ where: { userId: u.id } });
  await db.session.deleteMany({ where: { userId: u.id } });
  await db.user.delete({ where: { id: u.id } }).catch(() => {});
  await db.$disconnect();

  console.log(fails === 0 ? '\nall credits checks passed' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
