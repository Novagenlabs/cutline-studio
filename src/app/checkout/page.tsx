import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { PACKS, SUBSCRIPTION, isPackId } from '@/lib/packs';
import { createCheckoutSession } from '@/lib/whop-api';
import { CheckoutEmbed } from './embed';

export const dynamic = 'force-dynamic';

/**
 * Checkout, on its own page.
 *
 * Three approaches were possible and two of them are worse.
 *
 * A popup was what shipped first. Browsers block popups by default in enough
 * configurations that a buyer can click Buy and have nothing happen at all,
 * and COOP: same-origin on the studio severs window.opener, so the popup
 * cannot even report back — the old code could only poll for it to close and
 * then guess.
 *
 * Embedding in the credits dialog is impossible rather than merely awkward.
 * The studio is cross-origin isolated for AI matting, and COEP strips
 * credentials from cross-origin frames: Whop's checkout answers
 * ERR_BLOCKED_BY_RESPONSE inside an isolated page. Verified, not assumed.
 * Dropping isolation to embed would cost multithreaded matting.
 *
 * So: a dedicated route, deliberately OUTSIDE the isolation scope in
 * next.config.ts, carrying Whop's official embed. This is also what most
 * checkout flows do, for the same reason — a payment surface wants a page of
 * its own, not a corner of an application.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ pack?: string }>;
}) {
  const session = await auth();
  const { pack } = await searchParams;

  // Nothing to attach a purchase to. Send them to the studio rather than to
  // /api/auth/signin: that endpoint answers a GET with Auth.js's own sign-in
  // page only in some configurations, and rejects it as an unknown action in
  // others. The studio's sign-in sheet is the path that is actually tested,
  // and it returns here afterwards.
  if (!session?.user?.id) {
    redirect(`/?signin=1&pack=${encodeURIComponent(pack ?? '')}`);
  }

  const isSubscription = pack === 'subscription';
  const item = isSubscription ? SUBSCRIPTION : isPackId(pack) ? PACKS[pack] : null;

  if (!item) {
    return (
      <main style={S.main}>
        <div style={S.card}>
          <h1 style={S.h1}>Nothing to buy</h1>
          <p style={S.sub}>That link does not name a credit pack.</p>
          <a href="/" style={S.back}>← Back to the studio</a>
        </div>
      </main>
    );
  }

  const price = (item.amount / 100).toFixed(2);

  // Created here, on the server, because this is what carries the metadata
  // that binds the payment to an account. The embed has no metadata
  // attribute — pointing it at a session is the only way to attach one — and
  // resolving userId anywhere the browser could reach would let a buyer
  // credit someone else.
  const appUrl = process.env.APP_URL ?? '';
  let sessionId: string | null = null;
  try {
    if (process.env.WHOP_API_KEY) {
      const checkout = await createCheckoutSession({
        planId: item.whopPlanId,
        // Whop rejects any redirect URL that is not https, so a local
        // APP_URL of http://localhost:3000 fails session creation outright
        // and checkout cannot be exercised in development at all. The embed
        // uses an on-complete callback rather than the redirect anyway
        // (skip-redirect is set), so omitting it locally costs nothing.
        redirectUrl: appUrl.startsWith('https://')
          ? `${appUrl}/?purchase=success`
          : undefined,
        metadata: isSubscription
          ? { userId: session.user.id, kind: 'subscription' }
          : {
              userId: session.user.id,
              pack: pack as string,
              credits: String(item.credits),
            },
      });
      sessionId = checkout.id;
    } else {
      console.error('WHOP_API_KEY is not set — /checkout cannot create a session');
    }
  } catch (err) {
    // Rendered as a "checkout unavailable" state rather than a crash: the
    // buyer needs to know nothing was charged, which a 500 does not say.
    console.error('Whop checkout session failed', err);
  }

  return (
    <main style={S.main}>
      <div style={S.card}>
        <a href="/" style={S.back}>← Back to the studio</a>

        <h1 style={S.h1}>{isSubscription ? `${item.label} subscription` : item.label}</h1>
        <p style={S.sub}>
          {isSubscription
            ? `$${price} per month · ${item.credits} credits each month`
            : `$${price} · ${item.credits} export ${item.credits === 1 ? 'credit' : 'credits'}`}
        </p>

        {/* The credits are granted by the webhook, not by this page finishing.
            Saying so here is the difference between "it worked" and a support
            ticket when the balance takes a few seconds to move. */}
        <p style={S.note}>
          Credits are added as soon as the payment is confirmed. You will come
          straight back to the studio.
        </p>

        <CheckoutEmbed
          sessionId={sessionId}
          planId={item.whopPlanId}
          credits={item.credits}
          email={session.user.email}
        />
      </div>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100vh',
    background: '#0a0a0b',
    color: '#f5f5f7',
    fontFamily: 'Inter, system-ui, sans-serif',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '40px 20px',
  },
  card: { width: '100%', maxWidth: 560 },
  back: {
    display: 'inline-block',
    color: '#8a8a90',
    fontSize: 13,
    textDecoration: 'none',
    marginBottom: 22,
  },
  h1: { fontSize: 22, fontWeight: 600, margin: '0 0 6px' },
  sub: { fontSize: 14, color: '#a5a5ac', margin: '0 0 4px' },
  note: { fontSize: 12, color: '#8a8a90', margin: '14px 0 18px', lineHeight: 1.6 },
};
