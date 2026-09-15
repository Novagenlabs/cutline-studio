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

/**
 * Turn a worker progress message into something worth showing a user.
 *
 * The worker reports real stages, and for the download a real percentage
 * computed from Content-Length against bytes read. That percentage is the one
 * piece the user genuinely needs: the model is tens of megabytes, and on a
 * slow connection a silent "Removing the background" for two minutes is
 * indistinguishable from a hang.
 *
 * Everything else is rewritten rather than passed through. The raw messages
 * name the execution backend (webgpu/wasm), which is implementation detail
 * the user did not ask about, and the stage names would otherwise flicker
 * past too fast to read. Returning null means "leave the caption alone".
 */
export function humaneProgress(msg: string, base: string): string | null {
  if (/download/i.test(msg)) {
    // Said plainly, because the honest answer to "why is this slow" is that
    // it is fetching the model, and it only happens once.
    const pct = /(\d{1,3})\s*%/.exec(msg);
    if (pct) return `Downloading the AI model — ${pct[1]}% (one time only)`;
    // No Content-Length upstream, so the worker counts megabytes instead.
    const mb = /([\d.]+)\s*MB/i.exec(msg);
    if (mb) return `Downloading the AI model — ${mb[1]} MB so far (one time only)`;
    return 'Downloading the AI model (one time only)…';
  }
  if (/prepar/i.test(msg)) return 'Starting the AI model…';
  if (/retrying on CPU/i.test(msg)) return `${base} — using the slower method, this can take a few minutes`;
  if (/matting|running/i.test(msg)) return base;
  return null;
}
