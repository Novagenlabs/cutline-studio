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
