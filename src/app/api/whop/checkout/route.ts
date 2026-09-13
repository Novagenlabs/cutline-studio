import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { PACKS } from '@/lib/packs';
import { createCheckoutSession } from '@/lib/whop-api';

/**
 * Buy a credit pack through Whop.
 *
 * The same shape as the Stripe route it replaces, and deliberately so — the
 * one property worth preserving is that the browser sends a pack id and
 * nothing else. Price, credit count and the buyer's identity are all resolved
 * here from the session and from PACKS, because a client that could name its
 * own price or its own userId would eventually be asked to.
 *
 * The userId goes into the checkout session's metadata, which Whop echoes
 * back on the resulting payment webhook. That is the whole binding between a
 * payment and an account: it is set server-side, so a buyer cannot redirect
 * someone else's credits to themselves by editing a request.
 */
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

  // Deploying before the Whop key is set is a normal state — the cutter and
  // the free signup credits work without it. Say so plainly rather than
  // failing with a stack trace.
  if (!process.env.WHOP_API_KEY) {
    return NextResponse.json(
      { error: 'Buying credits is not available yet. Please contact us.' },
      { status: 503 }
    );
  }

  const packId = parsed.data.pack;
  const pack = PACKS[packId];

  try {
    const checkout = await createCheckoutSession({
      planId: pack.whopPlanId,
      redirectUrl: `${process.env.APP_URL}/account?purchase=success`,
      // Read back by the webhook to know who to credit and how much. Strings
      // throughout: Whop returns metadata as it was sent, and a number that
      // survives one round trip as a string and another as a number is a bug
      // waiting for the day someone buys the 200 pack.
      metadata: {
        userId: session.user.id,
        pack: packId,
        credits: String(pack.credits),
      },
    });
    return NextResponse.json({ url: checkout.purchaseUrl });
  } catch (err) {
    console.error('Whop checkout failed', err);
    return NextResponse.json(
      { error: 'Could not start checkout. Please try again.' },
      { status: 502 }
    );
  }
}
