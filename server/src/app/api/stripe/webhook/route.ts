import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db } from '@/lib/db';
import { creditPurchase } from '@/lib/credits';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/**
 * Stripe webhook: the ONLY place credits are granted for money.
 *
 * Never grant on the browser returning to a success URL — that URL is just a
 * redirect the user can visit directly, so trusting it hands out free credits
 * to anyone who reads the address bar. The webhook is trusted because it is
 * signature-verified against the raw body with a shared secret, which a
 * client cannot forge.
 */
export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'unsigned' }, { status: 400 });

  // Signature is computed over the exact bytes Stripe sent; parsing to JSON
  // first would invalidate it.
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: 'bad signature' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.payment_status === 'paid') {
      const userId = s.metadata?.userId;
      const credits = Number(s.metadata?.credits);
      if (userId && Number.isInteger(credits) && credits > 0) {
        // creditPurchase keys on the session id, so Stripe's at-least-once
        // delivery cannot grant the same credits twice.
        await creditPurchase(db, {
          userId,
          credits,
          amount: s.amount_total ?? 0,
          currency: s.currency ?? 'cad',
          stripeSessionId: s.id,
          stripePaymentIntentId:
            typeof s.payment_intent === 'string' ? s.payment_intent : undefined,
        });
      }
    }
  }

  // Anything other than 2xx makes Stripe retry, so acknowledge once handled.
  return NextResponse.json({ received: true });
}
