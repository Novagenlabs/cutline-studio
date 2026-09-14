'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Whop's checkout embed, with the loading, error and completion states it
 * does not provide itself.
 *
 * The embed is a script that finds a div by data attributes and replaces it
 * with an iframe. That leaves gaps worth filling: the seconds before the
 * iframe appears, which are otherwise a blank rectangle; a payment error,
 * which the iframe reports through a callback and nothing else; and the
 * moment after payment, where the default is a redirect that would land the
 * buyer on a page rather than back in their work.
 *
 * The session id is the important prop. Metadata is NOT an embed attribute —
 * it is attached when the checkout session is created server-side, and
 * `data-whop-checkout-session` points the iframe at that session. Passing
 * metadata here instead would be silently ignored, and the payment webhook
 * would arrive with no userId to credit.
 *
 * Callbacks are named on `window` because the script resolves them by string
 * at the moment it needs them, so they cannot be passed as props.
 */
export function CheckoutEmbed({
  sessionId,
  planId,
  credits,
  email,
}: {
  sessionId: string | null;
  planId: string;
  credits: number;
  email?: string | null;
}) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'done' | 'slow'>('loading');
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;

    w.__cutlineCheckoutDone = () => {
      setPhase('done');
      // Back to the studio with a flag it reads to refresh the balance. The
      // webhook may not have landed yet, which is why the studio re-reads
      // rather than trusting this redirect to mean credits exist.
      setTimeout(() => {
        window.location.href = '/?purchase=success';
      }, 1500);
    };

    w.__cutlineCheckoutError = (msg: unknown) => {
      setError(typeof msg === 'string' && msg ? msg : 'That payment did not go through.');
    };

    const el = host.current;
    if (!el) return;

    // Watch for the iframe rather than guessing at a load time: a fixed
    // timeout either flashes the spinner or leaves a dead gap after it.
    const seen = new MutationObserver(() => {
      if (el.querySelector('iframe')) {
        setPhase((p) => (p === 'done' ? p : 'ready'));
        seen.disconnect();
      }
    });
    seen.observe(el, { childList: true, subtree: true });

    // If the script never runs — an ad blocker, a dead network — say so
    // rather than spinning forever.
    const giveUp = window.setTimeout(() => {
      if (!el.querySelector('iframe')) setPhase((p) => (p === 'loading' ? 'slow' : p));
    }, 12_000);

    return () => {
      seen.disconnect();
      clearTimeout(giveUp);
      delete w.__cutlineCheckoutDone;
      delete w.__cutlineCheckoutError;
    };
  }, []);

  if (!sessionId) {
    return (
      <div style={S.problem}>
        <p style={S.problemTitle}>Checkout is unavailable</p>
        <p style={S.problemSub}>
          We could not start a payment session. Nothing has been charged — please
          try again in a moment.
        </p>
        <a href="/" style={S.link}>← Back to the studio</a>
      </div>
    );
  }

  return (
    <div>
      {phase === 'done' ? (
        <div style={S.done}>
          <p style={S.doneTitle}>Payment received</p>
          <p style={S.doneSub}>
            Adding {credits} {credits === 1 ? 'credit' : 'credits'} and taking you
            back to the studio…
          </p>
        </div>
      ) : null}

      {error ? (
        <div style={S.error} role="alert">
          {error} You have not been charged.
        </div>
      ) : null}

      <div style={{ display: phase === 'done' ? 'none' : 'block' }}>
        {phase === 'loading' ? (
          <div style={S.loading}>
            <span style={S.spinner} aria-hidden="true" />
            <span>Opening secure checkout…</span>
          </div>
        ) : null}

        {phase === 'slow' ? (
          <div style={S.problem}>
            <p style={S.problemTitle}>Checkout is taking longer than expected</p>
            <p style={S.problemSub}>
              If it does not appear, an ad blocker or extension may be blocking
              the payment form. Nothing has been charged.
            </p>
            <a href="/" style={S.link}>← Back to the studio</a>
          </div>
        ) : null}

        <div
          ref={host}
          // The session carries the plan AND the metadata that binds this
          // payment to an account; plan-id is kept alongside it because the
          // embed wants one to render before the session resolves.
          data-whop-checkout-session={sessionId}
          data-whop-checkout-plan-id={planId}
          data-whop-checkout-theme="dark"
          data-whop-checkout-theme-accent-color="orange"
          data-whop-checkout-on-complete="__cutlineCheckoutDone"
          data-whop-checkout-on-payment-error="__cutlineCheckoutError"
          data-whop-checkout-skip-redirect="true"
          {...(email ? { 'data-whop-checkout-prefill-email': email } : {})}
        />
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '40px 0',
    color: '#8a8a90',
    fontSize: 13,
  },
  spinner: {
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: '2px solid #2a2a2e',
    borderTopColor: '#ff9f0a',
    animation: 'cutline-spin 700ms linear infinite',
    display: 'inline-block',
  },
  done: { padding: '34px 0', textAlign: 'center' },
  doneTitle: { fontSize: 16, fontWeight: 600, color: '#ff9f0a', margin: '0 0 6px' },
  doneSub: { fontSize: 13, color: '#a5a5ac', margin: 0 },
  error: {
    padding: '11px 13px',
    marginBottom: 14,
    borderRadius: 8,
    border: '1px solid rgba(255,107,107,0.4)',
    background: 'rgba(255,107,107,0.1)',
    color: '#ff9b9b',
    fontSize: 12.5,
    lineHeight: 1.5,
  },
  problem: { padding: '30px 0' },
  problemTitle: { fontSize: 15, fontWeight: 600, margin: '0 0 6px' },
  problemSub: { fontSize: 13, color: '#a5a5ac', margin: '0 0 14px', lineHeight: 1.6 },
  link: { color: '#ff9f0a', fontSize: 13, textDecoration: 'none' },
};
