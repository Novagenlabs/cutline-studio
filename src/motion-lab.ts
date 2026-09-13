/**
 * Motion lab — a dev-only page for tuning the cut mark.
 *
 * It is deliberately NOT part of the cutter bundle. The mark itself
 * (src/ui/cutmark.ts) ships with the app and has no dependencies; DialKit is
 * a devDependency that exists only here, so the panel can never add weight to
 * what a customer downloads.
 *
 * Why a lab at all: the bite of a scissor animation is a judgement call that
 * no amount of reading the code settles. Six numbers interact, and the right
 * combination is the one that looks right at 18px on a dark bar — which you
 * can only know by watching it. The lab shows all three real contexts at once
 * so a value that flatters the 64px view but dies at 18px is caught here.
 */
import { createCutMark, DEFAULT_MOTION, type CutMarkMotion } from './ui/cutmark';
import { createSplash, DEFAULT_SPLASH, type SplashMotion } from './ui/splash';
import { showLoading } from './ui/loading';

declare const DialKit: {
  createDialRoot(options?: Record<string, unknown>): { destroy(): void };
  createDialKit(
    name: string,
    config: Record<string, unknown>,
    options?: Record<string, unknown>
  ): {
    values: Record<string, number>;
    subscribe(fn: (v: Record<string, number>) => void, immediate?: boolean): () => void;
  };
};

const marks = [
  { id: 'slot-topbar', size: 18 },
  { id: 'slot-job', size: 20 },
  { id: 'slot-big', size: 64 },
].map(({ id, size }) => {
  const host = document.getElementById(id);
  const mark = createCutMark(size, DEFAULT_MOTION);
  host?.append(mark.el);
  mark.start();
  return mark;
});

DialKit.createDialRoot({ position: 'top-right', defaultOpen: true, theme: 'dark' });

// [default, min, max, step] — DialKit's slider notation.
const dial = DialKit.createDialKit('Cut mark', {
  openDeg: [DEFAULT_MOTION.openDeg, 4, 60, 1],
  closedDeg: [DEFAULT_MOTION.closedDeg, 0, 30, 1],
  periodMs: [DEFAULT_MOTION.periodMs, 240, 2400, 20],
  closeRatio: [DEFAULT_MOTION.closeRatio, 0.1, 0.9, 0.01],
  biteHold: [DEFAULT_MOTION.biteHold, 0, 0.4, 0.01],
  driftPx: [DEFAULT_MOTION.driftPx, 0, 6, 0.5],
});

const out = document.getElementById('out') as HTMLPreElement | null;
let latest: CutMarkMotion = { ...DEFAULT_MOTION };

dial.subscribe((v) => {
  latest = {
    openDeg: v.openDeg,
    closedDeg: v.closedDeg,
    periodMs: v.periodMs,
    closeRatio: v.closeRatio,
    biteHold: v.biteHold,
    driftPx: v.driftPx,
  };
  for (const m of marks) m.apply(latest);
  if (out) out.textContent = source(latest);
});

function source(m: CutMarkMotion): string {
  return [
    'export const DEFAULT_MOTION: CutMarkMotion = {',
    `  openDeg: ${m.openDeg},`,
    `  closedDeg: ${m.closedDeg},`,
    `  periodMs: ${m.periodMs},`,
    `  closeRatio: ${round(m.closeRatio)},`,
    `  biteHold: ${round(m.biteHold)},`,
    `  driftPx: ${round(m.driftPx)},`,
    '};',
  ].join('\n');
}

/** Trim float noise the sliders introduce, so the copied source is clean. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

document.getElementById('copy')?.addEventListener('click', () => {
  void navigator.clipboard.writeText(source(latest));
});

let running = true;
document.getElementById('toggle')?.addEventListener('click', () => {
  running = !running;
  for (const m of marks) {
    if (running) m.start();
    else m.stop();
  }
});

/* ---------------- startup splash ---------------- */

// A second panel rather than more rows on the first: the splash is a
// sequence, not another view of the same blades, and mixing the two sets of
// numbers in one panel makes it unclear which control affects what.
const splashDial = DialKit.createDialKit('Startup splash', {
  // Timing.
  sweepMs: [DEFAULT_SPLASH.sweepMs, 300, 3000, 20],
  bandWidth: [DEFAULT_SPLASH.bandWidth, 0.05, 0.6, 0.01],
  holdMs: [DEFAULT_SPLASH.holdMs, 0, 1200, 20],
  fadeMs: [DEFAULT_SPLASH.fadeMs, 120, 1200, 20],
  // Look. The outline weight and the resting opacity are the two that
  // decide whether the light reads as revealing the letters or just
  // brightening them, so they are worth a dial each.
  fontPx: [DEFAULT_SPLASH.fontPx, 24, 140, 1],
  trackingEm: [DEFAULT_SPLASH.trackingEm, 0, 0.5, 0.01],
  strokePx: [DEFAULT_SPLASH.strokePx, 0.5, 4, 0.05],
  restOpacity: [DEFAULT_SPLASH.restOpacity, 0, 1, 0.01],
  markPx: [DEFAULT_SPLASH.markPx, 16, 120, 1],
  gapPx: [DEFAULT_SPLASH.gapPx, 0, 80, 1],
});

let splashMotion: SplashMotion = { ...DEFAULT_SPLASH };
/** The splash currently on screen, so dial changes retime it live. */
let liveSplash: ReturnType<typeof createSplash> | null = null;

splashDial.subscribe((v) => {
  splashMotion = {
    sweepMs: v.sweepMs,
    bandWidth: v.bandWidth,
    holdMs: v.holdMs,
    fadeMs: v.fadeMs,
    fontPx: v.fontPx,
    trackingEm: v.trackingEm,
    strokePx: v.strokePx,
    restOpacity: v.restOpacity,
    markPx: v.markPx,
    gapPx: v.gapPx,
    // The blades follow the cut-mark panel, so tuning one tunes both and the
    // splash cannot drift away from the loading state it hands over to.
    mark: latest,
  };
  liveSplash?.apply(splashMotion);
});

/** Copyable source for the splash, same idea as the cut mark's. */
function splashSource(m: SplashMotion): string {
  return [
    'export const DEFAULT_SPLASH: SplashMotion = {',
    `  sweepMs: ${m.sweepMs},`,
    `  bandWidth: ${round(m.bandWidth)},`,
    `  holdMs: ${m.holdMs},`,
    `  fadeMs: ${m.fadeMs},`,
    `  fontPx: ${m.fontPx},`,
    `  trackingEm: ${round(m.trackingEm)},`,
    `  strokePx: ${round(m.strokePx)},`,
    `  restOpacity: ${round(m.restOpacity)},`,
    `  markPx: ${m.markPx},`,
    `  gapPx: ${m.gapPx},`,
    '  mark: DEFAULT_MOTION,',
    '};',
  ].join('\n');
}

document.getElementById('copy-splash')?.addEventListener('click', () => {
  void navigator.clipboard.writeText(splashSource(splashMotion));
});

// Parks the splash on screen so the dials can be turned against it. Without
// this every tweak needs a replay, and the look is the part that wants
// fiddling rather than watching.
document.getElementById('hold-splash')?.addEventListener('click', () => {
  if (liveSplash) {
    liveSplash.el.remove();
    liveSplash = null;
    return;
  }
  liveSplash = createSplash(splashMotion);
  document.body.append(liveSplash.el);
  liveSplash.el.classList.add('is-sweeping');
});

document.getElementById('play-splash')?.addEventListener('click', () => {
  void createSplash(splashMotion).play();
});

// The real question is not whether either looks good alone — it is whether
// the wordmark fading into the wait reads as one motion or as two screens.
document.getElementById('play-sequence')?.addEventListener('click', async () => {
  await createSplash(splashMotion).play();
  const close = showLoading('Loading your workspace');
  setTimeout(close, 1800);
});
