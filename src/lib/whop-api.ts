/**
 * The outbound half of the Whop integration.
 *
 * whop.ts verifies what Whop sends us; this asks Whop for things. Kept
 * separate because the trust direction is opposite: everything there is
 * untrusted input to be authenticated, everything here is our own request
 * carrying a secret that must never reach the browser.
 *
 * Why the integration needs both a webhook AND an API key, since they look
 * redundant from a distance:
 *
 * The webhook is Whop telling us a payment happened. It is the only thing
 * that grants credits, and it is trusted because it is signed.
 *
 * The API key exists for one job: creating a checkout session so that
 * `userId` can be attached to it as metadata. Whop hands that metadata back
 * on the payment webhook, and it is the entire binding between a payment and
 * an account. The alternative — static checkout links in the browser — would
 * work for taking money and fail at knowing whose balance to credit, leaving
 * email matching as the only link and anyone who paid with a different
 * address uncredited.
 *
 * So: the key creates the binding, the webhook acts on it. Neither replaces
 * the other, and the whole of the key's job is the one call below.
 */

const API = 'https://api.whop.com/api';

function apiKey(): string {
  const key = process.env.WHOP_API_KEY;
  if (!key) throw new Error('WHOP_API_KEY is not set');
  return key;
}

export interface CheckoutSession {
  id: string;
  /** Where to send the buyer. */
  purchaseUrl: string;
}

/**
 * Create a checkout session for one plan and return the URL to send the buyer
 * to.
 *
 * `metadata` is the important argument: Whop attaches it to the payment and
 * the membership that result, and hands it back on the webhook. It is how a
 * payment is bound to a Cutline account, so callers must set it server-side
 * from the session rather than from anything the browser supplied.
 */
export async function createCheckoutSession(opts: {
  planId: string;
  redirectUrl?: string;
  metadata?: Record<string, string>;
}): Promise<CheckoutSession> {
  const res = await fetch(`${API}/v2/checkout_sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      plan_id: opts.planId,
      redirect_url: opts.redirectUrl,
      metadata: opts.metadata ?? {},
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    // The body carries Whop's own explanation; losing it would leave only a
    // status code to debug a failed purchase with.
    throw new Error(`Whop checkout session failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const body = JSON.parse(text) as { id?: string; purchase_url?: string };
  if (!body.id || !body.purchase_url) {
    throw new Error(`Whop returned no purchase URL: ${text.slice(0, 300)}`);
  }
  return { id: body.id, purchaseUrl: body.purchase_url };
}
