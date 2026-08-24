/**
 * Toasts.
 *
 * The previous implementation reused one element and one timer, so a second
 * message overwrote the first and reset its clock — a download confirmation
 * could erase the error explaining why the previous one failed. These stack,
 * each with its own lifetime, and identical repeats collapse into a counter
 * rather than filling the screen.
 */

export type ToastKind = 'info' | 'success' | 'error';

interface Live {
  el: HTMLElement;
  text: string;
  timer: number;
  count: number;
}

const live: Live[] = [];
const MAX = 4;

function host(): HTMLElement {
  let el = document.getElementById('toasts');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toasts';
    el.className = 'toasts';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

export function toast(
  text: string,
  kind: ToastKind = 'info',
  ms = 5000,
  action?: { label: string; onClick: () => void }
): void {
  // Repeating the same message is almost always the same cause firing twice;
  // showing it once with a count is more readable than a stack of duplicates.
  const dupe = live.find((t) => t.text === text);
  if (dupe) {
    dupe.count++;
    const badge = dupe.el.querySelector('.toast-count');
    if (badge) badge.textContent = `x${dupe.count}`;
    else {
      const b = document.createElement('span');
      b.className = 'toast-count';
      b.textContent = `x${dupe.count}`;
      dupe.el.appendChild(b);
    }
    clearTimeout(dupe.timer);
    dupe.timer = window.setTimeout(() => dismiss(dupe), ms);
    return;
  }

  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = kind === 'error' ? '!' : kind === 'success' ? '✓' : 'i';
  el.appendChild(icon);

  const body = document.createElement('span');
  body.className = 'toast-text';
  body.textContent = text;
  el.appendChild(body);

  const entry: Live = { el, text, timer: 0, count: 1 };

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      dismiss(entry);
    });
    el.appendChild(btn);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => dismiss(entry));
  el.appendChild(close);

  host().appendChild(el);
  live.push(entry);

  // An error the user has not read yet should not be pushed off by newer
  // noise, so the oldest goes first and errors are never auto-dismissed.
  while (live.length > MAX) dismiss(live[0]);

  if (kind !== 'error' || ms > 0) {
    entry.timer = window.setTimeout(() => dismiss(entry), kind === 'error' ? Math.max(ms, 8000) : ms);
  }
}

function dismiss(entry: Live): void {
  const i = live.indexOf(entry);
  if (i < 0) return;
  live.splice(i, 1);
  clearTimeout(entry.timer);
  entry.el.classList.add('leaving');
  // Let the exit transition finish before removing, so a dismissal reads as
  // deliberate rather than as the element vanishing.
  setTimeout(() => entry.el.remove(), 180);
}
