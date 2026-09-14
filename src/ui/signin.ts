/**
 * Sign-in, without leaving the studio.
 *
 * A signed-out download used to show an error toast with a link that opened
 * the account page in another tab — which abandons the artwork the user had
 * just set up, and leaves them to find their way back. The modal keeps them
 * on the page, and Google returns them here rather than to the account.
 *
 * The state that matters (the loaded image and every slider) lives in this
 * page, so a full-page redirect would lose it. Sign-in therefore happens in a
 * popup and this page simply re-checks the balance when it closes.
 */

import { jobStart, jobEnd } from './job';
import { mountButton } from './controls';

export type SigninOutcome = 'signed-in' | 'dismissed';

/**
 * Google's mark, in its own colours.
 *
 * Google's branding guidelines require the official four-colour glyph on a
 * "Sign in with Google" button rather than a monochrome approximation, so
 * this is the one icon in the app that is not drawn in `currentColor`.
 */
const GOOGLE_MARK = `<svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true">
  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
  <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/>
  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
</svg>`;

export async function promptSignIn(grant?: number): Promise<SigninOutcome> {
  const dlg = document.getElementById('signin-sheet') as HTMLDialogElement | null;
  if (!dlg || typeof dlg.showModal !== 'function') {
    // No <dialog> support: fall back to sending them to the account page
    // rather than silently doing nothing.
    window.location.href = '/account';
    return 'dismissed';
  }

  if (grant != null) {
    const el = document.getElementById('signin-grant');
    if (el) el.textContent = String(grant);
  }

  const goHost = document.getElementById('mount-signin-go');
  const cancelHost = document.getElementById('mount-signin-cancel');

  return new Promise<SigninOutcome>((resolve) => {
    let settled = false;
    // Set once the Google popup is open. The dialog is closed at that point
    // so the status banner behind it is visible, and its `close` event must
    // not then be read as the user cancelling a sign-in already under way.
    let started = false;
    let busy = false;

    /**
     * Redraw both buttons from the current state.
     *
     * The buttons are React mounts, so "disable it and change the label" is a
     * re-render rather than a mutation. Keeping all of it in one function
     * means the two buttons cannot disagree about whether a sign-in is in
     * flight — the old code disabled one and left the other live.
     */
    const draw = () => {
      if (goHost) {
        mountButton(goHost, {
          // Keeps the id the markup used to carry, so anything holding a
          // handle to it — tests, automation — still finds the button.
          id: 'signin-go',
          label: busy ? 'Opening Google…' : 'Sign in with Google',
          iconSvg: busy ? undefined : GOOGLE_MARK,
          variant: 'primary',
          busy,
          onClick: () => void onGo(),
        });
      }
      if (cancelHost) {
        mountButton(cancelHost, {
          id: 'signin-cancel',
          label: 'Not now',
          variant: 'ghost',
          // Cancelling mid-popup would leave the popup orphaned and the
          // promise unresolved, so it is out of reach while busy.
          disabled: busy,
          onClick: onCancel,
        });
      }
    };

    const finish = (outcome: SigninOutcome) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      resolve(outcome);
    };

    const onCancel = () => finish('dismissed');

    const onGo = async () => {
      if (busy) return;
      busy = true;
      draw();
      try {
        const popup = await openSignInPopup();
        if (!popup) {
          // Popups blocked — sign in in this tab instead of leaving a dead
          // button. It must be a POST with a CSRF token: navigating to
          // /api/auth/signin/google with a GET is an "UnknownAction" as far
          // as Auth.js is concerned, which is what this used to do and why
          // the fallback path reported a configuration error rather than
          // signing anyone in.
          await postToSignIn();
          return;
        }

        // The modal closes as soon as the popup opens, so the studio is
        // visible behind it — and would otherwise be showing nothing at all
        // while Google runs. The banner is what says the app is still waiting.
        started = true;
        if (dlg.open) dlg.close();
        jobStart(null, 'signing');

        // The popup posts a message when Google returns, then closes itself.
        // Waiting on the message rather than on `popup.closed` matters
        // because a browser can refuse to close the popup — polling alone
        // would hang forever on a sign-in that actually succeeded.
        await new Promise<void>((done) => {
          let settled = false;
          const stop = () => {
            if (settled) return;
            settled = true;
            window.removeEventListener('message', onMessage);
            clearInterval(poll);
            done();
          };
          const onMessage = (ev: MessageEvent) => {
            if (ev.origin !== window.location.origin) return;
            if ((ev.data as { type?: string })?.type === 'cutline:signed-in') stop();
          };
          window.addEventListener('message', onMessage);
          // Still watch for a manual close, which is how a cancelled sign-in
          // ends — no message is ever posted in that case.
          const poll = window.setInterval(() => {
            if (popup.closed) stop();
          }, 400);
        });
        finish('signed-in');
      } finally {
        jobEnd();
        busy = false;
        // Only worth redrawing if the dialog is still up; a settled sign-in
        // has already closed it and the mounts are about to be replaced.
        if (!settled) draw();
      }
    };

    draw();
    dlg.addEventListener('close', () => {
      if (!started) finish('dismissed');
    }, { once: true });
    dlg.showModal();
  });
}

/**
 * Auth.js requires a CSRF token and a POST to start a provider sign-in, so the
 * popup is handed a generated form rather than a bare URL.
 */
/**
 * Sign out, for real.
 *
 * Auth.js requires a CSRF token on POST /api/auth/signout. Without one it
 * still answers 302 — so a bare fetch looks like it worked — but it does not
 * clear the cookie and does not delete the session row, and /api/me keeps
 * reporting signedIn: true. Verified against production both ways: no token
 * leaves all three untouched, with a token all three flip.
 *
 * That is what made "sign out" appear to do nothing: the page reloaded, the
 * browser presented the same cookie, and the session was still live.
 *
 * Submitting a form rather than fetching, so the browser performs the
 * navigation and applies the Set-Cookie that clears the session — a fetch
 * would apply it too, but then the page has to reload anyway and a
 * half-finished fetch on unload is a race this does not need.
 */
export async function signOutNow(): Promise<void> {
  const res = await fetch('/api/auth/csrf', { credentials: 'include' });
  const { csrfToken } = (await res.json()) as { csrfToken: string };

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/auth/signout';
  for (const [name, value] of [
    ['csrfToken', csrfToken],
    ['callbackUrl', '/'],
  ]) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/**
 * Sign in in this tab, for when a popup is refused.
 *
 * Auth.js accepts sign-in only as a POST carrying a CSRF token — a plain
 * navigation to the same URL is rejected as an unknown action, which is what
 * this fallback used to do. Submitting a real form is the same thing the
 * popup path does, minus the popup.
 *
 * The callback is the studio rather than /signin-done: there is no opener to
 * report back to, so the browser should simply land back where it started.
 */
async function postToSignIn(): Promise<void> {
  const res = await fetch('/api/auth/csrf', { credentials: 'include' });
  const { csrfToken } = (await res.json()) as { csrfToken: string };

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/auth/signin/google';
  for (const [name, value] of [
    ['csrfToken', csrfToken],
    ['callbackUrl', window.location.href],
  ]) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

async function openSignInPopup(): Promise<Window | null> {
  const res = await fetch('/api/auth/csrf', { credentials: 'include' });
  const { csrfToken } = (await res.json()) as { csrfToken: string };

  const w = 500;
  const h = 640;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  const popup = window.open(
    '',
    'cutline-signin',
    `width=${w},height=${h},left=${left},top=${top}`
  );
  if (!popup) return null;

  const form = popup.document.createElement('form');
  form.method = 'POST';
  form.action = '/api/auth/signin/google';
  for (const [name, value] of [
    ['csrfToken', csrfToken],
    // Return to the studio, not the account page: the artwork and settings
    // are here.
    ['callbackUrl', window.location.origin + '/signin-done'],
  ]) {
    const input = popup.document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  popup.document.body.appendChild(form);
  form.submit();
  return popup;
}
