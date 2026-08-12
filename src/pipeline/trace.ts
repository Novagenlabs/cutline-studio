import { contours } from 'd3-contour';
import type { Pt } from './types';

export interface TracedRing {
  points: Pt[];
  isHole: boolean;
}

/**
 * Marching-squares trace of an iso-contour on a distance field.
 * `sense: 'lte'` traces the region `field <= iso` (offset band around the
 * art); `sense: 'gte'` traces `field >= iso` (erosion of a dilated region).
 * d3-contour interpolates crossings, so the result is subpixel-smooth.
 * Rings come back GeoJSON-style: exterior first, holes after, closed
 * (first == last point) — we strip the duplicate.
 */
export function traceField(
  field: Float32Array,
  w: number,
  h: number,
  iso: number,
  sense: 'lte' | 'gte',
  opts: { keepHoles: boolean; minHoleAreaPx2: number }
): TracedRing[] {
  // d3-contour marks cells where value >= threshold; negate for 'lte'.
  let values: ArrayLike<number> = field;
  let threshold = iso;
  if (sense === 'lte') {
    const neg = new Float64Array(field.length);
    for (let i = 0; i < field.length; i++) neg[i] = -field[i];
    values = neg;
    threshold = -iso;
  }

  const gen = contours()
    .size([w, h])
    .smooth(true)
    .thresholds([threshold]);
  const multi = gen(values as unknown as number[])[0];
  const rings: TracedRing[] = [];
  if (!multi) return rings;

  for (const polygon of multi.coordinates) {
    polygon.forEach((coords, idx) => {
      const isHole = idx > 0;
      if (isHole && !opts.keepHoles) return;
      const pts: Pt[] = [];
      // strip GeoJSON closing duplicate
      const n = coords.length - 1;
      for (let i = 0; i < n; i++) pts.push({ x: coords[i][0], y: coords[i][1] });
      if (pts.length < 3) return;
      if (isHole && Math.abs(signedArea(pts)) < opts.minHoleAreaPx2) return;
      rings.push({ points: pts, isHole });
    });
  }
  return rings;
}

export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
