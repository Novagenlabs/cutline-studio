// Can you get from the studio to the account and back, signed out and in?
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
  await p.setViewport({ width: 1280, height: 900 });

  console.log('--- signed out ---');
  await p.goto(`${BASE}/account`, { waitUntil: 'networkidle2' });
  const outLinks = Number(await p.evaluate(
    `document.querySelectorAll('main a[href="/"]').length`
  ));
  console.log(`  links home: ${outLinks}`);
  check(outLinks >= 1, 'the signed-out account page links back to the studio');

  // Follow it and confirm we land on the cutter, not a 404.
  await p.evaluate(`document.querySelector('main a[href="/"]').click()`);
  await wait(2500);
  check(new URL(p.url()).pathname === '/', 'the link navigates to the studio');
  check(await p.evaluate(`!!document.querySelector('#btn-svg')`) === true,
    'and the cutter is actually there');

  console.log('\n--- signed in ---');
  const u = await db.user.create({ data: { email: `nav-${randomUUID()}@example.com` } });
  await db.creditEntry.create({ data: { userId: u.id, amount: 20, reason: 'SIGNUP_GRANT' } });
  const token = randomUUID();
  await db.session.create({
    data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) },
  });
  await p.setCookie({ name: 'authjs.session-token', value: token, url: BASE });

  await p.goto(`${BASE}/account`, { waitUntil: 'networkidle2' });
  const inLinks = Number(await p.evaluate(
    `document.querySelectorAll('main a[href="/"]').length`
  ));
  console.log(`  links home: ${inLinks}`);
  check(inLinks >= 2, 'the signed-in page offers more than one way back');
  check(String(await p.evaluate(`document.body.textContent`)).includes('20'),
    'and shows the 20-credit balance');

  // The round trip a buyer actually makes: studio -> account -> studio.
  await p.goto(BASE, { waitUntil: 'networkidle2' });
  // The pill is populated by an async /api/me call after load, so wait for the
  // value rather than a fixed delay.
  await p.waitForFunction(
    "(document.querySelector('#st-credits')||{}).textContent.trim().charAt(0) !== '\u2014'",
    { timeout: 15000 }
  ).catch(() => {});
  check(String(await p.evaluate(`document.querySelector('#st-credits').textContent`)).includes('20'),
    'the studio pill shows the balance');
  await p.evaluate(`document.querySelector('#st-credits').removeAttribute('target')`);
  await p.evaluate(`document.querySelector('#st-credits').click()`);
  await wait(2500);
  check(new URL(p.url()).pathname === '/account', 'the pill opens the account page');
  await p.evaluate(`document.querySelector('main a[href="/"]').click()`);
  await wait(2500);
  check(new URL(p.url()).pathname === '/', 'and the back link returns to the studio');

  await db.creditEntry.deleteMany({ where: { userId: u.id } });
  await db.session.deleteMany({ where: { userId: u.id } });
  await db.user.delete({ where: { id: u.id } }).catch(() => {});
  await db.$disconnect();
  await b.close();

  console.log(fails === 0 ? '\nall navigation checks passed' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
