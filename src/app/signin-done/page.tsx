/**
 * Where the sign-in popup lands.
 *
 * Google returns here after consent. This page notifies the window that
 * opened it and then closes.
 *
 * It must NEVER navigate itself to the studio. `window.close()` can be
 * refused — a popup that has navigated cross-origin and back is not always
 * script-closable — and the previous fallback of `location.replace('/')`
 * loaded the whole app inside the popup, leaving the user with the studio
 * nested in a second window while the original sat untouched behind it.
 * Showing a "you can close this" message is a far better failure than
 * silently cloning the app.
 */
export default function SignInDone() {
  return (
    <main
      style={{
        display: 'grid',
        placeItems: 'center',
        alignContent: 'center',
        gap: 10,
        minHeight: '100vh',
        margin: 0,
        padding: 24,
        textAlign: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: '#0d0d0f',
        color: '#e8e8ea',
      }}
    >
      <p style={{ margin: 0, fontSize: 15 }}>Signed in</p>
      <p id="hint" style={{ margin: 0, opacity: 0.55, fontSize: 13 }}>
        Returning to the studio…
      </p>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function () {
              // Tell the opener first: it refreshes the balance and carries on
              // with whatever the user was doing. This is the part that must
              // happen, so it runs before the close attempt.
              try {
                if (window.opener && window.opener !== window) {
                  window.opener.postMessage({ type: 'cutline:signed-in' }, window.location.origin);
                }
              } catch (e) {}

              try { window.close(); } catch (e) {}

              // If the browser refused to close us, say so rather than
              // navigating — this window is not where the user's work is.
              setTimeout(function () {
                var hint = document.getElementById('hint');
                if (hint) hint.textContent = 'You can close this window.';
              }, 800);
            })();
          `,
        }}
      />
    </main>
  );
}
