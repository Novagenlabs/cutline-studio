// Deterministic browser test for the AI matting path.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.TEST_URL ?? 'http://localhost:5199/';
const IMG = '/Users/novagenlabs/Downloads/FeelAtHome-Logo.png';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir: '/Users/novagenlabs/.claude/jobs/f686376c/tmp/chrome-profile',
  args: ['--no-first-run', '--window-size=1400,900'],
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (!/vite|HMR|DevTools/i.test(t)) console.log(`[${m.type()}] ${t.slice(0, 400)}`);
});
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: 'networkidle2' });
const input = await page.$('#file-input');
await input.uploadFile(IMG);
await new Promise((r) => setTimeout(r, 2500));
await page.click('#in-ai');
console.log('AI enabled, waiting…');

const t0 = Date.now();
let last = '';
while (Date.now() - t0 < 12 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 3000));
  const hint = await page.$eval('#hint-ai', (el) => el.textContent).catch(() => '(page busy)');
  if (hint !== last) {
    console.log(`[hint +${((Date.now() - t0) / 1000).toFixed(0)}s]`, hint);
    last = hint;
  }
  if (/active|failed/.test(hint)) break;
}
const geom = await page.$eval('#st-geom', (el) => el.textContent).catch(() => '?');
const mask = await page.$eval('#hint-mask', (el) => el.textContent).catch(() => '?');
console.log('RESULT geom:', geom);
console.log('RESULT mask-hint:', mask);
await page.screenshot({ path: '/Users/novagenlabs/.claude/jobs/f686376c/tmp/ai-result.png' });
await browser.close();
