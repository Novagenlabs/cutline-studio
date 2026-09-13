/**
 * The startup splash: the mark and the wordmark, with a light pass.
 *
 * A flare sweeps across "Cutline Studio" once, the blades close on the mark,
 * and the whole thing hands over to the loading overlay — which is the same
 * mark at the same size in the same place, so the splash resolves into the
 * wait rather than cutting to it.
 *
 * Two implementations, one of which is a fallback. Where WebGPU exists the
 * splash is vgpu's nextjs-flare (src/vendor/flare): a rim-lit lockup with
 * volumetric scattering, lazily imported so nothing downloads it otherwise.
 * Where it does not — Safari, and plenty of the browsers a print shop runs —
 * the DOM splash below shows instead: a gradient clipped to outlined caps,
 * which is the same read (light crossing a surface) at no dependency.
 *
 * The fallback is not deleted once the GPU path starts, only hidden. A device
 * can be lost mid-frame, and the thing underneath should be correct rather
 * than absent.
 *
 * It shows once per session. A splash on every navigation is a tax on people
 * who use the tool all day.
 */
import { createCutMark, DEFAULT_MOTION, type CutMarkMotion } from './cutmark';
// No static import of the flare: a top-level import would pull vgpu, the WGSL
// sources and the blue-noise table into the main bundle, which is the opposite
// of what the dynamic import below is for.

const SEEN_KEY = 'cutline.splashSeen';

export interface SplashMotion {
  /** How long the flare takes to cross the wordmark, ms. */
  sweepMs: number;
  /** Width of the light band, as a fraction of the wordmark. */
  bandWidth: number;
  /** Pause after the sweep before the splash lifts, ms. */
  holdMs: number;
  /** Fade of the whole splash, ms. */
  fadeMs: number;
  /** Wordmark size, px. Clamped against the viewport so it fits on a phone. */
  fontPx: number;
  /** Letter-spacing, em. Outlined caps need air or they read as a fence. */
  trackingEm: number;
  /** Outline weight, px. */
  strokePx: number;
  /** How visible the unlit outline is, 0–1. */
  restOpacity: number;
  /** Cut mark size, px. */
  markPx: number;
  /** Gap between mark and wordmark, px. */
  gapPx: number;
  /**
   * Which splash to run.
   *
   * `flare` is the WebGPU render with the CSS sheen as its fallback; `sheen`
   * is the CSS sheen on purpose, repeating rather than passing once. The
   * second is not a lesser version — it costs nothing to start, which on a
   * tool people open all day is a real argument.
   */
  variant: 'flare' | 'sheen';
  /** One sheen pass plus its pause, ms. Only used by the sheen variant. */
  sheenMs: number;
  /** Blade motion under the splash. */
  mark: CutMarkMotion;
}

export const DEFAULT_SPLASH: SplashMotion = {
  // The sweep IS one full orbit of the flare (see setAutonomousRate below),
  // so this number is the orbit's period, not just a fade length. 4200ms puts
  // the light at about 1.5 rad/s — fast enough to feel deliberate, slow
  // enough that the rays are legible as they travel. Below ~3s a full
  // revolution reads as a spin rather than a pass.
  sweepMs: 4200,
  bandWidth: 0.22,
  holdMs: 500,
  fadeMs: 600,
  fontPx: 76,
  trackingEm: 0.16,
  strokePx: 1.25,
  restOpacity: 0.3,
  markPx: 40,
  gapPx: 26,
  variant: 'flare',
  // Slower than the single pass: a repeating band that hurries reads as
  // impatient, and this one is meant to sit under a wait rather than announce
  // the end of one.
  sheenMs: 2600,
  mark: DEFAULT_MOTION,
};

export interface Splash {
  el: HTMLElement;
  /** Run the sequence. Resolves when the splash has finished fading. */
  play(): Promise<void>;
  /**
   * Start the blades without running the sequence.
   *
   * For a held preview: `play()` starts the mark and then times itself out,
   * which is no use when the point is to leave the thing on screen. Without
   * this the motion lab showed a frozen mark, because appending `el` by hand
   * never reached the `mark.start()` inside play().
   */
  startMark(): void;
  /** Re-time without rebuilding (the motion lab drives this). */
  apply(motion: SplashMotion): void;
}

/** Has the splash already run this session? */
export function splashSeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // Private browsing throws on storage. Treat it as "not seen" and let the
    // splash run — a splash too often is a smaller failure than a crash.
    return false;
  }
}

function markSeen(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* ignore — see splashSeen() */
  }
}

export function createSplash(motion: SplashMotion = DEFAULT_SPLASH): Splash {
  let current = motion;

  const el = document.createElement('div');
  el.className = 'splash';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', 'Cutline Studio');

  const box = document.createElement('div');
  box.className = 'splash-box';

  const mark = createCutMark(40, current.mark);
  box.append(mark.el);

  // The wordmark is rendered twice: the base text, and a copy with the light
  // band clipped to its glyphs. Clipping to the text rather than overlaying a
  // rectangle is what makes the light look like it is ON the letters instead
  // of passing in front of them.
  // The WebGPU flare draws its own mark and wordmark, so when it starts the
  // DOM copies below are hidden rather than removed — if the GPU path fails
  // at any point they are still there to show.
  const canvas = document.createElement('canvas');
  canvas.className = 'splash-gpu';
  canvas.setAttribute('aria-hidden', 'true');
  el.append(canvas);

  // One line, matching the GPU lockup. Drawn twice: the resting outline, and
  // a copy carrying the light band clipped to its glyphs.
  const word = document.createElement('div');
  word.className = 'splash-word';

  const base = document.createElement('span');
  base.className = 'splash-word-base';
  base.textContent = 'Cutline Studio';

  const flare = document.createElement('span');
  flare.className = 'splash-word-flare';
  flare.textContent = 'Cutline Studio';
  flare.setAttribute('aria-hidden', 'true');

  word.append(base, flare);
  box.append(word);
  el.append(box);

  function vars(m: SplashMotion) {
    el.style.setProperty('--sweep', `${m.sweepMs}ms`);
    el.style.setProperty('--band', `${Math.round(m.bandWidth * 100)}%`);
    el.style.setProperty('--fade', `${m.fadeMs}ms`);
    el.style.setProperty('--sheen', `${m.sheenMs}ms`);
    // Clamped against the viewport as well as the dial: the wordmark is wide
    // in caps, and a size chosen on a desktop would run off a phone.
    el.style.setProperty('--splash-font', `min(${m.fontPx}px, 11vw)`);
    el.style.setProperty('--splash-track', `${m.trackingEm}em`);
    el.style.setProperty('--splash-stroke', `${m.strokePx}px`);
    el.style.setProperty('--splash-rest', String(m.restOpacity));
    el.style.setProperty('--splash-gap', `${m.gapPx}px`);
    mark.el.setAttribute('width', String(m.markPx));
    mark.el.setAttribute('height', String(m.markPx));
  }
  vars(current);

  return {
    el,
    startMark() {
      mark.start();
    },
    apply(m) {
      current = m;
      vars(m);
      mark.apply(m.mark);
    },
    async play() {
      // If the user is already working — a file dropped onto the page, a
      // click landing — the splash has missed its moment and must not sit in
      // front of the app. It is decoration on top of a live studio, so it
      // never takes pointer events (see .splash in the stylesheet) and any
      // real interaction dismisses it early.
      document.body.append(el);
      mark.start();

      // The flare is imported lazily: it pulls in vgpu, the WGSL sources and a
      // 128x128 blue-noise table, none of which a browser without WebGPU
      // should ever download, and none of which the cutter needs to trace.
      let renderer: { dispose(): void } | undefined;
      const gpuReady = (async () => {
        // The sheen variant is a deliberate choice, not a fallback, so it
        // must not quietly load a renderer it has no intention of showing.
        if (current.variant === 'sheen') return false;
        if (!('gpu' in navigator)) return false;
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
        const [{ createRenderer }, pipelineMod, raster] =
          await Promise.all([
            import('../vendor/flare/renderer'),
            import('../vendor/flare/pipeline'),
            import('../vendor/flare/logo-raster'),
          ]);
        // Fonts first: the aspect is measured from the loaded typeface, and
        // measuring against a fallback would set the box to the wrong width.
        await document.fonts?.ready?.catch?.(() => undefined);
        // Exactly one revolution over the sweep, so the light starts and
        // finishes in the same place and the splash reads as a complete
        // motion rather than an arbitrary slice of a longer loop. The rate is
        // derived rather than fixed: change sweepMs and the orbit still
        // closes, which a hardcoded rad/s value could not do.
        pipelineMod.setAutonomousRate((2 * Math.PI) / (current.sweepMs / 1000));
        pipelineMod.setLogoGeometry({
          centerInBox: raster.measureCutlineCenter(),
          aspect: raster.measureCutlineAspect(),
          // A wide lockup is sized off the canvas height here, and the
          // example's 0.62 would run ours off both edges.
          heightRatio: 0.16,
        });
        const r = createRenderer({ canvas });
        await r.ready;
        renderer = r;
        return true;
      })().catch(() => {
        // A GPU that refuses to initialise is not an error worth showing
        // anybody — the DOM splash underneath is already correct.
        return false;
      });

      if (await gpuReady) el.classList.add('is-gpu');

      const skip = () => {
        el.classList.add('is-leaving');
        // The GPU may still be initialising when the user skips, so disposal
        // is also chained onto the init promise — whichever finishes last
        // does the cleanup, and dispose() is idempotent by design.
        void gpuReady.then(() => renderer?.dispose());
      };
      addEventListener('pointerdown', skip, { once: true, capture: true });
      addEventListener('keydown', skip, { once: true, capture: true });

      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Reduced motion still gets the splash, just without the travelling
      // light: the brand moment is information, the sweep is decoration.
      if (!reduced) {
        el.classList.add(current.variant === 'sheen' ? 'is-sheen' : 'is-sweeping');
      }

      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // The sheen repeats rather than ending, so it is held for two passes
      // and then lifted — long enough to read as a loop rather than as a
      // single pass that happened to be slow. The flare's sweep IS its
      // length, so that one waits exactly as long as the animation runs.
      const onScreen =
        current.variant === 'sheen'
          ? current.sheenMs * 2 + current.holdMs
          : current.sweepMs + current.holdMs;
      await wait(reduced ? 400 : onScreen);

      el.classList.add('is-leaving');
      await wait(current.fadeMs);

      mark.stop();
      // The example's teardown, run at the one moment it matters: this
      // cancels the frame loop, disconnects the ResizeObserver, drops the
      // pointer listeners and disposes the GPU device. Skipping it would
      // leave a render loop running for the life of the page, behind an
      // element that is no longer on it.
      renderer?.dispose();
      el.remove();
      markSeen();
    },
  };
}
