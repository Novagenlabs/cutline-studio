/**
 * The cutter front-end is a separate origin from the account server, so the
 * paid export has to survive CORS with credentials. This drives the exact
 * request the browser makes, Origin header and all.
 *
 * The security property under test is not "CORS is enabled" but "CORS is
 * enabled for OUR origin only" — echoing an arbitrary Origin back with
 * Allow-Credentials would let any site on the internet spend a signed-in
 * user's credits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const BASE = process.env.E2E_URL ?? 'http://localhost:3000';
const CLIENT_ORIGIN = 'http://localhost:5173';
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
  spotName: 'CutContour', halo: true, filenameBase: 'cors-test',
};

beforeAll(async () => {
  try { up = (await fetch(BASE, { signal: AbortSignal.timeout(5000) })).ok; } catch { up = false; }
  if (!up) return;
  const u = await db.user.create({ data: { email: `cors-${randomUUID()}@example.com` } });
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

describe.skipIf(!process.env.DATABASE_URL)('paid export across origins', () => {
  it('preflights from the cutter origin', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/api/export`, {
      method: 'OPTIONS',
      headers: { origin: CLIENT_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(CLIENT_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    // Without this the client cannot read the balance off a successful export.
    expect(res.headers.get('access-control-expose-headers')).toContain('x-credits-remaining');
  });

  it('does NOT hand a foreign origin the keys', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/api/export`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    // Whatever the status, the browser must not be told this origin is allowed.
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('delivers the file cross-origin and charges a credit', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: CLIENT_ORIGIN, cookie },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(CLIENT_ORIGIN);
    expect(res.headers.get('x-credits-remaining')).toBe('2');
    expect(await res.text()).toContain('<svg');
  });

  it('/api/me reports the balance the cutter shows', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/api/me`, {
      headers: { origin: CLIENT_ORIGIN, cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signedIn).toBe(true);
    expect(body.balance).toBe(2);
    expect(body.downloads).toBe(1);
  });

  it('/api/me is honest about being signed out', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/api/me`, { headers: { origin: CLIENT_ORIGIN } });
    expect(res.status).toBe(200);
    expect((await res.json()).signedIn).toBe(false);
  });
});
