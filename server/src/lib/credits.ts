import { PrismaClient, type CreditReason, type ExportFormat } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

export const SIGNUP_GRANT = 2;
/** Credits charged per successful export. One file, one credit. */
export const COST_PER_DOWNLOAD = 1;
/** How long an issued export authorisation stays valid. */
const TOKEN_TTL_MS = 5 * 60 * 1000;

export class InsufficientCredits extends Error {
  constructor(readonly balance: number) {
    super('Insufficient credits');
    this.name = 'InsufficientCredits';
  }
}

export class InvalidExportToken extends Error {
  constructor(msg = 'Export authorisation is invalid, expired, or already used') {
    super(msg);
    this.name = 'InvalidExportToken';
  }
}

/**
 * Balance is derived, never stored.
 *
 * Summing an append-only ledger costs a single indexed aggregate and cannot
 * drift out of step with the entries that explain it, which a cached counter
 * eventually does. It also means every balance can be reconciled against the
 * grants and spends that produced it.
 */
export async function getBalance(db: PrismaClient, userId: string): Promise<number> {
  const { _sum } = await db.creditEntry.aggregate({
    where: { userId },
    _sum: { amount: true },
  });
  return _sum.amount ?? 0;
}

/** Grant credits. Used for the signup gift, purchases, and support refunds. */
export async function grantCredits(
  db: PrismaClient,
  userId: string,
  amount: number,
  reason: CreditReason,
  opts: { note?: string; purchaseId?: string } = {}
): Promise<void> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`grantCredits requires a positive integer, got ${amount}`);
  }
  await db.creditEntry.create({
    data: { userId, amount, reason, note: opts.note, purchaseId: opts.purchaseId },
  });
}

/** Canonical hash of an export request, binding a token to one exact job. */
export function hashExportRequest(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/**
 * Reserve the right to run one export.
 *
 * Issued before rendering so the expensive work is only done for a request
 * that was authorised, and redeemed after, so a render that crashes never
 * costs the user a credit. The balance check here is advisory — the
 * authoritative one happens inside the redemption transaction, because only
 * there can it be serialised against other spends.
 */
export async function issueExportToken(
  db: PrismaClient,
  userId: string,
  format: ExportFormat,
  request: unknown
): Promise<{ token: string; balance: number }> {
  const balance = await getBalance(db, userId);
  if (balance < COST_PER_DOWNLOAD) throw new InsufficientCredits(balance);

  const created = await db.exportToken.create({
    data: {
      userId,
      format,
      requestHash: hashExportRequest(request),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });
  return { token: created.id, balance };
}

/**
 * Charge one credit and record the delivered file, atomically.
 *
 * Everything that must agree — the token is unused, the balance still covers
 * the cost, the Download row, the negative ledger entry — happens in one
 * serializable transaction. Two concurrent redemptions of the same token
 * cannot both succeed: the first marks it redeemed, and the second finds
 * `redeemedAt` set and is rejected. The balance is re-read inside the
 * transaction so a user who spends their last credit in a parallel request
 * cannot overdraw.
 */
export async function redeemExportToken(
  db: PrismaClient,
  params: {
    token: string;
    userId: string;
    request: unknown;
    file: { bytes: number; sha256: string; filename: string };
    ip?: string;
    userAgent?: string;
  }
): Promise<{ downloadId: string; balance: number }> {
  const requestHash = hashExportRequest(params.request);

  return db.$transaction(
    async (tx) => {
      // Claim the token: the updateMany only matches while it is unredeemed
      // and unexpired, so the claim itself is the mutual exclusion.
      const claimed = await tx.exportToken.updateMany({
        where: {
          id: params.token,
          userId: params.userId,
          requestHash,
          redeemedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { redeemedAt: new Date() },
      });
      if (claimed.count !== 1) throw new InvalidExportToken();

      const agg = await tx.creditEntry.aggregate({
        where: { userId: params.userId },
        _sum: { amount: true },
      });
      const balance = agg._sum.amount ?? 0;
      if (balance < COST_PER_DOWNLOAD) throw new InsufficientCredits(balance);

      const tok = await tx.exportToken.findUniqueOrThrow({ where: { id: params.token } });

      const download = await tx.download.create({
        data: {
          userId: params.userId,
          format: tok.format,
          bytes: params.file.bytes,
          sha256: params.file.sha256,
          filename: params.file.filename,
          ip: params.ip,
          userAgent: params.userAgent,
        },
      });

      await tx.creditEntry.create({
        data: {
          userId: params.userId,
          amount: -COST_PER_DOWNLOAD,
          reason: 'DOWNLOAD',
          downloadId: download.id,
        },
      });

      return { downloadId: download.id, balance: balance - COST_PER_DOWNLOAD };
    },
    { isolationLevel: 'Serializable' }
  );
}

/**
 * Credit a Stripe purchase exactly once.
 *
 * Webhooks are re-delivered on any non-2xx and can arrive out of order or
 * more than once, so crediting is keyed on the Stripe session id: the unique
 * constraint makes a replay a no-op rather than a second grant.
 */
export async function creditPurchase(
  db: PrismaClient,
  params: { userId: string; credits: number; amount: number; currency: string; stripeSessionId: string; stripePaymentIntentId?: string }
): Promise<{ granted: boolean }> {
  return db.$transaction(
    async (tx) => {
      const existing = await tx.purchase.findUnique({
        where: { stripeSessionId: params.stripeSessionId },
      });
      if (existing?.status === 'PAID') return { granted: false };

      const purchase = existing
        ? await tx.purchase.update({
            where: { id: existing.id },
            data: { status: 'PAID', stripePaymentIntentId: params.stripePaymentIntentId },
          })
        : await tx.purchase.create({
            data: {
              userId: params.userId,
              credits: params.credits,
              amount: params.amount,
              currency: params.currency,
              status: 'PAID',
              stripeSessionId: params.stripeSessionId,
              stripePaymentIntentId: params.stripePaymentIntentId,
            },
          });

      await tx.creditEntry.create({
        data: {
          userId: params.userId,
          amount: params.credits,
          reason: 'PURCHASE',
          purchaseId: purchase.id,
          note: params.stripeSessionId,
        },
      });
      return { granted: true };
    },
    { isolationLevel: 'Serializable' }
  );
}

/** Total downloads, derived from the ledger of delivered files. */
export async function getDownloadCount(db: PrismaClient, userId: string): Promise<number> {
  return db.download.count({ where: { userId } });
}
