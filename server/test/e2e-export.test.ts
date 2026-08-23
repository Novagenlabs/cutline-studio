/**
 * End-to-end through the RUNNING server: sign-in state is faked by inserting
 * a real Session row (the same thing Auth.js writes), then the export route
 * is driven over HTTP exactly as the browser would.
 *
 * This is the test that proves the paywall, rather than the pieces behind it:
 * a request with no session gets nothing, a request with credits gets a file
 * and is charged, and a request with an empty balance is refused.
 *
 * Requires the dev server on :3000 and DATABASE_URL. Skipped if either is
 * absent, so it never fails a run that simply is not set up for it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const BASE = process.env.E2E_URL ?? 'http://localhost:3000';
const db = new PrismaClient();

let up = false;
let userId = '';
let cookie = '';

const GEOMETRY = {
  rings: [[
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 150 }, { x: 0, y: 150 },
  ]],
  beziers: [[
    [{ x: 0, y: 0 }, { x: 66, y: 0 }, { x: 133, y: 0 }, { x: 200, y: 0 }],
    [{ x: 200, y: 0 }, { x: 200, y: 50 }, { x: 200, y: 100 }, { x: 200, y: 150 }],
    [{ x: 200, y: 150 }, { x: 133, y: 150 }, { x: 66, y: 150 }, { x: 0, y: 150 }],
    [{ x: 0, y: 150 }, { x: 0, y: 100 }, { x: 0, y: 50 }, { x: 0, y: 0 }],
  ]],
  svgPath: 'M 0 0 C 66 0 133 0 200 0 C 200 50 200 100 200 150 C 133 150 66 150 0 150 C 0 100 0 50 0 0 Z',
  cutBbox: { x: 0, y: 0, w: 200, h: 150 },
  srcW: 200, srcH: 150, dpi: 300,
  spotName: 'CutContour', halo: true,
};

const exportReq = (format: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ ...GEOMETRY, format, filenameBase: 'e2e-test' }),
});

beforeAll(async () => {
  try {
    const r = await fetch(BASE, { signal: AbortSignal.timeout(5000) });
    up = r.ok;
  } catch {
    up = false;
  }
  if (!up) return;

  const user = await db.user.create({ data: { email: `e2e-${randomUUID()}@example.com` } });
  userId = user.id;
  const token = randomUUID();
  await db.session.create({
    data: {
      sessionToken: token,
      userId,
      expires: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  // Auth.js reads this cookie name over plain http in development.
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

describe.skipIf(!process.env.DATABASE_URL)('paid export over HTTP', () => {
  it('refuses an unauthenticated download', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...GEOMETRY, format: 'SVG', filenameBase: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses a signed-in user with no credits', async () => {
    if (!up) return;
    const res = await fetch(`${BASE}/api/export`, exportReq('SVG'));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.balance).toBe(0);
  });

  it('delivers a file and charges exactly one credit', async () => {
    if (!up) return;
    await db.creditEntry.create({
      data: { userId, amount: 2, reason: 'SIGNUP_GRANT', note: 'e2e' },
    });

    const res = await fetch(`${BASE}/api/export`, exportReq('SVG'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg');
    expect(res.headers.get('content-disposition')).toContain('e2e-test.svg');
    expect(res.headers.get('x-credits-remaining')).toBe('1');

    const svg = await res.text();
    expect(svg).toContain('<svg');
    expect(svg).toContain('CutContour');
    // The provenance marker names the download that paid for it.
    const id = res.headers.get('x-download-id')!;
    expect(id).toBeTruthy();
    expect(svg).toContain(id);

    // The ledger and the download row agree with what was delivered.
    const agg = await db.creditEntry.aggregate({ where: { userId }, _sum: { amount: true } });
    expect(agg._sum.amount).toBe(1);
    const dl = await db.download.findUniqueOrThrow({ where: { id } });
    expect(dl.filename).toBe('e2e-test.svg');
    expect(dl.bytes).toBe(new TextEncoder().encode(svg).byteLength);
  });

  it('spends the last credit, then refuses', async () => {
    if (!up) return;
    const ok = await fetch(`${BASE}/api/export`, exportReq('DXF'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-credits-remaining')).toBe('0');

    const denied = await fetch(`${BASE}/api/export`, exportReq('DXF'));
    expect(denied.status).toBe(402);
    // Being out of credits must not produce a file.
    expect(denied.headers.get('content-type')).toContain('json');
  });

  it('never went negative', async () => {
    if (!up) return;
    const agg = await db.creditEntry.aggregate({ where: { userId }, _sum: { amount: true } });
    expect(agg._sum.amount).toBe(0);
    expect(await db.download.count({ where: { userId } })).toBe(2);
  });
});
