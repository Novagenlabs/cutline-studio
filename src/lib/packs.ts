/**
 * Credit packs.
 *
 * Defined server-side and sent to the client as data. The browser never sends
 * a price or a credit count — only a pack id — because a client that could
 * name its own price would be asked to.
 *
 * Each pack maps to a hidden one-time Whop plan. Hidden because these are
 * sold from our own dialog rather than the Whop storefront; one-time because
 * a renewal plan would quietly subscribe someone who meant to buy a pack
 * once. The prices here and the `initial_price` on the plan must agree — Whop
 * charges what the plan says, so a mismatch means the buyer is charged one
 * number while the UI promised another. `amount` stays the source of truth
 * for what is displayed, and scripts/whop-plans.mjs re-checks both.
 */
export const PACKS = {
  // Pay as you go: one download, no commitment. The worst margin of the four
  // — Whop's fixed $0.30 is ~15% of $1.99, against ~5% on the 200 pack — but
  // it is the only price someone will pay without thinking, and the per-credit
  // rate makes every pack above it look like the better deal, which it is.
  single: {
    credits: 1,
    amount: 199,
    label: '1 download',
    whopPlanId: 'plan_kZfiKaRGgRKLK',
  },
  starter: {
    credits: 10,
    amount: 900,
    label: '10 credits',
    whopPlanId: 'plan_pDPU2bWMl0dt4',
  },
  pro: {
    credits: 50,
    amount: 3500,
    label: '50 credits',
    whopPlanId: 'plan_0cCjWB5OaX7X7',
  },
  studio: {
    credits: 200,
    amount: 11000,
    label: '200 credits',
    whopPlanId: 'plan_AjZlfcrfHbcnP',
  },
} as const;

export type PackId = keyof typeof PACKS;

export function isPackId(v: unknown): v is PackId {
  return typeof v === 'string' && v in PACKS;
}

/**
 * The Starter subscription.
 *
 * A renewal plan rather than a one-time one, and the only visible product on
 * the Whop storefront — the packs are hidden because they are sold from our
 * own dialog. Credits from a renewal top up the same balance packs do and do
 * not lapse at the period boundary, which is a deliberate departure from how
 * ElevenLabs and most metered products work: taking credits away that someone
 * has already been told they have is a support ticket, and the generosity
 * costs little while the numbers are this small.
 *
 * `credits` must agree with SUBSCRIPTION_CREDITS in subscription.ts — that is
 * what the webhook actually grants; this is only what the UI promises.
 */
export const SUBSCRIPTION = {
  credits: 200,
  amount: 3999,
  label: 'Starter',
  perMonth: true,
  trialDays: 3,
  whopPlanId: 'plan_4kYzeHJQQHZex',
} as const;
