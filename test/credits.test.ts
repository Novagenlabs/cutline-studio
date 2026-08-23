/**
 * Credit-ledger tests against a real Postgres.
 *
 * These deliberately do not mock the database. Every property that matters
 * here — double-spend under concurrency, webhook replay, refund-on-failure —
 * is a property of the transaction semantics, and a mock would assert only
 * that the code calls the functions it calls, which is the part that was
 * never in doubt.
 *
 *   createdb cutline_test
 *   DATABASE_URL=postgresql://localhost/cutline_test npx prisma db push
 *   DATABASE_URL=postgresql://localhost/cutline_test npx vitest run
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  COST_PER_DOWNLOAD, SIGNUP_GRANT, InsufficientCredits, InvalidExportToken,
  getBalance, grantCredits, issueExportToken, redeemExportToken, creditPurchase,
  getDownloadCount,
} from '../src/lib/credits';

const db = new PrismaClient();
let userId: string;

const REQ = { format: 'SVG', beziers: [[1, 2]], widthMm: 10, heightMm: 10, dpi: 300 };
const FILE = { bytes: 1234, sha256: 'a'.repeat(64), filename: 'x-cut.svg' };

beforeEach(async () => {
  await db.creditEntry.deleteMany();
  await db.exportToken.deleteMany();
  await db.download.deleteMany();
  await db.purchase.deleteMany();
  await db.user.deleteMany();
  const u = await db.user.create({ data: { email: `t${Date.now()}@example.com` } });
  userId = u.id;
});
afterAll(async () => { await db.$disconnect(); });

describe('balance', () => {
  it('starts at zero and sums the ledger', async () => {
    expect(await getBalance(db, userId)).toBe(0);
    await grantCredits(db, userId, SIGNUP_GRANT, 'SIGNUP_GRANT');
    expect(await getBalance(db, userId)).toBe(2);
    await grantCredits(db, userId, 10, 'PURCHASE');
    expect(await getBalance(db, userId)).toBe(12);
  });

  it('refuses a non-positive or fractional grant', async () => {
    await expect(grantCredits(db, userId, 0, 'PURCHASE')).rejects.toThrow();
    await expect(grantCredits(db, userId, -5, 'PURCHASE')).rejects.toThrow();
    await expect(grantCredits(db, userId, 1.5, 'PURCHASE')).rejects.toThrow();
  });
});

describe('spending', () => {
  it('charges exactly one credit and records the download', async () => {
    await grantCredits(db, userId, 2, 'SIGNUP_GRANT');
    const { token } = await issueExportToken(db, userId, 'SVG', REQ);
    const { balance } = await redeemExportToken(db, { token, userId, request: REQ, file: FILE });
    expect(balance).toBe(2 - COST_PER_DOWNLOAD);
    expect(await getBalance(db, userId)).toBe(1);
    expect(await getDownloadCount(db, userId)).toBe(1);
  });

  it('refuses to issue a token with no credits', async () => {
    await expect(issueExportToken(db, userId, 'SVG', REQ)).rejects.toBeInstanceOf(InsufficientCredits);
  });

  it('THE DOUBLE-SPEND CASE: one token cannot be redeemed twice', async () => {
    await grantCredits(db, userId, 5, 'PURCHASE');
    const { token } = await issueExportToken(db, userId, 'SVG', REQ);
    await redeemExportToken(db, { token, userId, request: REQ, file: FILE });
    await expect(
      redeemExportToken(db, { token, userId, request: REQ, file: FILE })
    ).rejects.toBeInstanceOf(InvalidExportToken);
    expect(await getBalance(db, userId)).toBe(4);
    expect(await getDownloadCount(db, userId)).toBe(1);
  });

  it('THE RACE: concurrent redemptions of one token settle as a single spend', async () => {
    await grantCredits(db, userId, 5, 'PURCHASE');
    const { token } = await issueExportToken(db, userId, 'SVG', REQ);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        redeemExportToken(db, { token, userId, request: REQ, file: FILE })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await getBalance(db, userId)).toBe(4);
    expect(await getDownloadCount(db, userId)).toBe(1);
  });

  it('THE OVERDRAW: parallel exports cannot take the balance negative', async () => {
    await grantCredits(db, userId, 2, 'SIGNUP_GRANT');
    const tokens = await Promise.all([
      issueExportToken(db, userId, 'SVG', REQ),
      issueExportToken(db, userId, 'SVG', REQ),
      issueExportToken(db, userId, 'SVG', REQ),
      issueExportToken(db, userId, 'SVG', REQ),
    ]);
    // Four authorisations were issued against a balance of two — the issue
    // check is advisory. The redemption transaction is what must hold.
    await Promise.allSettled(
      tokens.map((t) => redeemExportToken(db, { token: t.token, userId, request: REQ, file: FILE }))
    );
    const balance = await getBalance(db, userId);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance + (await getDownloadCount(db, userId)) * COST_PER_DOWNLOAD).toBe(2);
  });

  it('a token cannot be spent on a different request than it authorised', async () => {
    await grantCredits(db, userId, 5, 'PURCHASE');
    const { token } = await issueExportToken(db, userId, 'SVG', REQ);
    await expect(
      redeemExportToken(db, { token, userId, request: { ...REQ, widthMm: 9999 }, file: FILE })
    ).rejects.toBeInstanceOf(InvalidExportToken);
    expect(await getBalance(db, userId)).toBe(5);
  });

  it('a token cannot be redeemed by another user', async () => {
    await grantCredits(db, userId, 5, 'PURCHASE');
    const other = await db.user.create({ data: { email: `o${Date.now()}@example.com` } });
    await grantCredits(db, other.id, 5, 'PURCHASE');
    const { token } = await issueExportToken(db, userId, 'SVG', REQ);
    await expect(
      redeemExportToken(db, { token, userId: other.id, request: REQ, file: FILE })
    ).rejects.toBeInstanceOf(InvalidExportToken);
    expect(await getBalance(db, other.id)).toBe(5);
  });

  it('an expired token is worthless', async () => {
    await grantCredits(db, userId, 5, 'PURCHASE');
    const { token } = await issueExportToken(db, userId, 'SVG', REQ);
    await db.exportToken.update({ where: { id: token }, data: { expiresAt: new Date(Date.now() - 1) } });
    await expect(
      redeemExportToken(db, { token, userId, request: REQ, file: FILE })
    ).rejects.toBeInstanceOf(InvalidExportToken);
    expect(await getBalance(db, userId)).toBe(5);
  });

  it('a failed render costs nothing (token simply goes unredeemed)', async () => {
    await grantCredits(db, userId, 2, 'SIGNUP_GRANT');
    await issueExportToken(db, userId, 'SVG', REQ); // never redeemed
    expect(await getBalance(db, userId)).toBe(2);
    expect(await getDownloadCount(db, userId)).toBe(0);
  });
});

describe('purchases', () => {
  it('credits a paid session', async () => {
    const r = await creditPurchase(db, {
      userId, credits: 10, amount: 900, currency: 'cad', stripeSessionId: 'cs_1',
    });
    expect(r.granted).toBe(true);
    expect(await getBalance(db, userId)).toBe(10);
  });

  it('THE REPLAY: a redelivered webhook does not grant twice', async () => {
    const args = { userId, credits: 10, amount: 900, currency: 'cad', stripeSessionId: 'cs_dup' };
    await creditPurchase(db, args);
    const second = await creditPurchase(db, args);
    expect(second.granted).toBe(false);
    expect(await getBalance(db, userId)).toBe(10);
  });

  it('concurrent deliveries of one session grant once', async () => {
    const args = { userId, credits: 10, amount: 900, currency: 'cad', stripeSessionId: 'cs_race' };
    await Promise.allSettled([
      creditPurchase(db, args), creditPurchase(db, args), creditPurchase(db, args),
    ]);
    expect(await getBalance(db, userId)).toBe(10);
  });
});

describe('audit', () => {
  it('every spend is traceable to the file it bought', async () => {
    await grantCredits(db, userId, 3, 'PURCHASE');
    const { token } = await issueExportToken(db, userId, 'PDF', REQ);
    const { downloadId } = await redeemExportToken(db, {
      token, userId, request: REQ, file: { ...FILE, filename: 'logo-cut.pdf' },
    });
    const entry = await db.creditEntry.findFirst({ where: { downloadId } });
    expect(entry?.amount).toBe(-COST_PER_DOWNLOAD);
    expect(entry?.reason).toBe('DOWNLOAD');
    const dl = await db.download.findUniqueOrThrow({ where: { id: downloadId } });
    expect(dl.sha256).toBe(FILE.sha256);
    expect(dl.filename).toBe('logo-cut.pdf');
  });
});
