import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { PACKS } from '@/lib/packs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

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
