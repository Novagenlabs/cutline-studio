/**
 * A full-surface loading state, for waits that block the whole workspace.
 *
 * This is the heavier sibling of the job banner. The banner annotates a
 * working app — you can still see your artwork behind it. This covers the
 * canvas, and is for the cases where there is genuinely nothing to look at
 * yet or nothing useful to do: first boot before the session is known, and
 * the AI matting model download, which is tens of megabytes and takes long
 * enough that an unexplained frozen canvas reads as a crash.
 *
 * It uses the same cut mark as everything else, so a wait looks like the same
 * product whichever wait it is.
 */
import { createCutMark, type CutMark } from './cutmark';

let host: HTMLElement | null = null;
let mark: CutMark | null = null;
let label: HTMLElement | null = null;
let depth = 0;

function build(): HTMLElement {
  if (host) return host;

  host = document.createElement('div');
  host.className = 'loading';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');

  const box = document.createElement('div');
  box.className = 'loading-box';

  mark = createCutMark(40);
  box.append(mark.el);

  label = document.createElement('span');
  label.className = 'loading-text';
  box.append(label);

  host.append(box);
  document.body.append(host);
  return host;
}

/**
 * Show the overlay with a message, and return the function that hides it.
 *
 * Returning the closer rather than exposing a bare `hide()` means a caller
 * cannot dismiss someone else's wait: nested waits are counted, and the
 * overlay lifts when the last one finishes. Each closer is idempotent, so a
 * `finally` that runs twice cannot drive the count negative.
 */
export function showLoading(text: string): () => void {
  const root = build();
  if (label) label.textContent = text;

  depth++;
  root.classList.add('is-on');
  mark?.start();

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    depth = Math.max(0, depth - 1);
    if (depth > 0) return;
    root.classList.remove('is-on');
    mark?.stop();
  };
}

/** Update the message of an overlay that is already up. */
export function loadingText(text: string): void {
  if (label && depth > 0) label.textContent = text;
}
