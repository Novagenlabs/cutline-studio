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
import { DEFAULT_LOCKUP } from './vendor/flare/logo-raster';
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
  // Up to 8s: the sweep is one full orbit of the flare, so this is the
  // orbit's period and the old 3000 ceiling sat below the default.
  sweepMs: [DEFAULT_SPLASH.sweepMs, 300, 8000, 50],
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
  /** One sheen pass plus its pause. Only the sheen variant uses it. */
  sheenMs: [DEFAULT_SPLASH.sheenMs, 600, 6000, 50],
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
    sheenMs: v.sheenMs,
    // Set per play button rather than by a dial: it selects which animation
    // runs, not how it looks, and a toggle buried among ten sliders is a
    // worse control than two buttons that say what they do.
    variant: splashMotion.variant,
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
    `  variant: '${m.variant}',`,
    `  sheenMs: ${m.sheenMs},`,
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
  liveSplash.startMark();
  liveSplash.el.classList.add('is-sweeping');
});

/* ---------------- the WebGPU flare ---------------- */

/**
 * The flare gets its own panel and its own held preview.
 *
 * It is a different thing from the CSS splash — a ray-marched render with its
 * own look parameters — and it only exists on machines with WebGPU, so
 * bundling its dials into the splash panel would show controls that do
 * nothing on half the machines that open this page.
 */
// Defaults are the tuned values now shipping in DEFAULT_LOOK, so the panel
// opens on what the app actually shows rather than on the example's starting
// point — otherwise every session begins by undoing a change nobody made.
const flareDial = DialKit.createDialKit('WebGPU flare', {
  rimIntensity: [0.65, 0, 3, 0.05],
  beamIntensity: [2.55, 0, 3, 0.05],
  extension: [0.9, 0, 2, 0.05],
  scatter: [0.5, 0, 3, 0.05],
  spotFocus: [0.01, 0.01, 0.5, 0.01],
  filmGrain: [0.025, 0, 0.2, 0.005],
  /**
   * Radians per second for the autonomous light, for the held preview only.
   *
   * The splash does NOT use this: it derives the rate from sweepMs so the
   * light completes exactly one revolution over the animation. Turn it here
   * to judge a speed, then set sweepMs to 2π / (the rate you liked).
   */
  orbitRate: [(2 * Math.PI) / 4.2, 0.02, 3, 0.02],
  // The lockup itself. Changing these re-rasterises the artwork, which is why
  // they live here rather than with the composite pass's look dials.
  markSize: [DEFAULT_LOCKUP.markSize, 48, 320, 4],
  markStroke: [DEFAULT_LOCKUP.markStroke, 1, 20, 0.5],
  textStroke: [DEFAULT_LOCKUP.textStroke, 0.5, 10, 0.25],
});

let flareRenderer: { dispose(): void } | undefined;
let flareEl: HTMLElement | undefined;

/** Current lockup values, so a subscriber can tell what actually changed. */
let lockup = { ...DEFAULT_LOCKUP };

flareDial.subscribe(async (v) => {
  // Only reachable once the flare chunk has loaded, which needs WebGPU.
  if (!('gpu' in navigator)) return;
  const pipeline = await import('./vendor/flare/pipeline');
  pipeline.setFlareLook({
    rimIntensity: v.rimIntensity,
    beamIntensity: v.beamIntensity,
    extension: v.extension,
    scatter: v.scatter,
    spotFocus: v.spotFocus,
    filmGrain: v.filmGrain,
  });
  pipeline.setAutonomousRate(v.orbitRate);

  // The look dials feed uniforms the next frame picks up on its own. The
  // lockup dials change the ARTWORK, which lives in a GPU texture rasterised
  // once at the current size — so they need the renderer to redraw it. A
  // resize with the same dimensions is a no-op inside the example, hence the
  // deliberate nudge through a different size and back.
  const raster = await import('./vendor/flare/logo-raster');
  const changed =
    v.markSize !== lockup.markSize ||
    v.markStroke !== lockup.markStroke ||
    v.textStroke !== lockup.textStroke;
  lockup = { markSize: v.markSize, markStroke: v.markStroke, textStroke: v.textStroke };
  raster.setLockupStyle(lockup);

  if (changed && flareEl) {
    pipeline.setLogoGeometry({ aspect: raster.measureCutlineAspect() });
    reraster();
  }
});

/**
 * Force the held flare to rebuild its logo texture.
 *
 * The renderer only re-rasterises on a size change, so the canvas is nudged
 * by a pixel and back. Cheaper and far less disruptive than tearing the whole
 * renderer down and losing the light's position mid-orbit.
 */
function reraster(): void {
  const canvas = flareEl?.querySelector('canvas');
  if (!canvas) return;
  // setTimeout rather than requestAnimationFrame: rAF does not fire in a
  // background tab, which would leave the canvas stuck a pixel narrow.
  canvas.style.width = 'calc(100% - 1px)';
  setTimeout(() => {
    canvas.style.width = '';
  }, 32);
}

const flareStatus = document.getElementById('flare-status');

document.getElementById('hold-flare')?.addEventListener('click', async () => {
  if (flareEl) {
    flareRenderer?.dispose();
    flareRenderer = undefined;
    flareEl.remove();
    flareEl = undefined;
    if (flareStatus) flareStatus.textContent = '';
    return;
  }

  if (!('gpu' in navigator)) {
    if (flareStatus) {
      flareStatus.textContent =
        'No WebGPU in this browser — the app falls back to the CSS splash here.';
    }
    return;
  }

  const el = document.createElement('div');
  el.className = 'splash';
  const canvas = document.createElement('canvas');
  canvas.className = 'splash-gpu';
  el.append(canvas);
  document.body.append(el);
  flareEl = el;

  try {
    const [{ createRenderer }, pipeline, raster] = await Promise.all([
      import('./vendor/flare/renderer'),
      import('./vendor/flare/pipeline'),
      import('./vendor/flare/logo-raster'),
    ]);
    await document.fonts?.ready;
    pipeline.setLogoGeometry({
      centerInBox: raster.measureCutlineCenter(),
      aspect: raster.measureCutlineAspect(),
      heightRatio: 0.16,
    });
    const r = createRenderer({ canvas });
    await r.ready;
    flareRenderer = r;
    el.classList.add('is-gpu');
    if (flareStatus) {
      flareStatus.textContent =
        'Held. Turn the WebGPU flare dials — the render updates live. Move the pointer over it to steer the light.';
    }
  } catch (error) {
    // A held preview that fails should say so rather than sit black.
    if (flareStatus) {
      flareStatus.textContent = `Flare failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    el.remove();
    flareEl = undefined;
  }
});

document.getElementById('play-splash')?.addEventListener('click', () => {
  void createSplash({ ...splashMotion, variant: 'flare' }).play();
});

// The alternate: same lockup, repeating sheen, no GPU. Worth watching back to
// back with the flare — the question is whether the cheaper one is actually
// worse, and on a tool people open all day that is not obvious.
document.getElementById('play-sheen')?.addEventListener('click', () => {
  void createSplash({ ...splashMotion, variant: 'sheen' }).play();
});

document.getElementById('hold-sheen')?.addEventListener('click', () => {
  if (liveSplash) {
    liveSplash.el.remove();
    liveSplash = null;
    return;
  }
  liveSplash = createSplash({ ...splashMotion, variant: 'sheen' });
  document.body.append(liveSplash.el);
  liveSplash.startMark();
  liveSplash.el.classList.add('is-sheen');
});

// The real question is not whether either looks good alone — it is whether
// the wordmark fading into the wait reads as one motion or as two screens.
document.getElementById('play-sequence')?.addEventListener('click', async () => {
  await createSplash(splashMotion).play();
  const close = showLoading('Loading your workspace');
  setTimeout(close, 1800);
});
