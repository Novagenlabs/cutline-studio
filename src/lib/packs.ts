/**
 * Credit packs.
 *
 * Defined server-side and sent to the client as data. The browser never sends
 * a price or a credit count — only a pack id — because a client that could
 * name its own price would be asked to.
 */
export const PACKS = {
  starter: { credits: 10, amount: 900, label: '10 credits' },
  pro: { credits: 50, amount: 3500, label: '50 credits' },
  studio: { credits: 200, amount: 11000, label: '200 credits' },
} as const;

export type PackId = keyof typeof PACKS;
