import { db } from '@/lib/db';
import { PACKS } from '@/lib/packs';
import { grantsAccess, mapStatus, type WhopWebhookBody } from '@/lib/whop';

/**
 * Whop subscriptions, applied to local state.
 *
 * The design rests on one decision: the membership is recorded even when no
 * Cutline account matches it. A Whop checkout can complete before the buyer
 * has ever signed in here, and dropping the webhook in that window would mean
 * a paying customer whose payment left no trace. Instead the row is written
 * with `userId: null` and claimed later — on sign-in, by email.
 */

/** Credits granted per billing period on the Starter plan. */
export const SUBSCRIPTION_CREDITS = 200;

/**
 * Apply one webhook to the Subscription table.
 *
 * Idempotent by construction: the upsert is keyed on Whop's membership id, so
 * the same event applied twice converges on the same row rather than creating
 * a second one. Out-of-order deliveries are handled by refusing to apply a
 * payload older than what is already stored.
 */
export async function applyMembershipEvent(
  body: WhopWebhookBody
): Promise<{ subscriptionId: string | null; changed: boolean }> {
  const data = body.data ?? {};
  // A payment event nests the membership; a membership event is the object.
  const membershipId = data.membership?.id ?? data.id;
  if (!membershipId || !membershipId.startsWith('mem_')) {
    return { subscriptionId: null, changed: false };
  }

  const status = mapStatus(data.status ?? data.membership?.status);
  const renewalPeriodEnd = data.renewal_period_end
    ? new Date(data.renewal_period_end)
    : null;
  const whopUpdatedAt = data.updated_at ? new Date(data.updated_at) : null;

  const existing = await db.subscription.findUnique({
    where: { whopMembershipId: membershipId },
  });

  // Whop can deliver out of order. An event older than what is stored would
  // otherwise resurrect a cancelled subscription or expire a live one.
  if (
    existing?.whopUpdatedAt &&
    whopUpdatedAt &&
    whopUpdatedAt < existing.whopUpdatedAt
  ) {
    return { subscriptionId: existing.id, changed: false };
  }

  const email = data.user?.email?.toLowerCase() ?? null;

  // Link to a local account when one already exists for this email. Whop is
  // the identity here: someone who paid with an address that matches a
  // Cutline account is that account's owner.
  const user = email
    ? await db.user.findUnique({ where: { email }, select: { id: true } })
    : null;

  const fields = {
    status,
    renewalPeriodEnd,
    cancelAtPeriodEnd: data.cancel_at_period_end ?? false,
    whopUpdatedAt,
    whopUserId: data.user?.id ?? null,
    whopUserEmail: email,
    whopPlanId: data.plan?.id ?? null,
    whopProductId: data.product?.id ?? null,
    licenseKey: data.license_key ?? null,
  };

  const row = await db.subscription.upsert({
    where: { whopMembershipId: membershipId },
    create: {
      whopMembershipId: membershipId,
      // Only set on create: an existing link is never overwritten, or a buyer
      // who changed their Whop email would be detached from their account.
      userId: user?.id ?? null,
      ...fields,
    },
    update: {
      ...fields,
      // Claim an unclaimed row if the account exists now but did not before.
      ...(user && !existing?.userId ? { userId: user.id } : {}),
    },
  });

  return { subscriptionId: row.id, changed: true };
}

/**
 * Does this user have access through a subscription right now?
 *
 * Read from the stored period rather than from the status alone — see
 * grantsAccess() for why a cancelled-but-paid membership still counts.
 */
export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const subs = await db.subscription.findMany({
    where: { userId },
    select: { status: true, renewalPeriodEnd: true },
  });
  return subs.some((s) => grantsAccess(s.status, s.renewalPeriodEnd));
}

/**
 * What to tell the UI about this user's subscription.
 *
 * Advisory, like the balance beside it: nothing is authorised from this, and
 * the export route re-checks access when it charges. Returns null rather than
 * a shape full of nulls, so the client's check is `if (subscription)`.
 */
export async function describeSubscription(userId: string): Promise<{
  status: string;
  active: boolean;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  manageUrl: string | null;
} | null> {
  const subs = await db.subscription.findMany({
    where: { userId },
    orderBy: { renewalPeriodEnd: 'desc' },
  });
  if (subs.length === 0) return null;

  // The one that actually grants access wins; otherwise the most recent, so
  // a lapsed subscriber sees "expired" rather than nothing at all.
  const live = subs.find((s) => grantsAccess(s.status, s.renewalPeriodEnd));
  const sub = live ?? subs[0];

  return {
    status: sub.status,
    active: live !== undefined,
    renewsAt: sub.renewalPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    // Whop hosts the billing portal; there is nothing to build here.
    manageUrl: sub.whopMembershipId
      ? `https://whop.com/billing/manage/${sub.whopMembershipId}`
      : null,
  };
}

/**
 * Attach any memberships bought before this account existed.
 *
 * Called on sign-in. Without it, someone who paid on Whop and then signed in
 * here would have a subscription the app cannot see — the single most likely
 * support ticket this integration can produce.
 */
export async function claimSubscriptions(
  userId: string,
  email: string
): Promise<number> {
  const result = await db.subscription.updateMany({
    where: { userId: null, whopUserEmail: email.toLowerCase() },
    data: { userId },
  });
  // Any payment that landed before this account existed was recorded without
  // credits, because there was nobody to credit. Now there is. Without this
  // the buyer's first month is silently unpaid-for: the subscription shows as
  // active and the balance does not move.
  if (result.count > 0) await grantDeferredSubscriptionCredits(userId);
  return result.count;
}

/**
 * Grant one period's credits for a paid subscription.
 *
 * Idempotency is delegated to the unique index on CreditEntry.whopEventId
 * rather than to a read-then-write check. Whop delivers at least once and
 * retries for ~71 hours, so duplicates are routine rather than exceptional,
 * and two deliveries can be in flight at the same moment — a check-then-
 * insert would let both pass the check before either inserted. Letting the
 * insert fail is the only version that is safe under concurrency.
 *
 * Returns whether credits were actually granted, so a replay is visible in
 * the webhook's response rather than looking identical to a first delivery.
 */
export async function grantSubscriptionCredits(
  userId: string,
  whopEventId: string,
  note: string
): Promise<boolean> {
  try {
    await db.creditEntry.create({
      data: {
        userId,
        amount: SUBSCRIPTION_CREDITS,
        reason: 'SUBSCRIPTION',
        note,
        whopEventId,
      },
    });
    return true;
  } catch (err) {
    // P2002 is the unique violation, i.e. this exact payment already paid
    // out. That is the expected outcome of a retry, not a failure: swallow it
    // so the webhook can answer 200 and Whop stops redelivering. Anything
    // else is a real problem and must surface.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Pay out for payments that arrived before the buyer had an account.
 *
 * Those events were applied to the Subscription row with `userId: null`, so
 * no credit entry could be written at the time. The events are still on
 * record, so the grant is replayed from them at claim time — keyed on the
 * same webhook id, so a payment that somehow did get credited is not
 * credited twice.
 */
async function grantDeferredSubscriptionCredits(userId: string): Promise<void> {
  const paid = await db.whopEvent.findMany({
    where: {
      type: { in: PAYING_EVENTS },
      subscription: { userId },
      // Only events that were handled: an event still carrying an error has
      // not been applied, and its retry will grant through the normal path.
      processedAt: { not: null },
    },
    select: { id: true, type: true },
  });
  for (const ev of paid) {
    await grantSubscriptionCredits(userId, ev.id, `Whop ${ev.type} (claimed)`);
  }
}

/** Events that represent money actually received, and so earn credits. */
export const PAYING_EVENTS = ['payment.succeeded', 'payment_succeeded'];

/**
 * Grant credits for a one-off pack purchase.
 *
 * A pack and a subscription both arrive as payment.succeeded, and the
 * difference is the metadata our own checkout route attached: a pack payment
 * carries `pack` and `credits`, a subscription payment does not. Reading the
 * amount from metadata rather than from the payload's price means the credits
 * granted are the credits PACKS promised, not whatever number happens to be
 * on the payment.
 *
 * The credits value is still re-derived from PACKS rather than trusted from
 * the metadata: metadata survives a round trip through Whop, and while our
 * own route is the only thing that sets it today, a grant that reads its
 * amount from an echoed field is one integration away from paying out
 * whatever someone puts there.
 *
 * Shares whopEventId with the subscription grant, so a replay of either is
 * refused by the same unique index.
 */
export async function grantPackCredits(
  whopEventId: string,
  metadata: Record<string, unknown> | null | undefined
): Promise<{ granted: boolean; reason: string }> {
  const userId = typeof metadata?.userId === 'string' ? metadata.userId : null;
  const packId = typeof metadata?.pack === 'string' ? metadata.pack : null;
  if (!userId || !packId) return { granted: false, reason: 'not a pack purchase' };

  const pack = PACKS[packId as keyof typeof PACKS];
  if (!pack) return { granted: false, reason: `unknown pack "${packId}"` };

  try {
    await db.creditEntry.create({
      data: {
        userId,
        amount: pack.credits,
        reason: 'PURCHASE',
        note: `Whop ${pack.label}`,
        whopEventId,
      },
    });
    return { granted: true, reason: `granted ${pack.credits}` };
  } catch (err) {
    if (isUniqueViolation(err)) return { granted: false, reason: 'already granted' };
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}
