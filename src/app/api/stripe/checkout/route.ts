import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { auth } from '@/lib/auth';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/**
 * Credit packs, defined server-side.
 *
 * The client sends a pack id, never a price or a credit count. If it sent
 * either, a user could ask for 10000 credits at $1 and Stripe would happily
 * charge exactly what it was told.
 */
export const PACKS = {
  starter: { credits: 10, amount: 900, label: '10 credits' },
  pro: { credits: 50, amount: 3500, label: '50 credits' },
  studio: { credits: 200, amount: 11000, label: '200 credits' },
} as const;

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
  const pack = PACKS[parsed.data.pack];

  const checkout = await stripe.checkout.sessions.create({
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
