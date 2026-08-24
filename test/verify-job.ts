// Is the export actually visible on the canvas while it runs?
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
  const u = await db.user.create({ data: { email: `job-${randomUUID()}@example.com` } });
  await db.creditEntry.create({ data: { userId: u.id, amount: 20, reason: 'SIGNUP_GRANT' } });
  const token = randomUUID();
  await db.session.create({
    data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) },
  });

  const b = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 180_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1500, height: 950 });
  await p.setCookie({ name: 'authjs.session-token', value: token, url: BASE });
  await p.goto(BASE, { waitUntil: 'networkidle2' });

  const input = await p.$('input[type=file]');
  await input!.uploadFile('test/fixtures/feelathome.png');
  await wait(4000);

  console.log('--- the banner is hidden until something happens ---');
  check(await p.evaluate(`document.getElementById('job').hidden`) === true,
    'no job banner at rest');

  console.log('\n--- it appears while the export runs ---');
  // Confirm the spend, then watch the banner during the request.
  await p.click('#btn-pdf');
  await wait(500);
  await p.evaluate(`document.getElementById('confirm-go').click()`);

  // Poll for the banner rather than guessing at the timing.
  let seen = false;
  let sawText = '';
  for (let i = 0; i < 60 && !seen; i++) {
    const st = (await p.evaluate(`(() => {
      const j = document.getElementById('job');
      return { hidden: j.hidden, text: (j.querySelector('.job-text')||{}).textContent || '' };
    })()`)) as { hidden: boolean; text: string };
    if (!st.hidden) { seen = true; sawText = st.text; break; }
    await wait(60);
  }
  console.log(`  banner text while working: "${sawText}"`);
  check(seen, 'the job banner shows during the export');
  check(/generating|sending|download/i.test(sawText), 'and names what it is doing');

  await p.screenshot({ path: 'job-shot.png' });

  console.log('\n--- it resolves when the file arrives ---');
  let done = '';
  for (let i = 0; i < 120; i++) {
    const st = (await p.evaluate(`(() => {
      const j = document.getElementById('job');
      return { done: j.classList.contains('is-done'), text: (j.querySelector('.job-text')||{}).textContent || '' };
    })()`)) as { done: boolean; text: string };
    if (st.done) { done = st.text; break; }
    await wait(100);
  }
  console.log(`  banner text when finished: "${done}"`);
  check(/ready/i.test(done), 'it reports the file is ready');
  const spinning = await p.evaluate(
    `getComputedStyle(document.querySelector('.job-spinner')).animationName`
  );
  check(spinning === 'none', 'and the spinner stops rather than lying about ongoing work');

  console.log('\n--- and clears itself ---');
  await wait(2600);
  check(await p.evaluate(`document.getElementById('job').hidden`) === true,
    'the banner hides again');

  await b.close();
  await db.creditEntry.deleteMany({ where: { userId: u.id } });
  await db.download.deleteMany({ where: { userId: u.id } });
  await db.exportToken.deleteMany({ where: { userId: u.id } });
  await db.session.deleteMany({ where: { userId: u.id } });
  await db.user.delete({ where: { id: u.id } }).catch(() => {});
  await db.$disconnect();

  console.log(fails === 0 ? '\nall job-status checks passed' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
