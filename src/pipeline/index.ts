import { extractMask, filterIslands, morphOpenClose } from './mask';
import { distanceTransform } from './edt';
import { traceOffset } from './trace';
import {
  beziersToSvgPath,
  bezierRingToPolyline,
  chaikinClosed,
  circleBezier,
  fitBezierRing,
  minRadiusClose,
  roundedRectBezier,
  simplifyRing,
} from './geometry';
import type { BezierRing, CutlineParams, CutlineResult, Pt, RasterImage } from './types';

export * from './types';

/** Head-room around the artwork so the offset band never clips (mm). */
const PAD_MM = 16;
const now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * Owns the cached intermediate stages: binary mask -> distance field.
 * The distance field is the expensive part and is independent of the offset,
 * so dragging the offset slider only re-runs trace + smoothing.
 */
export class CutlineEngine {
  private mask: Uint8Array | null = null;
  private maskW = 0;
  private maskH = 0;
  private pad = 0;
  private usedAlpha = false;
  private maskKey = '';
  private dist: Float32Array | null = null;

  constructor(
    private img: RasterImage,
    /** work px / source px (<= 1 when the image was downscaled). */
    private workScale: number
  ) {}

  compute(params: CutlineParams): CutlineResult {
    const timings: Record<string, number> = {};
    const pxPerMm = (params.dpi / 25.4) * this.workScale;
    const minIslandPx2 = Math.max(16, params.minIslandMm2 * pxPerMm * pxPerMm);

    const maskKey = [
      params.alphaThreshold,
      params.bgTolerance,
      params.minIslandMm2,
      params.dpi,
    ].join('|');

    if (!this.mask || maskKey !== this.maskKey) {
      let t = now();
      this.pad = Math.ceil(PAD_MM * pxPerMm);
      const m = extractMask(this.img, {
        alphaThreshold: params.alphaThreshold,
        bgTolerance: params.bgTolerance,
        pad: this.pad,
      });
      this.usedAlpha = m.usedAlpha;
      morphOpenClose(m.mask, m.w, m.h);
      filterIslands(m.mask, m.w, m.h, minIslandPx2, minIslandPx2);
      this.mask = m.mask;
      this.maskW = m.w;
      this.maskH = m.h;
      this.maskKey = maskKey;
      timings.mask = now() - t;

      t = now();
      this.dist = distanceTransform(this.mask, this.maskW, this.maskH);
      timings.edt = now() - t;
    }

    const offsetPx = Math.max(0, params.offsetMm * pxPerMm);
    let t = now();
    const traced = traceOffset(this.dist!, this.maskW, this.maskH, offsetPx, {
      keepHoles: params.keepHoles,
      minHoleAreaPx2: minIslandPx2,
    });
    timings.trace = now() - t;

    t = now();
    const cornerPx = params.minCornerRadiusMm * pxPerMm;
    const closedRings = minRadiusClose(traced, cornerPx);

    // Smooth in work space, then map to source px.
    const chaikinIters = Math.round(Math.min(3, Math.max(0, params.smoothness)));
    const fitErrWork = [0.6, 1.0, 1.5, 2.5][chaikinIters] ?? 1.5;
    const toSrc = (p: Pt): Pt => ({
      x: (p.x - this.pad) / this.workScale,
      y: (p.y - this.pad) / this.workScale,
    });

    const polylines: Pt[][] = [];
    for (const ring of closedRings) {
      const simplified = simplifyRing(ring, 1.25);
      if (!simplified) continue;
      const smoothed =
        chaikinIters > 0 ? chaikinClosed(simplified, chaikinIters) : simplified;
      polylines.push(smoothed.map(toSrc));
    }

    let beziers: BezierRing[];
    let rings: Pt[][];
    if (params.shape === 'contour') {
      const fitErr = fitErrWork / this.workScale;
      beziers = polylines
        .filter((p) => p.length >= 3)
        .map((p) => fitBezierRing(p, fitErr));
      rings = polylines;
    } else {
      const shaped = this.shapeRings(polylines, params);
      beziers = shaped;
      rings = shaped.map((r) => bezierRingToPolyline(r));
    }
    timings.geometry = now() - t;

    const bbox = boundsOf(rings);
    const nodeCount = beziers.reduce((acc, r) => acc + r.length, 0);
    return {
      rings,
      beziers,
      svgPath: beziersToSvgPath(beziers),
      bbox,
      nodeCount,
      usedAlpha: this.usedAlpha,
      timings,
    };
  }

  /** Geometric die shapes derived from the offset contour's extent. */
  private shapeRings(polylines: Pt[][], params: CutlineParams): BezierRing[] {
    if (!polylines.length) return [];
    const b = boundsOf(polylines);
    const pxPerMmSrc = params.dpi / 25.4;
    switch (params.shape) {
      case 'rect':
        return [roundedRectBezier(b.x, b.y, b.w, b.h, 0)];
      case 'rounded': {
        const r = Math.max(params.minCornerRadiusMm, 3) * pxPerMmSrc;
        return [roundedRectBezier(b.x, b.y, b.w, b.h, r)];
      }
      case 'circle': {
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        let r = 0;
        for (const ring of polylines) {
          for (const p of ring) {
            const d = Math.hypot(p.x - cx, p.y - cy);
            if (d > r) r = d;
          }
        }
        return [circleBezier(cx, cy, r)];
      }
      default:
        return [];
    }
  }
}

function boundsOf(rings: Pt[][]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
