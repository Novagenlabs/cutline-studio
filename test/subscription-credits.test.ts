import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The monthly credit grant, and the one rule that keeps it honest.
 *
 * Whop delivers at least once and retries a failed delivery for ~71 hours, so
 * the same payment arriving twice is the normal case, not an edge case. Every
 * test here is about the difference between "this payment was handled" and
 * "this payment was paid out", because getting that wrong is not a cosmetic
 * bug: it either hands out free credits on every retry or silently swallows a
 * month the customer paid for.
 *
 * The database is mocked rather than real, so these run without Neon. What is
 * being tested is the decision logic — which events pay, whose account they
 * land in, and what happens on a replay — not Postgres's ability to enforce a
 * unique index, which is Postgres's job and is taken on trust.
 */

const create = vi.fn();
const findUnique = vi.fn();
const findMany = vi.fn();
const updateMany = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    creditEntry: { create: (...a: unknown[]) => create(...a) },
    subscription: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
    whopEvent: { findMany: (...a: unknown[]) => findMany(...a) },
  },
}));

const {
  grantSubscriptionCredits,
  claimSubscriptions,
  SUBSCRIPTION_CREDITS,
  PAYING_EVENTS,
} = await import('../src/lib/subscription');

/** What Prisma throws when a unique index rejects a duplicate insert. */
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

beforeEach(() => {
  create.mockReset();
  findUnique.mockReset();
  findMany.mockReset();
  updateMany.mockReset();
});

describe('granting a period of credits', () => {
  it('writes one ledger entry for the configured amount', async () => {
    create.mockResolvedValue({});
    const granted = await grantSubscriptionCredits('user_1', 'evt_1', 'Whop payment.succeeded');

    expect(granted).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const { data } = create.mock.calls[0][0];
    expect(data.amount).toBe(SUBSCRIPTION_CREDITS);
    expect(data.userId).toBe('user_1');
    expect(data.reason).toBe('SUBSCRIPTION');
  });

  it('keys the entry to the webhook id, which is what makes a replay safe', async () => {
    create.mockResolvedValue({});
    await grantSubscriptionCredits('user_1', 'evt_1', 'note');

    // Not the membership id and not the timestamp: the webhook id is the only
    // value that is stable across a retry and distinct between two months.
    expect(create.mock.calls[0][0].data.whopEventId).toBe('evt_1');
  });

  it('grants nothing the second time the same payment arrives', async () => {
    create.mockRejectedValueOnce(uniqueViolation());
    const granted = await grantSubscriptionCredits('user_1', 'evt_1', 'note');

    // Swallowed, not thrown: a retry must end in a 200 or Whop keeps
    // redelivering an event that has already paid out.
    expect(granted).toBe(false);
  });

  it('still pays out for the next month, which is a different event', async () => {
    create.mockRejectedValueOnce(uniqueViolation()).mockResolvedValueOnce({});
    expect(await grantSubscriptionCredits('u', 'evt_jan', 'note')).toBe(false);
    expect(await grantSubscriptionCredits('u', 'evt_feb', 'note')).toBe(true);
  });

  it('lets a real database error surface instead of silently skipping a grant', async () => {
    create.mockRejectedValueOnce(new Error('connection reset'));
    // If this were swallowed like a duplicate, the webhook would answer 200,
    // Whop would stop retrying, and the customer would never get the month.
    await expect(grantSubscriptionCredits('u', 'e', 'n')).rejects.toThrow('connection reset');
  });
});

describe('which events pay', () => {
  it('counts a succeeded payment', () => {
    expect(PAYING_EVENTS).toContain('payment.succeeded');
  });

  it('does not count a membership going active', () => {
    // membership.activated also fires for a free trial, so granting on it
    // would give a month of credits to someone who never paid.
    expect(PAYING_EVENTS).not.toContain('membership.activated');
    expect(PAYING_EVENTS).not.toContain('membership.cancel_at_period_end_changed');
  });
});

describe('a payment that arrived before the buyer had an account', () => {
  it('pays out the recorded events when they sign in', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findMany.mockResolvedValue([{ id: 'evt_1', type: 'payment.succeeded' }]);
    create.mockResolvedValue({});

    const claimed = await claimSubscriptions('user_1', 'Buyer@Example.com');

    expect(claimed).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.userId).toBe('user_1');
    expect(create.mock.calls[0][0].data.whopEventId).toBe('evt_1');
  });

  it('matches the membership on a lowercased email', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await claimSubscriptions('user_1', 'Buyer@Example.com');
    expect(updateMany.mock.calls[0][0].where.whopUserEmail).toBe('buyer@example.com');
  });

  it('ignores events that failed to process, so the retry can still grant', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findMany.mockResolvedValue([]);
    await claimSubscriptions('user_1', 'a@b.com');

    // An unprocessed event has not been applied to the subscription at all;
    // crediting from it here would pay for a membership that was never set up.
    expect(findMany.mock.calls[0][0].where.processedAt).toEqual({ not: null });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not go looking for payments when nothing was claimed', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await claimSubscriptions('user_1', 'a@b.com');
    // Every sign-in calls this; it must not cost a query per login.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('cannot double-pay a claim that already paid out', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findMany.mockResolvedValue([{ id: 'evt_1', type: 'payment.succeeded' }]);
    create.mockRejectedValueOnce(uniqueViolation());

    // Signing out and back in replays the same events; the unique key on the
    // webhook id is what stops that from minting credits each time.
    await expect(claimSubscriptions('user_1', 'a@b.com')).resolves.toBe(1);
  });
});
