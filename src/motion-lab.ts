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
