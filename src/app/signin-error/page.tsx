import { cookies } from 'next/headers';

/**
 * Where a failed sign-in lands.
 *
 * Auth.js's own error page says "Server error — there is a problem with the
 * server configuration", which is what users reported. It is also a dead
 * end: no way to try again, and inside the sign-in popup no way back at all.
 *
 * The failures that reach here are almost all recoverable by simply trying
 * again — the OAuth round trip has a 15-minute cookie, and a user who left
 * Google's consent screen open longer than that arrives here. So this page
 * says what happened in plain words and offers the retry right here, as the
 * same CSRF-protected POST the studio uses to start a sign-in.
 *
 * POPUP OR TAB. The studio starts sign-in in a popup that returns to
 * /signin-done; a blocked popup falls back to signing in in the tab. The two
 * need different retries (return to /signin-done vs. to the studio) and a
 * different second control (close vs. go back), and neither window.opener
 * nor window.name can be relied on to tell them apart: Safari severs the
 * opener after the Google round trip, and a COOP browsing-context switch
 * clears the name. What survives is Auth.js's own callback-url cookie, set
 * when the sign-in STARTED and naming where it was meant to end up — so the
 * server reads that. window.name is kept as a second opinion only.
 *
 * Like /signin-done, this page must never navigate the popup to the studio —
 * that loads the whole app inside a second window (see signin-done/page.tsx).
 */

// The values Auth.js puts in ?error= for its error page. Anything it does
// not consider safe to show a user (which includes the PKCE check) arrives
// as "Configuration".
const COPY: Record<string, { title: string; body: string }> = {
  AccessDenied: {
    title: 'Sign-in was cancelled',
    body: 'Google did not grant access, so nothing was changed. You can try again whenever you like.',
  },
  Verification: {
    title: 'That sign-in link has expired',
    body: 'Sign-in links work once and for a limited time. Request a new one and use it straight away.',
  },
  Configuration: {
    title: 'Sign-in did not complete',
    body:
      'This usually happens when the Google window was left open for more than ' +
      '15 minutes, or sign-in was started twice. Trying again almost always works.',
  },
};

const DEFAULT = {
  title: 'Sign-in did not complete',
  body: 'Something interrupted the sign-in. Trying again almost always works.',
};

/** Did this sign-in start from the popup? Auth.js recorded where it was headed. */
async function startedInPopup(): Promise<boolean> {
  const store = await cookies();
  // Secure-prefixed over https, bare over http (local dev).
  const value =
    store.get('__Secure-authjs.callback-url')?.value ?? store.get('authjs.callback-url')?.value;
  return typeof value === 'string' && value.includes('/signin-done');
}

export default async function SignInError({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const code = typeof error === 'string' ? error : 'Default';
  const copy = COPY[code] ?? DEFAULT;
  const popup = await startedInPopup();

  const button: React.CSSProperties = {
    font: 'inherit',
    fontSize: 13,
    padding: '9px 16px',
    borderRadius: 8,
    border: '1px solid #3a3a40',
    background: '#e8e8ea',
    color: '#0d0d0f',
    cursor: 'pointer',
  };

  return (
    <main
      data-popup={popup ? '1' : '0'}
      style={{
        display: 'grid',
        placeItems: 'center',
        alignContent: 'center',
        gap: 12,
        minHeight: '100vh',
        margin: 0,
        padding: 24,
        textAlign: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: '#0d0d0f',
        color: '#e8e8ea',
      }}
    >
      <p style={{ margin: 0, fontSize: 15 }}>{copy.title}</p>
      <p style={{ margin: 0, opacity: 0.65, fontSize: 13, maxWidth: 420, lineHeight: 1.5 }}>
        {copy.body}
      </p>
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        <button id="retry" type="button" style={button}>
          Try again
        </button>
        <a
          id="back"
          href="/"
          style={{ ...button, background: 'transparent', color: '#e8e8ea', textDecoration: 'none' }}
        >
          {popup ? 'Close this window' : 'Back to the studio'}
        </a>
      </div>
      {/* Small and quiet: only useful to someone reporting a problem. */}
      <p style={{ margin: '14px 0 0', opacity: 0.35, fontSize: 11 }}>code: {code}</p>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function () {
              var retry = document.getElementById('retry');
              var back = document.getElementById('back');
              var inPopup =
                document.querySelector('main').dataset.popup === '1' ||
                window.name === 'cutline-signin';

              retry.addEventListener('click', async function () {
                retry.disabled = true;
                retry.textContent = 'Opening Google…';
                try {
                  // Auth.js needs a POST with a CSRF token to start a sign-in;
                  // a bare navigation to the sign-in URL is an UnknownAction.
                  var res = await fetch('/api/auth/csrf', { credentials: 'include' });
                  var csrfToken = (await res.json()).csrfToken;
                  var form = document.createElement('form');
                  form.method = 'POST';
                  form.action = '/api/auth/signin/google';
                  var fields = {
                    csrfToken: csrfToken,
                    callbackUrl: window.location.origin + (inPopup ? '/signin-done' : '/'),
                  };
                  for (var name in fields) {
                    var input = document.createElement('input');
                    input.type = 'hidden';
                    input.name = name;
                    input.value = fields[name];
                    form.appendChild(input);
                  }
                  document.body.appendChild(form);
                  form.submit();
                } catch (e) {
                  retry.disabled = false;
                  retry.textContent = 'Try again';
                }
              });

              if (inPopup) {
                // The studio is in the window behind this one; "back" would
                // load a second copy of it in here. Close instead — and say so
                // if the browser refuses, which it can for a popup that has
                // been to another origin and back.
                back.textContent = 'Close this window';
                back.addEventListener('click', function (ev) {
                  ev.preventDefault();
                  try { window.close(); } catch (e) {}
                  setTimeout(function () { back.textContent = 'You can close this window'; }, 600);
                });
              }
            })();
          `,
        }}
      />
    </main>
  );
}
