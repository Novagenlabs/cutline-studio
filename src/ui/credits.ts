/**
 * Credits, bought without leaving the studio.
 *
 * Buying credits is the only thing the account page was for, and sending
 * someone to another screen to do it means abandoning the artwork and
 * settings they have already set up. The dialog keeps them here; Stripe
 * Checkout opens in a popup and returns them to this same page.
 */

export interface Pack {
  credits: number;
  amount: number;
  label: string;
}

export interface AccountInfo {
  signedIn: boolean;
  balance: number | null;
  downloads: number;
  packs: Record<string, Pack>;
}

export async function fetchAccount(): Promise<AccountInfo> {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    const body = await res.json();
    return {
      signedIn: !!body.signedIn,
      balance: typeof body.balance === 'number' ? body.balance : null,
      downloads: typeof body.downloads === 'number' ? body.downloads : 0,
      packs: (body.packs ?? {}) as Record<string, Pack>,
    };
  } catch {
    return { signedIn: false, balance: null, downloads: 0, packs: {} };
  }
}

/**
 * Show the credits dialog. Resolves with the balance when it closes, so the
 * caller can update the pill without a second round trip.
 */
export async function openCredits(onSignOut?: () => void): Promise<number | null> {
  const dlg = document.getElementById('credits-sheet') as HTMLDialogElement | null;
  if (!dlg || typeof dlg.showModal !== 'function') {
    window.location.href = '/account';
    return null;
  }

  const info = await fetchAccount();
  render(info);
  dlg.showModal();

  return new Promise<number | null>((resolve) => {
    const close = document.getElementById('credits-close') as HTMLButtonElement;
    const signout = document.getElementById('credits-signout') as HTMLButtonElement;

    const cleanup = () => {
      close.removeEventListener('click', onClose);
      signout.removeEventListener('click', onSignOutClick);
      packButtons().forEach((b) => b.removeEventListener('click', onBuy));
    };

    const onClose = () => dlg.close();
    const onSignOutClick = () => {
      cleanup();
      dlg.close();
      onSignOut?.();
    };

    const onBuy = async (ev: Event) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      const pack = btn.dataset.pack;
      if (!pack) return;
      btn.disabled = true;
      const note = document.getElementById('credits-note');
      if (note) note.textContent = 'Opening Stripe…';
      try {
        const res = await fetch('/api/stripe/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ pack }),
        });
        const { url, error } = await res.json();
        if (!url) throw new Error(error ?? 'Could not start checkout.');
        // Checkout in a popup, so the studio and its artwork stay loaded.
        const w = window.open(url, 'cutline-checkout', 'width=520,height=760');
        if (!w) {
          window.location.href = url;
          return;
        }
        if (note) note.textContent = 'Complete your purchase in the Stripe window…';
        await new Promise<void>((done) => {
          const poll = window.setInterval(() => {
            if (w.closed) {
              clearInterval(poll);
              done();
            }
          }, 500);
        });
        // Re-read rather than assume: the webhook is what grants credits, and
        // it may not have arrived by the time the window closes.
        const after = await fetchAccount();
        render(after);
        if (note) {
          note.textContent =
            after.balance !== null && info.balance !== null && after.balance > info.balance
              ? 'Credits added.'
              : 'If your credits do not appear in a moment, refresh — payment confirmation can lag slightly.';
        }
      } catch (err) {
        if (note) note.textContent = err instanceof Error ? err.message : 'Checkout failed.';
      } finally {
        btn.disabled = false;
      }
    };

    close.addEventListener('click', onClose);
    signout.addEventListener('click', onSignOutClick);
    packButtons().forEach((b) => b.addEventListener('click', onBuy));

    dlg.addEventListener(
      'close',
      async () => {
        cleanup();
        resolve((await fetchAccount()).balance);
      },
      { once: true }
    );
  });
}

function packButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('#credits-packs .pack'));
}

function render(info: AccountInfo): void {
  const bal = document.getElementById('credits-balance');
  const dls = document.getElementById('credits-downloads');
  if (bal) bal.textContent = info.balance === null ? 'Not signed in' : `${info.balance} credits`;
  if (dls) dls.textContent = String(info.downloads);

  const signout = document.getElementById('credits-signout') as HTMLButtonElement | null;
  if (signout) signout.hidden = !info.signedIn;

  const host = document.getElementById('credits-packs');
  if (!host) return;
  host.innerHTML = '';
  for (const [id, pack] of Object.entries(info.packs)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pack';
    btn.dataset.pack = id;
    // Signed out there is nothing to attach a purchase to.
    btn.disabled = !info.signedIn;
    const n = document.createElement('span');
    n.className = 'pack-credits';
    n.textContent = String(pack.credits);
    const l = document.createElement('span');
    l.className = 'pack-price';
    l.textContent = `$${(pack.amount / 100).toFixed(2)}`;
    const per = document.createElement('span');
    per.className = 'pack-per';
    per.textContent = `${(pack.amount / pack.credits / 100).toFixed(2)} each`;
    btn.append(n, l, per);
    host.appendChild(btn);
  }
}
