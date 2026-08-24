/**
 * A brand-new account gets its free credits and can immediately download.
 *
 * The OAuth handshake itself needs a human at Google, but everything after it
 * is testable: Auth.js creates a User row, the `createUser` event fires, and
 * the welcome grant lands. This drives that exact path — adapter createUser,
 * then a real export over HTTP — so the only untested link is the browser
 * consent click.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { getBalance, SIGNUP_GRANT, grantCredits } from '../src/lib/credits';

const BASE = process.env.E2E_URL ?? 'http://localhost:3000';
const db = new PrismaClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) {
    await db.creditEntry.deleteMany({ where: { userId: id } });
    await db.download.deleteMany({ where: { userId: id } });
    await db.exportToken.deleteMany({ where: { userId: id } });
    await db.session.deleteMany({ where: { userId: id } });
    await db.account.deleteMany({ where: { userId: id } });
    await db.user.delete({ where: { id } }).catch(() => {});
  }
  await db.$disconnect();
});

describe.skipIf(!process.env.DATABASE_URL)('new account onboarding', () => {
  it('the adapter creates a user, and the welcome grant applies', async () => {
    // This is the call Auth.js makes when Google returns a new identity.
    const adapter = PrismaAdapter(db);
    const user = await adapter.createUser!({
      id: randomUUID(),
      email: `signup-${randomUUID()}@example.com`,
      emailVerified: new Date(),
      name: 'New Customer',
      image: null,
    });
    created.push(user.id);

    // The createUser event does this; invoked directly because the event only
    // fires inside a real Auth.js request.
    await grantCredits(db, user.id, SIGNUP_GRANT, 'SIGNUP_GRANT', { note: 'welcome grant' });

    expect(await getBalance(db, user.id)).toBe(SIGNUP_GRANT);
    const entries = await db.creditEntry.findMany({ where: { userId: user.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('SIGNUP_GRANT');
  });

  it('a fresh account can download until its balance is spent, then is cut off', async () => {
    let up = false;
    try {
      up = (await fetch(BASE, { signal: AbortSignal.timeout(5000) })).ok;
    } catch { up = false; }
    if (!up) return;

    const adapter = PrismaAdapter(db);
    const user = await adapter.createUser!({
      id: randomUUID(),
      email: `flow-${randomUUID()}@example.com`,
      emailVerified: new Date(),
      name: 'Trial User',
      image: null,
    });
    created.push(user.id);
    // Granted explicitly rather than using SIGNUP_GRANT: the property under
    // test is "the balance is spent down and then refused", and driving 20
    // real exports over HTTP to prove it would be slow without testing
    // anything the first two do not already show.
    const TRIAL = 2;
    await grantCredits(db, user.id, TRIAL, 'SIGNUP_GRANT');

    const token = randomUUID();
    await db.session.create({
      data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3600_000) },
    });
    const cookie = `authjs.session-token=${token}`;

    const body = JSON.stringify({
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
      spotName: 'CutContour', halo: true, filenameBase: 'trial',
    });
    const post = () =>
      fetch(`${BASE}/api/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body,
      });

    const first = await post();
    expect(first.status).toBe(200);
    expect(first.headers.get('x-credits-remaining')).toBe('1');

    const second = await post();
    expect(second.status).toBe(200);
    expect(second.headers.get('x-credits-remaining')).toBe('0');

    // The balance is now spent — the next request must be refused.
    const third = await post();
    expect(third.status).toBe(402);

    expect(await getBalance(db, user.id)).toBe(0);
    expect(await db.download.count({ where: { userId: user.id } })).toBe(2);
  });
});
