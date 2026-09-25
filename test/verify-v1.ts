// The previous studio, served at /v1.
//
// Users reported the new version tracing worse than the one before the UI
// overhaul, so that version is served frozen at /v1 while the new one is
// fixed. This checks the things that would make /v1 useless without anyone
// noticing until a user did:
//
//   - it is actually served, with its assets at /v1/ (the build relocates
//     them from /cutline/; a missed path means a blank page),
//   - it gets the same isolation headers as the root, so its popup sign-in
//     behaves the same way,
//   - it still traces (the fixture yields a cut path),
//   - and its paid export still speaks today's server's schema, including
//     the sanitised download name the old code did not have — the one change
//     in scripts/v1/compat.patch that a user would hit.
//
// The export body is captured by answering /api/me and /api/export inside the
// page, so no real sign-in or credit is involved.
import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { z } from 'zod';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.APP_URL ?? 'http://localhost:3000';
const FIXTURE = 'test/fixtures/feelathome.png';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`);
  if (!ok) fails++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The server's export schema, as src/app/api/export/route.ts defines it.
const Pt = z.object({ x: z.number().finite(), y: z.number().finite() });
const ExportBody = z.object({
  format: z.enum(['SVG', 'PDF', 'DXF', 'PNG']),
  rings: z.array(z.array(Pt).min(3)).min(1).max(20_000),
  beziers: z.array(z.array(z.tuple([Pt, Pt, Pt, Pt]))).min(1).max(20_000),
  svgPath: z.string().min(1).max(20_000_000),
  cutBbox: z.object({
    x: z.number().finite(), y: z.number().finite(),
    w: z.number().positive(), h: z.number().positive(),
  }),
  srcW: z.number().int().positive().max(30_000),
  srcH: z.number().int().positive().max(30_000),
  dpi: z.number().int().min(72).max(2400),
  spotName: z.string().min(1).max(64).regex(/^[\w -]+$/),
  halo: z.boolean(),
  filenameBase: z.string().min(1).max(120).regex(/^[\w. -]+$/),
  filenameDisplay: z.string().min(1).max(200).optional(),
  imageDataUrl: z.string().startsWith('data:image/').max(48_000_000).optional(),
});

(async () => {
  console.log('--- served at /v1, with its assets relocated ---');
  const page = await fetch(`${BASE}/v1`);
  const html = await page.text();
  check(page.status === 200, `/v1 answers 200 (got ${page.status})`);
  check(html.includes('/v1/app.js'), 'the page loads its script from /v1/');
  check(html.includes('/v1/app.css'), 'and its stylesheet from /v1/');
  check(!html.includes('/cutline/'), 'nothing still points at /cutline/');
  check(html.includes('id="btn-current-version"'), 'it links back to the current studio');
  check(/<title>v1 · /.test(html), 'the tab is labelled as v1');

  for (const asset of ['/v1/app.js', '/v1/app.css']) {
    const r = await fetch(`${BASE}${asset}`);
    check(r.status === 200, `${asset} answers 200 (got ${r.status})`);
  }

  console.log('\n--- with the same isolation as the root ---');
  for (const path of ['/v1', '/v1/app.js']) {
    const r = await fetch(`${BASE}${path}`);
    const coop = r.headers.get('cross-origin-opener-policy');
    const coep = r.headers.get('cross-origin-embedder-policy');
    check(coop === 'same-origin', `${path}: COOP same-origin (got ${coop})`);
    check(coep === 'credentialless', `${path}: COEP credentialless (got ${coep})`);
  }

  console.log('\n--- and the current studio points at it ---');
  const root = await (await fetch(`${BASE}/`)).text();
  check(root.includes('href="/v1"'), 'the current top bar links to /v1');
  check(root.includes('btn-bg-refine'), 'and is still the current studio, not v1');

  console.log('\n--- it traces, and exports in a form the server accepts ---');
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1500, height: 940 });

  // Pretend to be signed in with credits, and catch the export request. Both
  // answered in the page rather than by the real server, so this needs no
  // account and spends nothing.
  let exportBody: string | null = null;
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/me')) {
      void req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ balance: 5, signupGrant: 3 }),
      });
      return;
    }
    if (url.includes('/api/export') && req.method() === 'POST') {
      exportBody = req.postData() ?? '';
      void req.respond({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'captured by verify:v1' }),
      });
      return;
    }
    void req.continue();
  });

  await p.goto(`${BASE}/v1`, { waitUntil: 'networkidle2' });
  await wait(2500);

  // Both cross-links are <a> elements dressed as buttons, and a browser
  // underlines an <a> unless told not to. v1's stylesheet is frozen, so its
  // link carries an inline style; the current one has an a.btn rule. Checked
  // as computed style, because the first screenshots showed both underlined.
  const underline = async (sel: string) =>
    String(
      await p.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)});
          return el ? getComputedStyle(el).textDecorationLine : 'missing'; })()`,
      ),
    );
  check(
    (await underline('#btn-current-version')) === 'none',
    `v1's link back is not underlined (got "${await underline('#btn-current-version')}")`,
  );

  // Upload the fixture under a name the OLD client would have sent through
  // unsanitised — parentheses are what broke real exports before.
  const named = join(tmpdir(), 'logo (1).png');
  copyFileSync(FIXTURE, named);
  check(existsSync(named), 'fixture staged as "logo (1).png"');
  // The attribute selector, not the id: puppeteer types it as an input
  // handle, which is what uploadFile requires.
  const input = await p.$('input[type=file]');
  await input!.uploadFile(named);
  await wait(5000);

  const cut = (await p.evaluate(`(() => {
    const el = document.getElementById('cut-path');
    const d = el ? el.getAttribute('d') || '' : '';
    return { len: d.length, rings: (d.match(/M/g) || []).length };
  })()`)) as { len: number; rings: number };
  check(cut.len > 0, `v1 traced the fixture (${cut.rings} rings, ${cut.len} chars)`);

  // Export: the button, then the confirm-before-spend dialog's Download.
  await p.evaluate(`(() => {
    const b = document.getElementById('btn-svg');
    if (b) { b.disabled = false; b.click(); }
  })()`);
  await wait(800);
  const dialogOpen = await p.evaluate(
    `!!document.getElementById('confirm-export')?.open`,
  );
  check(dialogOpen === true, 'the confirm-before-spend dialog opened');
  await p.evaluate(`document.getElementById('confirm-go')?.click()`);
  await wait(3000);

  check(exportBody !== null, 'an export request was sent');
  if (exportBody) {
    const parsed = ExportBody.safeParse(JSON.parse(exportBody));
    if (parsed.success) {
      check(true, "the body passes today's server schema");
      check(
        parsed.data.filenameBase === 'logo-1-cut',
        `the download name was sanitised (got "${parsed.data.filenameBase}")`,
      );
    } else {
      const first = parsed.error.issues[0];
      check(false, `the body fails the schema at ${first.path.join('.')}: ${first.message}`);
    }
  }

  console.log('\n--- and the link from the current studio reads as a button ---');
  // Interception stays on: the request handler above is still registered and
  // calls continue(), which throws once interception is disabled. It passes
  // everything through except the two stubbed API calls, which is fine here.
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await wait(6500);
  await p.evaluate(`document.querySelector('.tour-skip')?.click()`);
  await wait(400);
  check(
    (await underline('#btn-v1')) === 'none',
    `"Previous version" is not underlined (got "${await underline('#btn-v1')}")`,
  );

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
