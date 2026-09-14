// Link previews and favicons.
//
// These are invisible in normal use and silently absent when wrong — nobody
// notices a missing og:image until a link has already been pasted somewhere
// public. The checks worth having are the ones a scraper actually performs:
// tags present in the SERVED html (not injected later by script, which no
// crawler runs), absolute image URLs (a crawler has no page context to
// resolve a relative path against), and an image that really is fetchable
// without a session.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`);
  if (!ok) fails++;
};

(async () => {
  // Fetched, not rendered: this is what a crawler sees. A tag added by the
  // bundle after load would pass a DOM check and fail in WhatsApp.
  const html = await fetch(`${BASE}/`).then((r) => r.text());
  const meta = (prop: string): string | null => {
    const m = new RegExp(
      `<meta\\s+(?:property|name)="${prop}"\\s+content="([^"]*)"`,
      'i'
    ).exec(html);
    return m ? m[1] : null;
  };

  console.log('--- the tags a scraper reads are in the served html ---');
  for (const tag of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) {
    check(!!meta(tag), `${tag} is present`);
  }
  check(!!meta('twitter:card'), 'twitter:card is present');
  check(meta('twitter:card') === 'summary_large_image',
    'and asks for the large card, not a thumbnail');
  check(!!meta('description'), 'a plain description is present for search results');

  console.log('\n--- the image is reachable the way a crawler reaches it ---');
  const img = meta('og:image');
  check(!!img && /^https?:\/\//.test(img),
    `og:image is an absolute URL (${img ?? 'missing'})`);
  check(!!meta('og:image:width') && !!meta('og:image:height'),
    'its dimensions are declared, so the card does not reflow');

  // Fetch the local copy rather than the production URL: this must pass
  // before a deploy, not only after one.
  const local = `${BASE}/brand/og.png`;
  const res = await fetch(local);
  check(res.status === 200, `the image serves (${res.status})`);
  check((res.headers.get('content-type') ?? '').includes('image/'),
    `and is an image (${res.headers.get('content-type')})`);
  const bytes = Number(res.headers.get('content-length') ?? 0);
  // WhatsApp and several others refuse images over ~5MB, and an empty file
  // would pass a status check while showing nothing.
  check(bytes > 2000 && bytes < 5_000_000, `of a sane size (${bytes} bytes)`);
  check(!res.headers.get('cross-origin-embedder-policy'),
    'and carries no isolation headers, which would block the fetch');

  console.log('\n--- favicons exist at the sizes that matter ---');
  for (const [path, what] of [
    ['/brand/icon-32.png', 'browser tab'],
    ['/brand/icon-180.png', 'iOS home screen'],
    ['/brand/site.webmanifest', 'Android install'],
  ]) {
    const r = await fetch(`${BASE}${path}`);
    check(r.status === 200, `${path} serves — ${what}`);
  }
  check(html.includes('apple-touch-icon'), 'the touch icon is linked');
  check(html.includes('theme-color'), 'a theme colour is set for mobile chrome');

  console.log('\n--- and the card renders at the right shape ---');
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox'],
  });
  const p = await b.newPage();
  await p.goto(local, { waitUntil: 'networkidle2' });
  const dims = (await p.evaluate(`JSON.stringify({
    w: document.querySelector('img')?.naturalWidth,
    h: document.querySelector('img')?.naturalHeight,
  })`)) as string;
  const { w, h } = JSON.parse(dims);
  check(w === 1200 && h === 630, `1200x630, the size OG consumers crop to (got ${w}x${h})`);
  await b.close();

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
