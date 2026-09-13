/**
 * The startup splash: the mark and the wordmark, with a light pass.
 *
 * A flare sweeps across "Cutline Studio" once, the blades close on the mark,
 * and the whole thing hands over to the loading overlay — which is the same
 * mark at the same size in the same place, so the splash resolves into the
 * wait rather than cutting to it.
 *
 * Deliberately CSS, not WebGPU. The reference (vgpu's flare) is a 48-step ray
 * march with volumetric scattering over a Gaussian blur chain, which is a
 * beautiful thing to spend a GPU on and the wrong thing to spend one on here:
 * WebGPU is absent in Safari and in plenty of the browsers a print shop runs,
 * so it would need a fallback that looks like this anyway. A moving gradient
 * clipped to text is the same read — light crossing a surface — at no
 * dependency, no fallback, and no cost to the machines that have to trace
 * artwork a moment later.
 *
 * It shows once per session. A splash on every navigation is a tax on people
 * who use the tool all day.
 */
import { createCutMark, DEFAULT_MOTION, type CutMarkMotion } from './cutmark';

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
  /** Blade motion under the splash. */
  mark: CutMarkMotion;
}

export const DEFAULT_SPLASH: SplashMotion = {
  sweepMs: 1100,
  bandWidth: 0.22,
  holdMs: 260,
  fadeMs: 420,
  fontPx: 76,
  trackingEm: 0.16,
  strokePx: 1.25,
  restOpacity: 0.3,
  markPx: 40,
  gapPx: 26,
  mark: DEFAULT_MOTION,
};

export interface Splash {
  el: HTMLElement;
  /** Run the sequence. Resolves when the splash has finished fading. */
  play(): Promise<void>;
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

      const skip = () => {
        el.classList.add('is-leaving');
      };
      addEventListener('pointerdown', skip, { once: true, capture: true });
      addEventListener('keydown', skip, { once: true, capture: true });

      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Reduced motion still gets the splash, just without the travelling
      // light: the brand moment is information, the sweep is decoration.
      if (!reduced) el.classList.add('is-sweeping');

      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await wait(reduced ? 400 : current.sweepMs + current.holdMs);

      el.classList.add('is-leaving');
      await wait(current.fadeMs);

      mark.stop();
      el.remove();
      markSeen();
    },
  };
}
