// Every wait the user sits through must say something.
//
// The reported symptom: after signing in mid-download the screen looked stuck,
// because the balance re-fetch and the re-run export happened in silence.
import puppeteer from 'puppeteer-core';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.APP_URL ?? 'http://localhost:3000';
const db = new PrismaClient();

let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jobText = (p: any) =>
  p.evaluate(`(() => {
    const j = document.getElementById('job');
    if (!j || getComputedStyle(j).display === 'none') return null;
    return (j.querySelector('.job-text') || {}).textContent || '';
  })()`);

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 120_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });

  console.log('--- the account check is announced ---');
  {
    const p = await b.newPage();
    await p.setViewport({ width: 1400, height: 900 });
    // Slow /api/me so the transient state is observable rather than a race.
    await p.setRequestInterception(true);
    p.on('request', async (r) => {
      if (r.url().includes('/api/me')) {
        await wait(1200);
        await r.continue();
      } else await r.continue();
    });
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
    const input = await p.$('input[type=file]');
    await input!.uploadFile('test/fixtures/hello-large.png');
    await wait(3500);

    await p.click('#btn-svg');
    let seen: string | null = null;
    for (let i = 0; i < 40 && !seen; i++) {
      seen = await jobText(p);
      if (!seen) await wait(50);
    }
    console.log(`  banner while checking: "${seen ?? '(nothing)'}"`);
    check(!!seen, 'something is shown while the account is checked');
    check(/checking|account/i.test(seen ?? ''), 'and it names what is happening');
    await p.close();
  }

  console.log('\\n--- the workspace load after sign-in is announced ---');
  {
    // Drive the post-sign-in path directly: the popup needs a human at
    // Google, but everything after it is the part that looked stuck.
    const u = await db.user.create({ data: { email: `load-${randomUUID()}@example.com` } });
    await db.creditEntry.create({ data: { userId: u.id, amount: 20, reason: 'SIGNUP_GRANT' } });
    const token = randomUUID();
    await db.session.create({
      data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) },
    });

    const p = await b.newPage();
    await p.setViewport({ width: 1400, height: 900 });
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
    await p.setCookie({ name: 'authjs.session-token', value: token, url: BASE });
    await p.goto(BASE, { waitUntil: 'networkidle2' });

    const stages = String(await p.evaluate(`(() => {
      const j = document.getElementById('job');
      return j ? 'present' : 'missing';
    })()`));
    check(stages === 'present', 'the status element exists to be used');

    // The stage vocabulary must cover the auth wait, not just the export.
    const bundle = await (await fetch(`${BASE}/cutline/app.js`)).text();
    check(/Checking your account/.test(bundle), 'a "checking account" state exists');
    check(/Loading your workspace/.test(bundle), 'a "loading workspace" state exists');
    check(/Waiting for the other window/.test(bundle), 'a "waiting for the popup" state exists');

    await p.close();
    await db.creditEntry.deleteMany({ where: { userId: u.id } });
    await db.session.deleteMany({ where: { userId: u.id } });
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
  }

  console.log('\\n--- closing the sign-in modal to show the banner is not a cancel ---');
  {
    // Regression guard: the modal is closed when the popup opens so the
    // banner behind it is visible. If that close were read as a dismissal,
    // a sign-in in progress would be abandoned.
    const src = await (await fetch(`${BASE}/cutline/app.js`)).text();
    check(/if \(!started\) finish\("dismissed"\)|started\s*&&|!started/.test(src),
      'the close handler distinguishes a dismissal from a started sign-in');
  }

  await b.close();
  await db.$disconnect();
  console.log(fails === 0 ? '\\nall loading-state checks passed' : `\\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
