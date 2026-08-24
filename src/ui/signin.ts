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
        // Wait for the popup to finish; it lands back on this origin, so its
        // closing is the signal that the round trip is over.
        await new Promise<void>((done) => {
          const poll = window.setInterval(() => {
            if (popup.closed) {
              clearInterval(poll);
              done();
            }
          }, 400);
        });
        finish('signed-in');
      } finally {
        go.disabled = false;
        go.textContent = label;
      }
    };

    go.addEventListener('click', onGo);
    cancel.addEventListener('click', onCancel);
    dlg.addEventListener('close', () => finish('dismissed'), { once: true });
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
