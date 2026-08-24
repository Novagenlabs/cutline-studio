/**
 * On-canvas job status.
 *
 * A disabled button reading "preparing..." is easy to miss — the eye is on the
 * artwork, not the sidebar — and a paid action that appears to do nothing is
 * the moment a user clicks again. This puts the state where they are already
 * looking, and names the stage so a slow PDF reads as work in progress rather
 * than a hang.
 */

const STAGES: Record<string, { text: string; sub: string }> = {
  sending: {
    text: 'Sending your artwork',
    sub: 'Only needed for the formats that embed the image.',
  },
  rendering: {
    text: 'Generating the cut file',
    sub: 'Building vectors on the server.',
  },
  downloading: {
    text: 'Downloading',
    sub: 'Almost there.',
  },
};

let hideTimer: number | null = null;

function el(): HTMLElement | null {
  return document.getElementById('job');
}

export function jobStart(format: string, stage: keyof typeof STAGES = 'rendering'): void {
  const root = el();
  if (!root) return;
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  root.classList.remove('is-done', 'is-error');
  root.hidden = false;
  jobStage(stage, format);
}

export function jobStage(stage: keyof typeof STAGES, format?: string): void {
  const root = el();
  if (!root) return;
  const s = STAGES[stage] ?? STAGES.rendering;
  const text = root.querySelector('.job-text');
  const sub = root.querySelector('.job-sub');
  if (text) text.textContent = format ? `${s.text} · ${format}` : s.text;
  if (sub) sub.textContent = s.sub;
}

/**
 * Finish, briefly. The banner stays a moment on success so the transition
 * from working to done is visible; vanishing instantly looks like the click
 * was ignored.
 */
export function jobDone(message: string): void {
  const root = el();
  if (!root) return;
  root.classList.add('is-done');
  root.classList.remove('is-error');
  const text = root.querySelector('.job-text');
  const sub = root.querySelector('.job-sub');
  if (text) text.textContent = message;
  if (sub) sub.textContent = '';
  hideTimer = window.setTimeout(() => {
    root.hidden = true;
    root.classList.remove('is-done');
  }, 2200);
}

export function jobFailed(message: string): void {
  const root = el();
  if (!root) return;
  root.classList.add('is-error');
  root.classList.remove('is-done');
  const text = root.querySelector('.job-text');
  const sub = root.querySelector('.job-sub');
  if (text) text.textContent = message;
  // The toast carries the detail and the action; this only needs to stop
  // claiming that work is still happening.
  if (sub) sub.textContent = '';
  hideTimer = window.setTimeout(() => {
    root.hidden = true;
    root.classList.remove('is-error');
  }, 2600);
}
