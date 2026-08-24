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
 * Stop showing the banner.
 *
 * The banner reports work in progress and nothing else. Outcomes belong in
 * the toast, which is dismissible, stacks, and can carry an action — a second
 * transient element saying the same thing in a different corner is noise, and
 * a "done" banner is a status line that is no longer reporting any status.
 */
export function jobEnd(): void {
  const root = el();
  if (!root) return;
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  root.hidden = true;
  root.classList.remove('is-done', 'is-error');
}
