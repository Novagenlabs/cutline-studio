import { db } from '@/lib/db';
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
  return result.count;
}
