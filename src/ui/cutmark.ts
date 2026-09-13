/**
 * The brand mark, animated: the loading indicator for the cutter.
 *
 * The mark is a pair of crossed blades with two ring pivots — open scissors.
 * So the busy state is the thing the product actually does: the blades close
 * through the cross, pause at the bite, and open again. A generic spinner
 * would say "waiting"; this says "cutting", which is true, and it reuses a
 * shape the user has already been looking at in the top bar.
 *
 * Geometry note: both blades rotate about the SAME point — the crossing at
 * (12,12) — not about their own pivot rings. Scissor blades are two levers on
 * one rivet; rotating each about its own ring would pull the arms apart and
 * the illusion dies. The rings sit at the tail ends and are carried along by
 * their blade, which is why each ring is grouped with its blade rather than
 * drawn separately.
 */

/** Tunables. The motion lab writes these live; the app ships the defaults. */
export interface CutMarkMotion {
  /** Half-angle of the open scissors, degrees. 0 would be a closed blade. */
  openDeg: number;
  /** Half-angle at the tightest point of the bite. */
  closedDeg: number;
  /** One full close-and-open, ms. */
  periodMs: number;
  /** Fraction of the period spent closing (the rest opens). */
  closeRatio: number;
  /** Hold at the bite, as a fraction of the period. */
  biteHold: number;
  /** Travel of the whole mark along its cut, px. 0 keeps it in place. */
  driftPx: number;
}

/**
 * Tuned in the motion lab, not derived. The shape that works: a wide open
 * (40°), a full close to 0° — the blades actually meet, so it reads as a
 * completed cut rather than a near miss — and a fast snap shut at 27% of the
 * cycle followed by a long, unhurried opening. The asymmetry is the point: a
 * tool closes quickly under the hand and is drawn back slowly.
 */
export const DEFAULT_MOTION: CutMarkMotion = {
  openDeg: 40,
  closedDeg: 0,
  periodMs: 1580,
  closeRatio: 0.27,
  biteHold: 0.08,
  driftPx: 0,
};

const NS = 'http://www.w3.org/2000/svg';

export interface CutMark {
  el: SVGSVGElement;
  /** Start the blades cutting. Idempotent. */
  start(): void;
  /** Settle to rest: the blades stop and the mark returns to fully open. */
  stop(): void;
  /** Re-time a running animation from new values (used by the motion lab). */
  apply(motion: CutMarkMotion): void;
}

/**
 * Build the mark. `size` is the rendered box; the artwork is authored in a
 * 24-unit viewBox so it scales cleanly from an 18px top-bar mark up to a
 * 64px canvas indicator.
 */
export function createCutMark(size = 18, motion: CutMarkMotion = DEFAULT_MOTION): CutMark {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.classList.add('cutmark');

  // Each blade is authored horizontal, pointing right from the rivet, with
  // its ring at the tail. Rotation about (12,12) then opens the scissors
  // symmetrically, so openDeg is a real half-angle rather than a fudge.
  const upper = blade();
  const lower = blade();
  svg.append(upper, lower);

  let anims: Animation[] = [];
  let current = motion;
  let running = false;

  function frames(sign: number, m: CutMarkMotion): Keyframe[] {
    // sign flips the blade so the pair closes towards each other.
    const open = sign * m.openDeg;
    const closed = sign * m.closedDeg;
    const closeAt = Math.min(0.9, Math.max(0.05, m.closeRatio));
    const holdAt = Math.min(0.95, closeAt + Math.max(0, m.biteHold));
    return [
      { offset: 0, transform: `rotate(${open}deg)` },
      { offset: closeAt, transform: `rotate(${closed}deg)` },
      // The hold is a repeated keyframe, not a pause: WAAPI has no dwell, so
      // the bite is held by asking for the same angle twice.
      { offset: holdAt, transform: `rotate(${closed}deg)` },
      { offset: 1, transform: `rotate(${open}deg)` },
    ];
  }

  function rest(m: CutMarkMotion) {
    upper.style.transform = `rotate(${-m.openDeg}deg)`;
    lower.style.transform = `rotate(${m.openDeg}deg)`;
  }

  function build(m: CutMarkMotion) {
    for (const a of anims) a.cancel();
    anims = [upper, lower].map((g, i) =>
      g.animate(frames(i === 0 ? -1 : 1, m), {
        duration: Math.max(120, m.periodMs),
        iterations: Infinity,
        // The blade accelerates into the cut and decelerates out of it, which
        // is how a hinged tool actually moves under a hand.
        easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
      })
    );
    if (m.driftPx) {
      anims.push(
        svg.animate(
          [
            { transform: `translateX(${-m.driftPx}px)` },
            { transform: `translateX(${m.driftPx}px)` },
          ],
          {
            duration: Math.max(120, m.periodMs) * 2,
            iterations: Infinity,
            direction: 'alternate',
            easing: 'cubic-bezier(0.45, 0, 0.55, 1)',
          }
        )
      );
    }
  }

  rest(current);

  return {
    el: svg,
    start() {
      if (running) return;
      running = true;
      // Respect the OS setting: no repeating motion, just the open mark.
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      build(current);
    },
    stop() {
      running = false;
      for (const a of anims) a.cancel();
      anims = [];
      rest(current);
    },
    apply(m: CutMarkMotion) {
      current = m;
      if (running) build(m);
      else rest(m);
    },
  };
}

/**
 * One blade: a stroke from the rivet outward, with its pivot ring at the tail.
 *
 * The ring sits BEYOND the tail of the arm (x=3.2, left of the arm's x=5.4
 * start) rather than on it. Drawn concentric with the tail, the two blades'
 * rings land on the same point at full closure and merge into one blob; held
 * out past the tail, they stay two distinct finger holes through the whole
 * cycle, which is what the static logo shows.
 */
function blade(): SVGGElement {
  const g = document.createElementNS(NS, 'g');
  g.style.transformOrigin = '12px 12px';
  g.style.transformBox = 'view-box';

  const arm = document.createElementNS(NS, 'path');
  // Tail sits left of the rivet, tip reaches right of it: one continuous
  // lever, so the blade reads as a single rigid object when it turns.
  arm.setAttribute('d', 'M5.6 12 L20 12');
  arm.setAttribute('stroke', 'currentColor');
  arm.setAttribute('stroke-width', '1.6');
  arm.setAttribute('stroke-linecap', 'round');
  g.append(arm);

  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('cx', '3.2');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '2.4');
  ring.setAttribute('stroke', 'currentColor');
  ring.setAttribute('stroke-width', '1.4');
  ring.setAttribute('opacity', '0.55');
  g.append(ring);

  return g;
}
