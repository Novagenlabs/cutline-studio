import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/**
 * Sign-out has to actually end the session.
 *
 * The studio POSTed to /api/auth/signout with no CSRF token. Auth.js answers
 * 302 to that — so the request looked successful and the page reloaded — but
 * it does not clear the cookie and does not delete the session row, and
 * /api/me keeps reporting signedIn: true. On Safari the user pressed Sign out,
 * watched the page reload, and was still signed in.
 *
 * A status-code assertion would have passed against the broken version, which
 * is exactly why this checks the three things that actually change: the
 * Set-Cookie clearing the session, the row disappearing, and /api/me flipping.
 *
 * Runs against a live server (npm run dev, or APP_URL) with a real session
 * row, because the bug lives in the interaction between the two.
 */
const BASE = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const SECURE = BASE.startsWith('https://');
const COOKIE = SECURE ? '__Secure-authjs.session-token' : 'authjs.session-token';

const db = new PrismaClient();

async function withSession<T>(fn: (token: string, userId: string) => Promise<T>): Promise<T> {
  const u = await db.user.create({ data: { email: `signout-${randomUUID()}@example.invalid` } });
  const token = randomUUID();
  await db.session.create({
    data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 600_000) },
  });
  try {
    return await fn(token, u.id);
  } finally {
    await db.session.deleteMany({ where: { userId: u.id } });
    await db.creditEntry.deleteMany({ where: { userId: u.id } });
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
  }
}

const signedIn = async (token: string): Promise<boolean> => {
  const r = await fetch(`${BASE}/api/me`, { headers: { cookie: `${COOKIE}=${token}` } });
  return (await r.json()).signedIn === true;
};

describe.skipIf(!process.env.DATABASE_URL)('signing out', () => {
  it('a session works before it is ended', async () => {
    await withSession(async (token) => {
      expect(await signedIn(token)).toBe(true);
    });
  });

  it('a POST without a CSRF token does NOT end the session', async () => {
    // Documenting the trap rather than the fix: this is what the studio used
    // to send, and the 302 is why it looked like it worked.
    await withSession(async (token) => {
      const res = await fetch(`${BASE}/api/auth/signout`, {
        method: 'POST',
        headers: { cookie: `${COOKIE}=${token}` },
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      // Still signed in, despite the encouraging status code.
      expect(await signedIn(token)).toBe(true);
    });
  });

  it('a POST with a CSRF token ends it properly', async () => {
    await withSession(async (token, userId) => {
      const cr = await fetch(`${BASE}/api/auth/csrf`);
      const { csrfToken } = await cr.json();
      const csrfCookie = (cr.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0])
        .join('; ');

      const res = await fetch(`${BASE}/api/auth/signout`, {
        method: 'POST',
        headers: {
          cookie: `${COOKIE}=${token}; ${csrfCookie}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ csrfToken }).toString(),
        redirect: 'manual',
      });
      expect(res.status).toBe(302);

      // The three things that must change, none of which the status shows.
      const cleared = (res.headers.getSetCookie?.() ?? []).some(
        (c) =>
          c.includes('authjs.session-token=') &&
          /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(c)
      );
      expect(cleared).toBe(true);
      expect(await db.session.findUnique({ where: { sessionToken: token } })).toBeNull();
      expect(await signedIn(token)).toBe(false);

      // The account itself survives — signing out is not deleting anything.
      expect(await db.user.findUnique({ where: { id: userId } })).not.toBeNull();
    });
  });
});
