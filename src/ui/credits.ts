/**
 * Credits, bought without leaving the studio.
 *
 * Buying credits is the only thing the account page was for, and sending
 * someone to another screen to do it means abandoning the artwork and
 * settings they have already set up. The dialog keeps them here; Whop
 * checkout opens in a popup and returns them to this same page.
 */

import { jobStart, jobEnd } from './job';

export interface Pack {
  credits: number;
  amount: number;
  label: string;
}

export interface PlanOffer {
  credits: number;
  amount: number;
  label: string;
  perMonth?: boolean;
  trialDays?: number;
}

export interface SubscriptionState {
  status: string;
  active: boolean;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  manageUrl: string | null;
}

export interface AccountInfo {
  signedIn: boolean;
  balance: number | null;
  downloads: number;
  packs: Record<string, Pack>;
  /** What a subscription would give you. Always present. */
  plan: PlanOffer | null;
  /** What you actually have, or null if you are not a subscriber. */
  subscription: SubscriptionState | null;
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
      plan: (body.plan ?? null) as PlanOffer | null,
      subscription: (body.subscription ?? null) as SubscriptionState | null,
    };
  } catch {
    return {
      signedIn: false,
      balance: null,
      downloads: 0,
      packs: {},
      plan: null,
      subscription: null,
    };
  }
}

/**
 * Show the credits dialog. Resolves with the balance when it closes, so the
 * caller can update the pill without a second round trip.
 */
export async function openCredits(
  onSignOut?: () => void,
  onSignIn?: () => void
): Promise<number | null> {
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
    const signin = document.getElementById('credits-signin') as HTMLButtonElement | null;

    const cleanup = () => {
      close.removeEventListener('click', onClose);
      signout.removeEventListener('click', onSignOutClick);
      signin?.removeEventListener('click', onSignInClick);
      document
        .getElementById('credits-plan-offer')
        ?.removeEventListener('click', onBuy);
      packButtons().forEach((b) => b.removeEventListener('click', onBuy));
    };

    const onClose = () => dlg.close();
    const onSignOutClick = () => {
      cleanup();
      dlg.close();
      onSignOut?.();
    };
    // Closes first: the sign-in sheet is itself a modal dialog, and stacking
    // one on top of another leaves the buyer looking at two overlapping
    // sheets with no obvious way back.
    const onSignInClick = () => {
      cleanup();
      dlg.close();
      onSignIn?.();
    };

    const onBuy = async (ev: Event) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      // The subscription tile and the pack tiles go through one path: the
      // server decides which plan and what metadata, so the only difference
      // here is the id sent.
      const pack = btn.dataset.pack ?? (btn.id === 'credits-plan-offer' ? 'subscription' : null);
      if (!pack) return;
      btn.disabled = true;
      const note = document.getElementById('credits-note');
      if (note) note.textContent = 'Opening checkout…';
      try {
        const res = await fetch('/api/whop/checkout', {
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
        if (note) note.textContent = 'Complete your purchase in the checkout window…';
        // Same reason as sign-in: the studio would otherwise sit silent for
        // however long checkout takes.
        jobStart(null, 'signing');
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
        jobEnd();
        btn.disabled = false;
      }
    };

    const offer = document.getElementById('credits-plan-offer') as HTMLButtonElement | null;

    close.addEventListener('click', onClose);
    signout.addEventListener('click', onSignOutClick);
    signin?.addEventListener('click', onSignInClick);
    offer?.addEventListener('click', onBuy);
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

/** Money, from cents, without a trailing .00 on round amounts. */
function price(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * The plan header: what you are on, how much is left, and when it renews.
 *
 * The bar is scaled to the subscription allowance for a subscriber and to the
 * largest pack otherwise, so "how full am I" means something in both cases.
 * It is a scale, not a cap — buying a pack on top of a subscription is
 * allowed and the number above the bar is always the real balance.
 */
function renderPlan(info: AccountInfo): void {
  const subscribed = info.subscription?.active === true;

  const badge = document.getElementById('credits-plan-badge');
  if (badge) {
    badge.textContent = subscribed ? (info.plan?.label ?? 'Subscribed') : 'Free';
    badge.classList.toggle('is-paid', subscribed);
  }

  const host = document.getElementById('mount-credit-meter');
  if (host) {
    const balance = info.balance ?? 0;
    // A subscriber's frame of reference is their monthly allowance. Everyone
    // else's is the biggest thing they could buy — otherwise the bar has no
    // meaningful full, and a full bar at 10 credits would be a lie the first
    // time they bought 200.
    const scale = subscribed && info.plan ? info.plan.credits : largestPack(info);
    void mountMeter(host, balance, Math.max(scale, balance > 0 ? 1 : 1));
  }

  const renewal = document.getElementById('credits-renewal');
  if (renewal) {
    const at = info.subscription?.renewsAt;
    if (subscribed && at) {
      const when = new Date(at).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      // "Ends" rather than "renews" when it is set to cancel: the date is the
      // same, what happens on it is the opposite, and getting that backwards
      // is how someone misses the last day to change their mind.
      renewal.textContent = info.subscription?.cancelAtPeriodEnd
        ? `Ends ${when} — credits stay on your balance`
        : `Renews ${when} · +${info.plan?.credits ?? 0} credits`;
      renewal.hidden = false;
    } else {
      renewal.hidden = true;
    }
  }

  // The offer only makes sense to someone who is not already on it.
  const offer = document.getElementById('credits-plan-offer') as HTMLButtonElement | null;
  if (offer) {
    offer.hidden = !info.signedIn || subscribed || !info.plan;
    if (info.plan) {
      setText('plan-offer-name', info.plan.label);
      setText(
        'plan-offer-credits',
        `${info.plan.credits} credits a month` +
          (info.plan.trialDays ? ` · ${info.plan.trialDays}-day free trial` : '')
      );
      setText('plan-offer-amount', price(info.plan.amount));
    }
  }

  const heading = document.getElementById('credits-pack-heading');
  if (heading) {
    heading.textContent = subscribed ? 'Top up with more credits' : 'Or buy credits once';
    heading.hidden = !info.signedIn;
  }
}

function largestPack(info: AccountInfo): number {
  const counts = Object.values(info.packs).map((p) => p.credits);
  return counts.length ? Math.max(...counts) : 200;
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/**
 * The meter is a React island, and React is not in the cutter's initial
 * bundle path for this dialog — imported lazily so opening the studio does
 * not pay for a control only the credits dialog uses.
 */
async function mountMeter(host: Element, value: number, max: number): Promise<void> {
  const { mountCreditMeter } = await import('./controls');
  mountCreditMeter(host, { value, max });
}

function render(info: AccountInfo): void {
  // Signed out, the balance sentence has nothing to say — its numbers do not
  // exist yet — so the whole sentence is swapped rather than filled with a
  // placeholder that reads as broken grammar ("Not signed in left · 0
  // downloaded").
  const lineIn = document.getElementById('credits-line-in');
  const lineOut = document.getElementById('credits-line-out');
  if (lineIn) lineIn.hidden = !info.signedIn;
  if (lineOut) lineOut.hidden = info.signedIn;

  const bal = document.getElementById('credits-balance');
  const dls = document.getElementById('credits-downloads');
  if (bal) bal.textContent = info.balance === null ? '0' : String(info.balance);
  if (dls) dls.textContent = String(info.downloads);

  renderPlan(info);

  // Exactly one of these is ever offered, and which one is the whole point:
  // signed out, every pack is disabled, so Sign in is the only thing left to
  // do here.
  const signout = document.getElementById('credits-signout') as HTMLButtonElement | null;
  if (signout) signout.hidden = !info.signedIn;
  const signin = document.getElementById('credits-signin') as HTMLButtonElement | null;
  if (signin) signin.hidden = info.signedIn;

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
    // "1.99 each" under a $1.99 single credit says nothing twice. The
    // per-credit rate is there to make the packs comparable, and a pack of
    // one has nothing to compare against itself.
    // "one-off" rather than "pay as you go": the longer phrase wrapped to two
    // lines and made this tile taller than its neighbours, breaking the row.
    per.textContent =
      pack.credits === 1
        ? 'one-off'
        : `${(pack.amount / pack.credits / 100).toFixed(2)} each`;
    btn.append(n, l, per);
    host.appendChild(btn);
  }
}
