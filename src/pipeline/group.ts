import type { Pt } from './types';
import type { TracedRing } from './trace';
import { signedArea } from './trace';

/**
 * A cluster of traced contours that reads as one element of the artwork —
 * an icon, a line of display type, a strapline. Grouping lets each element
 * carry its own offset / corner radius / smoothing instead of forcing one
 * compromise across artwork whose parts sit at very different scales.
 */
export interface RingGroup {
  /** Indices into the traced-ring array this group was built from. */
  members: number[];
  bbox: { x: number; y: number; w: number; h: number };
  /** Total ink area (px^2), holes subtracted. */
  area: number;
  /** Median characteristic stroke width (px) over the group's exterior rings. */
  strokeWidth: number;
}

const bboxOfPts = (pts: Pt[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
};

/** Gap between two axis-aligned boxes (0 when they overlap). */
function boxGap(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number }
): number {
  const dx = Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1));
  const dy = Math.max(0, Math.max(a.y0 - b.y1, b.y0 - a.y1));
  return Math.hypot(dx, dy);
}

/**
 * Minimum distance between two closed polylines, sampled at their vertices.
 * Vertex sampling is enough here because the tracer emits densely sampled
 * contours — the marching-squares output has a vertex roughly every pixel,
 * so a true segment-to-segment distance would agree to well under the
 * clustering threshold while costing far more.
 */
function ringGap(a: Pt[], b: Pt[], cutoff: number): number {
  let best = Infinity;
  const stepA = Math.max(1, Math.floor(a.length / 256));
  const stepB = Math.max(1, Math.floor(b.length / 256));
  for (let i = 0; i < a.length; i += stepA) {
    const p = a[i];
    for (let j = 0; j < b.length; j += stepB) {
      const q = b[j];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < best) {
        best = d;
        if (best <= cutoff * 0.25) return best; // early out: certainly same group
      }
    }
  }
  return best;
}

/** Characteristic width of a ring: 2*area/perimeter. */
function ringWidth(pts: Pt[]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  let perim = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
    perim += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return perim > 0 ? (2 * Math.abs(a / 2)) / perim : 0;
}

/**
 * Cluster traced contours into elements by proximity.
 *
 * Two exterior contours join the same group when the gap between them is
 * under `gapPx`. That single rule handles the cases that matter: the letters
 * of a word sit a fraction of their stroke width apart and cluster into one
 * line of type, while a logo mark separated by whitespace stays its own
 * element. Holes are assigned to whichever exterior contour encloses them,
 * so a counter never forms a group of its own.
 *
 * `gapPx` is the caller's choice of "what counts as one element" — deriving
 * it from the artwork's own stroke width (see `suggestGapPx`) adapts it to
 * the scale of the type rather than fixing it in absolute units.
 */
export function groupRings(rings: TracedRing[], gapPx: number): RingGroup[] {
  const outerIdx: number[] = [];
  const holeIdx: number[] = [];
  rings.forEach((r, i) => (r.isHole ? holeIdx : outerIdx).push(i));
  if (!outerIdx.length) return [];

  const boxes = rings.map((r) => bboxOfPts(r.points));

  // Union-find over exterior contours.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const i of outerIdx) parent.set(i, i);

  // The joining distance is scaled to the LOCAL stroke width of the pair
  // rather than taken from the artwork as a whole. Logo artwork routinely
  // spans an order of magnitude in scale — a display mark with a 22mm stroke
  // beside a strapline with a 1.7mm one — and a single global distance can
  // only ever serve one of them: wide enough to hold a strapline together
  // and it swallows the mark, narrow enough to keep the mark separate and
  // the strapline shatters into individual letters. Letter spacing tracks
  // stroke weight within any one piece of type, so a pair-local distance
  // separates "same line of type" from "different element" at every scale
  // at once. `gapPx` sets the overall tightness; the per-pair value scales
  // around the artwork's median stroke.
  const median = medianWidth(rings);
  const widths = new Map<number, number>();
  for (const i of outerIdx) widths.set(i, ringWidth(rings[i].points));

  for (let a = 0; a < outerIdx.length; a++) {
    for (let b = a + 1; b < outerIdx.length; b++) {
      const i = outerIdx[a];
      const j = outerIdx[b];
      if (find(i) === find(j)) continue;
      // Two contours belong to the same run of type only if they are of
      // comparable weight; the smaller of the pair sets the distance so a
      // heavy mark never reaches out and captures light text beside it.
      const wi = widths.get(i) ?? 0;
      const wj = widths.get(j) ?? 0;
      let local = median > 0 ? (Math.min(wi, wj) / median) * gapPx : gapPx;
      // Wildly mismatched weights are different elements by definition.
      const ratio = Math.max(wi, wj) / Math.max(1e-6, Math.min(wi, wj));
      if (ratio > 4) continue;

      // Text runs along a baseline, and the gap between two words on one line
      // is several times the gap between two letters in a word. Judging both
      // by the same distance either breaks a line at its word spaces or bleeds
      // across the leading into the line below. Contours that share a band of
      // vertical extent are on the same line, so the reach is extended along
      // the baseline only — enough to carry a word space — while the reach
      // across lines stays tight.
      const bi = boxes[i];
      const bj = boxes[j];
      const overlapY = Math.min(bi.y1, bj.y1) - Math.max(bi.y0, bj.y0);
      const minH = Math.min(bi.y1 - bi.y0, bj.y1 - bj.y0);
      const sameLine = minH > 0 && overlapY > minH * 0.5;
      if (sameLine) {
        const dx = Math.max(0, Math.max(bi.x0 - bj.x1, bj.x0 - bi.x1));
        const dy = Math.max(0, Math.max(bi.y0 - bj.y1, bj.y0 - bi.y1));
        // Horizontal reach along the line; vertical reach unchanged.
        if (dy <= local && dx <= local * 4) {
          union(i, j);
          continue;
        }
      } else {
        // Not on a shared baseline: the only way these join is a genuinely
        // tight gap. Leading between two lines of type is comfortably larger
        // than the space between letters, so holding the cross-line reach
        // well under the in-line one keeps stacked lines distinct even as the
        // overall gap setting is loosened.
        local *= 0.5;
      }
      if (boxGap(bi, bj) > local) continue;
      if (ringGap(rings[i].points, rings[j].points, local) <= local) union(i, j);
    }
  }

  // Collect members by root, then attach holes to their containing exterior.
  const byRoot = new Map<number, number[]>();
  for (const i of outerIdx) {
    const r = find(i);
    const list = byRoot.get(r);
    if (list) list.push(i);
    else byRoot.set(r, [i]);
  }
  for (const h of holeIdx) {
    const p = rings[h].points[0];
    if (!p) continue;
    let owner = -1;
    let ownerArea = Infinity;
    for (const i of outerIdx) {
      if (!pointInRing(p, rings[i].points)) continue;
      // Smallest enclosing exterior wins, so nested art attaches correctly.
      const a = Math.abs(signedArea(rings[i].points));
      if (a < ownerArea) {
        ownerArea = a;
        owner = i;
      }
    }
    if (owner >= 0) byRoot.get(find(owner))?.push(h);
  }

  const groups: RingGroup[] = [];
  for (const members of byRoot.values()) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let area = 0;
    const widths: number[] = [];
    for (const i of members) {
      const b = boxes[i];
      if (b.x0 < x0) x0 = b.x0;
      if (b.y0 < y0) y0 = b.y0;
      if (b.x1 > x1) x1 = b.x1;
      if (b.y1 > y1) y1 = b.y1;
      const a = Math.abs(signedArea(rings[i].points));
      area += rings[i].isHole ? -a : a;
      if (!rings[i].isHole) widths.push(ringWidth(rings[i].points));
    }
    widths.sort((p, q) => p - q);
    groups.push({
      members: members.slice().sort((p, q) => p - q),
      bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      area,
      strokeWidth: widths.length ? widths[widths.length >> 1] : 0,
    });
  }
  // Reading order: top to bottom, then left to right, with a row tolerance so
  // a slightly baseline-shifted element doesn't jump ahead of its own line.
  groups.sort((a, b) => {
    const rowTol = Math.min(a.bbox.h, b.bbox.h) * 0.5;
    if (Math.abs(a.bbox.y - b.bbox.y) > rowTol) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  });
  return groups;
}

/**
 * A clustering gap derived from the artwork itself: letters within a word sit
 * about a stroke width apart, so a small multiple of the median stroke width
 * separates "same line of type" from "different element" without the caller
 * guessing absolute millimetres. Falls back to a fraction of the artwork's
 * diagonal when stroke width can't be measured.
 */
export function suggestGapPx(rings: TracedRing[]): number {
  return medianWidth(rings) * 1.5;
}

/** Median characteristic stroke width over exterior contours (px). */
function medianWidth(rings: TracedRing[]): number {
  const widths = rings.filter((r) => !r.isHole).map((r) => ringWidth(r.points)).filter((w) => w > 0);
  if (!widths.length) return 0;
  widths.sort((a, b) => a - b);
  return widths[widths.length >> 1];
}

/** Even-odd point-in-polygon test. */
function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
