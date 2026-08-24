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

export type SigninOutcome = 'signed-in' | 'dismissed';

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

  const go = document.getElementById('signin-go') as HTMLButtonElement;
  const cancel = document.getElementById('signin-cancel') as HTMLButtonElement;

  return new Promise<SigninOutcome>((resolve) => {
    let settled = false;
    // Set once the Google popup is open. The dialog is closed at that point
    // so the status banner behind it is visible, and its `close` event must
    // not then be read as the user cancelling a sign-in already under way.
    let started = false;
    const finish = (outcome: SigninOutcome) => {
      if (settled) return;
      settled = true;
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      if (dlg.open) dlg.close();
      resolve(outcome);
    };

    const onCancel = () => finish('dismissed');

    const onGo = async () => {
      go.disabled = true;
      const label = go.textContent;
      go.textContent = 'Opening Google…';
      try {
        const popup = await openSignInPopup();
        if (!popup) {
          // Popups blocked — a same-tab redirect is better than a dead button.
          window.location.href = '/api/auth/signin/google';
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
        go.disabled = false;
        go.textContent = label;
      }
    };

    go.addEventListener('click', onGo);
    cancel.addEventListener('click', onCancel);
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
