import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { PACKS } from '@/lib/packs';

/**
 * Built lazily, per request.
 *
 * Constructing this at module load runs it during `next build`, which
 * collects page data by importing every route with no environment present —
 * so the client throws "Neither apiKey nor config.authenticator provided" and
 * the whole build fails. Nothing here needs Stripe until a request arrives.
 */
function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key);
}

export { PACKS } from '@/lib/packs';

const Body = z.object({ pack: z.enum(['starter', 'pro', 'studio']) });

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Unknown credit pack.' }, { status: 400 });
  }
  // Deploying before Stripe is configured is a normal state — the cutter and
  // the free signup credits work without it. Say so plainly rather than
  // returning a 500 with a stack trace.
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { error: 'Buying credits is not available yet. Please contact us.' },
      { status: 503 }
    );
  }

  const pack = PACKS[parsed.data.pack];

  const checkout = await stripeClient().checkout.sessions.create({
    mode: 'payment',
    customer_email: session.user.email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'cad',
          unit_amount: pack.amount,
          product_data: { name: `Cutline Studio — ${pack.label}` },
        },
      },
    ],
    // Read back by the webhook to know who to credit. Metadata is set here,
    // server-side, so the client cannot point a payment at another account.
    metadata: { userId: session.user.id, credits: String(pack.credits) },
    success_url: `${process.env.APP_URL}/account?purchase=success`,
    cancel_url: `${process.env.APP_URL}/account?purchase=cancelled`,
  });

  return NextResponse.json({ url: checkout.url });
}
