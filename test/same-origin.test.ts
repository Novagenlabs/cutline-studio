/**
 * The cutter, the account page and the API are ONE app on ONE origin.
 *
 * This replaces an earlier cross-origin test. That test existed because the
 * cutter and the account server ran separately and needed CORS to talk —
 * which was the wrong shape for a single product, and the CORS middleware was
 * the symptom. With one app the browser sends no Origin header at all and no
 * cross-origin machinery is involved, so what needs asserting is that every
 * part is genuinely served from the same place and still enforces payment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const BASE = process.env.E2E_URL ?? 'http://localhost:3000';
const db = new PrismaClient();

let up = false;
let userId = '';
let cookie = '';

const BODY = {
  format: 'SVG',
  rings: [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }]],
  beziers: [[
    [{ x: 0, y: 0 }, { x: 33, y: 0 }, { x: 66, y: 0 }, { x: 100, y: 0 }],
    [{ x: 100, y: 0 }, { x: 100, y: 27 }, { x: 100, y: 53 }, { x: 100, y: 80 }],
    [{ x: 100, y: 80 }, { x: 66, y: 80 }, { x: 33, y: 80 }, { x: 0, y: 80 }],
    [{ x: 0, y: 80 }, { x: 0, y: 53 }, { x: 0, y: 27 }, { x: 0, y: 0 }],
  ]],
  svgPath: 'M 0 0 C 33 0 66 0 100 0 C 100 27 100 53 100 80 C 66 80 33 80 0 80 C 0 53 0 27 0 0 Z',
  cutBbox: { x: 0, y: 0, w: 100, h: 80 },
  srcW: 100, srcH: 80, dpi: 300,
  spotName: 'CutContour', halo: true, filenameBase: 'same-origin-test',
};

beforeAll(async () => {
  try { up = (await fetch(BASE, { signal: AbortSignal.timeout(8000) })).ok; } catch { up = false; }
  if (!up) return;
  const u = await db.user.create({ data: { email: `merge-${randomUUID()}@example.com` } });
  userId = u.id;
  await db.creditEntry.create({ data: { userId, amount: 3, reason: 'SIGNUP_GRANT' } });
  const token = randomUUID();
  await db.session.create({
    data: { sessionToken: token, userId, expires: new Date(Date.now() + 3600_000) },
  });
  cookie = `authjs.session-token=${token}`;
});

afterAll(async () => {
  if (userId) {
    await db.creditEntry.deleteMany({ where: { userId } });
    await db.download.deleteMany({ where: { userId } });
    await db.exportToken.deleteMany({ where: { userId } });
    await db.session.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } }).catch(() => {});
  }
  await db.$disconnect();
});

describe.skipIf(!process.env.DATABASE_URL)('one app, one origin', () => {
  it('serves the cutter at the root', async () => {
    if (!up) return;
    const res = await fetch(BASE);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('CUTLINE');
    // The shipped v3 engine is still the default in the served UI.
    expect(html).toContain('v3 — text accurate');
  });

  it('serves the account page from the same origin', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/account`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Cutline Studio');
  });

  it('isolates the cutter so AI matting can use threads', async () => {
    if (!up) return;
    const res = await fetch(BASE);
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
  });

  it('does NOT isolate the auth routes, which would break OAuth', async () => {
    if (!up) return;
    // COOP: same-origin severs a popup from its opener; sign-in must not be
    // served under it.
    const res = await fetch(`${BASE}/api/auth/providers`);
    expect(res.headers.get('cross-origin-opener-policy')).toBeNull();
  });

  it('still charges a credit for a download', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-credits-remaining')).toBe('2');
    expect(await res.text()).toContain('<svg');
  });

  it('still refuses an anonymous download', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(401);
  });

  it('reports the balance to the cutter', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/api/me`, { headers: { cookie } });
    const body = await res.json();
    expect(body.signedIn).toBe(true);
    expect(body.balance).toBe(2);
    expect(body.downloads).toBe(1);
  });
});
