import simplify from 'simplify-js';
import fitCurve from 'fit-curve';
import ClipperLib from 'clipper-lib';
import type { BezierRing, BezierSeg, Pt } from './types';
import type { TracedRing } from './trace';
import { signedArea } from './trace';

const CLIPPER_SCALE = 100;

/** Ramer-Douglas-Peucker on a closed ring. Returns null if it collapses. */
export function simplifyRing(pts: Pt[], tolerance: number): Pt[] | null {
  if (pts.length < 3) return null;
  const out = simplify(pts, tolerance, true);
  return out.length >= 3 ? out : null;
}

/** Chaikin corner cutting on a closed ring (converges to a quadratic B-spline). */
export function chaikinClosed(pts: Pt[], iterations: number): Pt[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const out: Pt[] = new Array(cur.length * 2);
    for (let i = 0, n = cur.length; i < n; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % n];
      out[i * 2] = { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 };
      out[i * 2 + 1] = { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 };
    }
    cur = out;
  }
  return cur;
}

function toClipperPaths(rings: TracedRing[]) {
  return rings.map((r) => {
    let pts = r.points;
    // Clipper convention: positive-orientation = outer, negative = hole.
    const positive = signedArea(pts) > 0;
    if (r.isHole === positive) pts = [...pts].reverse();
    return pts.map((p) => ({
      X: Math.round(p.x * CLIPPER_SCALE),
      Y: Math.round(p.y * CLIPPER_SCALE),
    }));
  });
}

function runClipperOffset(input: unknown[], delta: number) {
  const co = new ClipperLib.ClipperOffset(2, 0.2 * CLIPPER_SCALE);
  co.AddPaths(input, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta);
  return out as { X: number; Y: number }[][];
}

const fromClipper = (paths: { X: number; Y: number }[][]): Pt[][] =>
  paths
    .map((p) => p.map((q) => ({ x: q.X / CLIPPER_SCALE, y: q.Y / CLIPPER_SCALE })))
    .filter((p) => p.length >= 3);

/**
 * Geometric offset of traced subpixel contours (Minkowski with a disc,
 * round joins). Because the input contour is subpixel-exact, small offsets
 * stay subpixel-exact — unlike thresholding the integer-grid EDT. Negative
 * delta insets the cut into the artwork. Overlapping results are unioned
 * by Clipper automatically.
 */
export function offsetTracedRings(rings: TracedRing[], deltaPx: number): Pt[][] {
  const plain = rings.map((r) => r.points);
  if (Math.abs(deltaPx) <= 0.02 || plain.length === 0) return plain;
  try {
    const out = fromClipper(runClipperOffset(toClipperPaths(rings), deltaPx * CLIPPER_SCALE));
    return out.length ? out : plain;
  } catch {
    return plain;
  }
}

/**
 * Morphological closing on polygons (offset +r then -r, round joins) via
 * Clipper. Fills any concave feature tighter than r to an r-radius arc —
 * the "minimum corner radius" guarantee drag-knife blades want. Convex
 * corners are already rounded to the offset distance by the EDT dilation.
 */
export function minRadiusClose(rings: TracedRing[], radiusPx: number): Pt[][] {
  const plain = rings.map((r) => r.points);
  if (radiusPx <= 0.05 || plain.length === 0) return plain;
  try {
    const grown = runClipperOffset(toClipperPaths(rings), radiusPx * CLIPPER_SCALE);
    const closed = runClipperOffset(grown, -radiusPx * CLIPPER_SCALE);
    if (!closed.length) return plain;
    return fromClipper(closed);
  } catch {
    return plain;
  }
}

/**
 * Per-contour minimum-corner-radius closing (v3).
 *
 * The whole-set version above dilates every ring into one Clipper solution,
 * so closing by r welds any two contours whose gap is under 2r — at the
 * default 1mm radius that fuses letters spaced under 2mm, which is most
 * text below ~72pt, and fills counters (the bowls of o/e/a) of the same
 * scale. Closing exists only to guarantee a blade-clearance radius on
 * *concave* corners, which is a property of a single contour; it was never
 * meant to merge separate pieces of art.
 *
 * Closing each exterior contour with its own holes independently keeps that
 * guarantee while leaving distinct glyphs distinct. Holes travel with the
 * exterior that contains them so an inset counter is still closed against
 * its own outline.
 */
export function minRadiusClosePerContour(rings: TracedRing[], radiusPx: number): Pt[][] {
  const plain = rings.map((r) => r.points);
  if (radiusPx <= 0.05 || plain.length === 0) return plain;

  const outers = rings.filter((r) => !r.isHole);
  const holes = rings.filter((r) => r.isHole);
  // No exterior rings (shouldn't happen) — fall back to the global behavior.
  if (!outers.length) return minRadiusClose(rings, radiusPx);

  const out: Pt[][] = [];
  for (const outer of outers) {
    // Group holes by the exterior contour that contains them, so a counter
    // is closed against its own glyph rather than against the whole word.
    const owned = holes.filter((hole) => hole.points.length > 0 && pointInRing(hole.points[0], outer.points));
    const group = owned.length ? [outer, ...owned] : [outer];

    // Clamp the closing radius to the contour's own scale. Closing by r
    // erases any feature narrower than 2r, so on a glyph whose counter or
    // stem is thinner than that, an unclamped radius pinches the counter
    // shut or splits it in two — which showed up as ring counts drifting
    // both below and above the true contour count. A quarter of the
    // smallest feature in the group keeps the blade-clearance guarantee
    // wherever there is room for it, and backs off where there isn't.
    let limit = ringScale(outer.points);
    for (const h of owned) limit = Math.min(limit, ringScale(h.points));
    const r = Math.min(radiusPx, Math.max(0, limit / 4));
    if (r <= 0.05) {
      out.push(...group.map((g) => g.points));
      continue;
    }

    try {
      const grown = runClipperOffset(toClipperPaths(group), r * CLIPPER_SCALE);
      const closed = runClipperOffset(grown, -r * CLIPPER_SCALE);
      if (closed.length) out.push(...fromClipper(closed));
      else out.push(...group.map((g) => g.points));
    } catch {
      out.push(...group.map((g) => g.points));
    }
  }
  // Any hole not contained by an exterior ring passes through untouched.
  for (const hole of holes) {
    if (!outers.some((o) => hole.points.length > 0 && pointInRing(hole.points[0], o.points))) {
      out.push(hole.points);
    }
  }
  return out.length ? out : plain;
}

/**
 * Characteristic width of a ring: 2 * area / perimeter, i.e. the diameter of
 * the disc with the same area-to-perimeter ratio. For a long thin stroke this
 * is the stroke width, which is the dimension a closing radius can destroy.
 */
function ringScale(pts: Pt[]): number {
  if (pts.length < 3) return 0;
  let area = 0;
  let perim = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    area += p.x * q.y - q.x * p.y;
    perim += Math.hypot(q.x - p.x, q.y - p.y);
  }
  if (perim <= 0) return 0;
  return (2 * Math.abs(area / 2)) / perim;
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

/** Schneider cubic fit of a closed ring. */
export function fitBezierRing(pts: Pt[], maxError: number): BezierRing {
  const flat = pts.map((p) => [p.x, p.y]);
  flat.push([pts[0].x, pts[0].y]);
  const segs = fitCurve(flat, maxError);
  return segs.map(toBezierSeg);
}

const toBezierSeg = (s: number[][]): BezierSeg => [
  { x: s[0][0], y: s[0][1] },
  { x: s[1][0], y: s[1][1] },
  { x: s[2][0], y: s[2][1] },
  { x: s[3][0], y: s[3][1] },
];

/**
 * Turning-angle corner detection on a closed subpixel polyline: at each
 * vertex compare the chords to points ±s arc-length away; a vertex is a
 * corner if the turn exceeds `angleDeg` and is the local maximum within ±s
 * (non-max suppression). Returns vertex indices, ascending.
 */
export function detectCorners(pts: Pt[], s: number, angleDeg: number): number[] {
  const n = pts.length;
  if (n < 8) return [];
  const thetaMin = (angleDeg * Math.PI) / 180;

  const ptAtArc = (start: number, dir: 1 | -1): Pt => {
    let remaining = s;
    let i = start;
    for (let hops = 0; hops < n; hops++) {
      const j = (i + dir + n) % n;
      const d = Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
      if (d >= remaining) {
        const t = remaining / (d || 1);
        return {
          x: pts[i].x + (pts[j].x - pts[i].x) * t,
          y: pts[i].y + (pts[j].y - pts[i].y) * t,
        };
      }
      remaining -= d;
      i = j;
    }
    return pts[i];
  };

  const turn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = ptAtArc(i, -1);
    const f = ptAtArc(i, 1);
    const v1x = pts[i].x - b.x;
    const v1y = pts[i].y - b.y;
    const v2x = f.x - pts[i].x;
    const v2y = f.y - pts[i].y;
    const dot = v1x * v2x + v1y * v2y;
    const cross = v1x * v2y - v1y * v2x;
    turn[i] = Math.abs(Math.atan2(cross, dot));
  }

  // non-max suppression within +-s arc length (approximated by vertex hops
  // covering that arc; trace vertices are ~0.5-1.4px apart)
  const hopWindow = Math.max(2, Math.round(s));
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < thetaMin) continue;
    let isMax = true;
    for (let d = 1; d <= hopWindow && isMax; d++) {
      if (turn[(i + d) % n] > turn[i] || turn[(i - d + n) % n] > turn[i]) isMax = false;
    }
    if (isMax) corners.push(i);
  }
  return corners;
}

/**
 * Fit a closed ring with corners preserved: split at detected corners and
 * Schneider-fit each open run separately, so curves get smooth beziers while
 * true corners stay pinned and sharp. RDP runs per segment (endpoints kept).
 */
export function fitRingWithCorners(
  ring: Pt[],
  rdpTol: number,
  fitError: number,
  cornerArcPx: number,
  cornerAngleDeg: number
): { beziers: BezierRing; polyline: Pt[] } {
  const corners = detectCorners(ring, cornerArcPx, cornerAngleDeg);
  if (corners.length < 2) {
    const simplified = simplifyRing(ring, rdpTol) ?? ring;
    return { beziers: fitBezierRing(simplified, fitError), polyline: simplified };
  }

  const n = ring.length;
  const beziers: BezierRing = [];
  const polyline: Pt[] = [];
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c];
    const b = corners[(c + 1) % corners.length];
    const seg: Pt[] = [];
    for (let i = a; ; i = (i + 1) % n) {
      seg.push(ring[i]);
      if (i === b) break;
    }
    if (seg.length < 2) continue;
    const dec =
      seg.length > 2 ? simplify(seg, rdpTol, true) : seg;
    polyline.push(...dec.slice(0, dec.length - 1));
    if (dec.length < 2) continue;
    const segs = fitCurve(dec.map((p) => [p.x, p.y]), fitError);
    for (const s of segs) beziers.push(toBezierSeg(s));
  }
  return { beziers, polyline: polyline.length >= 3 ? polyline : ring };
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

export function beziersToSvgPath(rings: BezierRing[]): string {
  const parts: string[] = [];
  for (const ring of rings) {
    if (!ring.length) continue;
    parts.push(`M ${fmt(ring[0][0].x)} ${fmt(ring[0][0].y)}`);
    for (const [, c1, c2, p1] of ring) {
      parts.push(
        `C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(p1.x)} ${fmt(p1.y)}`
      );
    }
    parts.push('Z');
  }
  return parts.join(' ');
}

/** Sample each cubic of a bezier ring into a polyline (for DXF / bounds). */
export function bezierRingToPolyline(ring: BezierRing, samplesPerSeg = 12): Pt[] {
  const out: Pt[] = [];
  for (const [p0, c1, c2, p1] of ring) {
    for (let i = 0; i < samplesPerSeg; i++) {
      const t = i / samplesPerSeg;
      const mt = 1 - t;
      out.push({
        x: mt * mt * mt * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p1.x,
        y: mt * mt * mt * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p1.y,
      });
    }
  }
  return out;
}

const KAPPA = 0.5522847498;

export function circleBezier(cx: number, cy: number, r: number): BezierRing {
  const k = KAPPA * r;
  const p = (x: number, y: number): Pt => ({ x, y });
  return [
    [p(cx + r, cy), p(cx + r, cy + k), p(cx + k, cy + r), p(cx, cy + r)],
    [p(cx, cy + r), p(cx - k, cy + r), p(cx - r, cy + k), p(cx - r, cy)],
    [p(cx - r, cy), p(cx - r, cy - k), p(cx - k, cy - r), p(cx, cy - r)],
    [p(cx, cy - r), p(cx + k, cy - r), p(cx + r, cy - k), p(cx + r, cy)],
  ];
}

export function roundedRectBezier(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): BezierRing {
  const rr = Math.min(r, w / 2, h / 2);
  const k = KAPPA * rr;
  const p = (px: number, py: number): Pt => ({ x: px, y: py });
  const line = (a: Pt, b: Pt): BezierSeg => [
    a,
    p(a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3),
    p(a.x + ((b.x - a.x) * 2) / 3, a.y + ((b.y - a.y) * 2) / 3),
    b,
  ];
  if (rr <= 0.01) {
    const a = p(x, y);
    const b = p(x + w, y);
    const c = p(x + w, y + h);
    const d = p(x, y + h);
    return [line(a, b), line(b, c), line(c, d), line(d, a)];
  }
  const segs: BezierRing = [];
  segs.push(line(p(x + rr, y), p(x + w - rr, y)));
  segs.push([p(x + w - rr, y), p(x + w - rr + k, y), p(x + w, y + rr - k), p(x + w, y + rr)]);
  segs.push(line(p(x + w, y + rr), p(x + w, y + h - rr)));
  segs.push([
    p(x + w, y + h - rr),
    p(x + w, y + h - rr + k),
    p(x + w - rr + k, y + h),
    p(x + w - rr, y + h),
  ]);
  segs.push(line(p(x + w - rr, y + h), p(x + rr, y + h)));
  segs.push([p(x + rr, y + h), p(x + rr - k, y + h), p(x, y + h - rr + k), p(x, y + h - rr)]);
  segs.push(line(p(x, y + h - rr), p(x, y + rr)));
  segs.push([p(x, y + rr), p(x, y + rr - k), p(x + rr - k, y), p(x + rr, y)]);
  return segs;
}
