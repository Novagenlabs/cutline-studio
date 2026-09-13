import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Whop webhooks.
 *
 * Whop follows the Standard Webhooks specification: the signature is an
 * HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, keyed by the
 * endpoint secret, delivered base64 in a `webhook-signature` header that may
 * carry several space-separated `v1,<sig>` entries during a secret rotation.
 *
 * Two properties of their delivery drive the design here:
 *
 * - At least once, with 12 retries over ~71 hours. Duplicates are normal, not
 *   exceptional, so every handler is keyed on the `webhook-id` and a replay
 *   is a no-op rather than a second grant.
 * - Out of order. A `membership.deactivated` can land before the
 *   `membership.activated` that preceded it, so state is applied only when
 *   the payload is newer than what is already stored.
 *
 * Docs: https://docs.whop.com/developer/guides/webhooks
 */

/** Standard Webhooks headers, lowercased as Node delivers them. */
export const WEBHOOK_ID_HEADER = 'webhook-id';
export const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature';

/** Reject anything older than this, so a captured request cannot be replayed. */
const TOLERANCE_SECONDS = 5 * 60;

export class WebhookError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

/**
 * The signing key.
 *
 * Whop presents it as `whsec_<base64>` (Standard Webhooks) or a bare `ws_`
 * secret. The `whsec_` prefix is stripped and the remainder base64-decoded —
 * signing against the prefixed string produces a valid-looking HMAC that
 * never matches, which is a miserable thing to debug in production.
 */
function signingKey(secret: string): Buffer {
  if (secret.startsWith('whsec_')) {
    return Buffer.from(secret.slice('whsec_'.length), 'base64');
  }
  return Buffer.from(secret, 'utf8');
}

/** Constant-time compare that tolerates differing lengths. */
function sameSignature(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a Whop webhook and return its parsed body.
 *
 * Takes the RAW body text. Re-serialising a parsed object would reorder keys
 * and change whitespace, and the signature covers the exact bytes sent.
 */
export function verifyWebhook(
  rawBody: string,
  headers: Headers,
  secret: string
): { id: string; type: string; payload: WhopWebhookBody } {
  const id = headers.get(WEBHOOK_ID_HEADER);
  const timestamp = headers.get(WEBHOOK_TIMESTAMP_HEADER);
  const signature = headers.get(WEBHOOK_SIGNATURE_HEADER);

  if (!id || !timestamp || !signature) {
    throw new WebhookError('Missing webhook signature headers.', 400);
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) {
    throw new WebhookError('Malformed webhook timestamp.', 400);
  }
  const age = Math.abs(Date.now() / 1000 - sent);
  if (age > TOLERANCE_SECONDS) {
    throw new WebhookError('Webhook timestamp outside tolerance.', 400);
  }

  const expected = createHmac('sha256', signingKey(secret))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  // The header carries one or more `v1,<signature>` pairs; during a rotation
  // both the old and new secret's signatures are sent, and matching any one
  // of them is a pass.
  const candidates = signature
    .split(' ')
    .map((part) => part.split(',', 2))
    .filter(([version]) => version === 'v1')
    .map(([, value]) => value ?? '');

  if (!candidates.some((candidate) => sameSignature(candidate, expected))) {
    throw new WebhookError('Webhook signature did not match.', 401);
  }

  let payload: WhopWebhookBody;
  try {
    payload = JSON.parse(rawBody) as WhopWebhookBody;
  } catch {
    throw new WebhookError('Webhook body was not JSON.', 400);
  }

  return { id, type: payload.type ?? 'unknown', payload };
}

/* ---------------------------------------------------------------- payloads */

/**
 * The envelope. Whop wraps every event as `{ id, type, timestamp, data }`.
 * Only the fields this app reads are typed; the rest of the payload is kept
 * verbatim in the WhopEvent row, so a handler written later can use it.
 */
export interface WhopWebhookBody {
  id?: string;
  type?: string;
  timestamp?: string;
  api_version?: string;
  data?: WhopMembership & WhopPayment;
}

/** https://docs.whop.com/api-reference/memberships/membership */
export interface WhopMembership {
  id?: string;
  status?: string;
  license_key?: string | null;
  cancel_at_period_end?: boolean;
  renewal_period_end?: string | null;
  updated_at?: string;
  metadata?: Record<string, unknown> | null;
  user?: { id?: string; email?: string; username?: string; name?: string };
  plan?: { id?: string; metadata?: Record<string, unknown> | null };
  product?: { id?: string; title?: string };
  membership?: { id?: string; status?: string };
}

/** https://docs.whop.com/api-reference/payments/payment-succeeded */
export interface WhopPayment {
  id?: string;
  status?: string;
  paid_at?: string | null;
}

/**
 * Whop's membership statuses, mapped onto the local enum.
 *
 * Anything unrecognised becomes UNKNOWN rather than throwing: a status Whop
 * adds later should be recorded and then decided on by a human, not dropped
 * on the floor or turned into a 500 that makes Whop retry for three days.
 */
export type LocalStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'COMPLETED'
  | 'CANCELED'
  | 'CANCELING'
  | 'EXPIRED'
  | 'UNRESOLVED'
  | 'DRAFTED'
  | 'UNKNOWN';

const STATUS: Record<string, LocalStatus> = {
  trialing: 'TRIALING',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  completed: 'COMPLETED',
  canceled: 'CANCELED',
  canceling: 'CANCELING',
  expired: 'EXPIRED',
  unresolved: 'UNRESOLVED',
  drafted: 'DRAFTED',
};

export function mapStatus(status: string | undefined): LocalStatus {
  if (!status) return 'UNKNOWN';
  return STATUS[status.toLowerCase()] ?? 'UNKNOWN';
}

/**
 * Does this membership state grant access right now?
 *
 * Not a lookup on status alone, because two cases would be wrong:
 *
 * - `canceling` means the buyer has turned off renewal but has PAID for the
 *   rest of the period. Cutting them off at the moment they cancel is taking
 *   money for access not given.
 * - `active` with a renewal date in the past means a webhook was missed. The
 *   period is the fact; the status is a cached opinion about it.
 */
export function grantsAccess(
  status: LocalStatus,
  renewalPeriodEnd: Date | null
): boolean {
  const withinPeriod =
    renewalPeriodEnd === null || renewalPeriodEnd.getTime() > Date.now();

  switch (status) {
    case 'TRIALING':
    case 'ACTIVE':
      return withinPeriod;
    // Paid through the end of the period, renewal switched off.
    case 'CANCELING':
      return withinPeriod;
    // Whop keeps retrying the card. Access continues while it does, because
    // a transient decline is not a cancellation.
    case 'PAST_DUE':
      return withinPeriod;
    default:
      return false;
  }
}
