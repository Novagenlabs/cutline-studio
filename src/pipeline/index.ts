import { extractMask, filterIslands, legacyMorphOpenClose, reconcileField } from './mask';
import { distanceTransform } from './edt';
import { traceField, signedArea } from './trace';
import type { TracedRing } from './trace';
import {
  beziersToSvgPath,
  bezierRingToPolyline,
  chaikinClosed,
  circleBezier,
  fitBezierRing,
  fitRingWithCorners,
  minRadiusClose,
  minRadiusClosePerContour,
  offsetTracedRings,
  roundedRectBezier,
  simplifyRing,
} from './geometry';
import type { BezierRing, CutlineParams, CutlineResult, Pt, RasterImage } from './types';

export * from './types';

/** Head-room around the artwork so offset + bridge dilation never clips (mm). */
const PAD_MM = 32;
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
  private field: Float32Array | null = null;
  private fieldThreshold = 128;

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
      params.denoisePx,
      params.hugBody,
      params.minIslandMm2,
      params.dpi,
      JSON.stringify(params.regions ?? []),
    ].join('|');

    if (!this.mask || maskKey !== this.maskKey) {
      let t = now();
      this.pad = Math.ceil(PAD_MM * pxPerMm);
      const base = extractMask(this.img, {
        alphaThreshold: params.alphaThreshold,
        bgTolerance: params.bgTolerance,
        pad: this.pad,
        denoiseSigma: params.denoisePx,
        bodyMode: params.hugBody,
      });
      this.usedAlpha = base.usedAlpha;

      // Normalize to a zero-iso field (value - local threshold) so regions
      // with different thresholds composite into one traceable field.
      const field = base.field;
      const thrBase = base.usedAlpha ? params.alphaThreshold : 128;
      for (let i = 0; i < field.length; i++) field[i] -= thrBase;

      // Region overrides: recompute the field with the region's parameters
      // and blend it in over the rectangle with a 4px feather so the traced
      // contour crosses the boundary without a seam.
      for (const r of params.regions ?? []) {
        if (r.alphaThreshold == null && r.denoisePx == null && r.hugBody == null) continue;
        const o = extractMask(this.img, {
          alphaThreshold: r.alphaThreshold ?? params.alphaThreshold,
          bgTolerance: params.bgTolerance,
          pad: this.pad,
          denoiseSigma: r.denoisePx ?? params.denoisePx,
          bodyMode: r.hugBody ?? params.hugBody,
        });
        const thrO = o.usedAlpha ? (r.alphaThreshold ?? params.alphaThreshold) : 128;
        const of = o.field;
        const ws = this.workScale;
        const x0 = r.x * ws + this.pad;
        const y0 = r.y * ws + this.pad;
        const x1 = (r.x + r.w) * ws + this.pad;
        const y1 = (r.y + r.h) * ws + this.pad;
        const F = 4;
        const yA = Math.max(0, Math.floor(y0));
        const yB = Math.min(base.h - 1, Math.ceil(y1));
        const xA = Math.max(0, Math.floor(x0));
        const xB = Math.min(base.w - 1, Math.ceil(x1));
        for (let y = yA; y <= yB; y++) {
          for (let x = xA; x <= xB; x++) {
            const wgt = Math.min((x - x0) / F, (x1 - x) / F, (y - y0) / F, (y1 - y) / F, 1);
            if (wgt <= 0) continue;
            const i = y * base.w + x;
            field[i] = field[i] * (1 - wgt) + (of[i] - thrO) * wgt;
          }
        }
      }

      const mask = new Uint8Array(field.length);
      for (let i = 0; i < field.length; i++) mask[i] = field[i] >= 0 ? 1 : 0;
      filterIslands(mask, base.w, base.h, minIslandPx2, minIslandPx2);
      reconcileField(field, mask, 0);
      this.fieldThreshold = 0;
      this.mask = mask;
      this.field = field;
      this.maskW = base.w;
      this.maskH = base.h;
      this.maskKey = maskKey;
      timings.mask = now() - t;

      t = now();
      this.dist = distanceTransform(this.mask, this.maskW, this.maskH);
      timings.edt = now() - t;
    }

    const offsetPx = params.offsetMm * pxPerMm; // negative = inset into the art
    const bridgePx = Math.max(0, (params.bridgeMm / 2) * pxPerMm);
    const holeMinPx2 = Math.max(minIslandPx2, params.holeMinMm2 * pxPerMm * pxPerMm);
    const traceOpts = { keepHoles: params.keepHoles, minHoleAreaPx2: holeMinPx2 };
    const v3 = params.engineVersion === 'v3';
    // Small offsets ride the subpixel field trace + exact geometric offset;
    // beyond this the EDT (which merges regions for free) takes over.
    // v3 keeps the exact geometric path at every offset: Clipper's round-join
    // offset is a true Minkowski sum, so it merges touching bands the same way
    // the EDT does, but without quantizing the result to the integer pixel
    // grid — which is what produced a ~0.9px asymmetric error the moment the
    // offset crossed this threshold.
    const geomLimitPx = v3 ? Infinity : 2 * pxPerMm;

    let t = now();
    let traced: TracedRing[];
    if (bridgePx < 0.25 && offsetPx <= geomLimitPx) {
      // Tight cut: trace the continuous coverage field at the threshold —
      // the contour follows the anti-aliased edge with subpixel accuracy,
      // which binarize-then-EDT can't do (it quantizes to the pixel grid).
      // The offset is then applied geometrically (Clipper, round joins) so
      // it stays subpixel-exact and supports negative (inset) values.
      const traced0 = traceField(
        this.field!,
        this.maskW,
        this.maskH,
        this.fieldThreshold,
        'gte',
        traceOpts
      );
      traced =
        Math.abs(offsetPx) <= 0.02
          ? traced0
          : offsetTracedRings(traced0, offsetPx).map((points) => ({
              points,
              isHole: signedArea(points) < 0,
            }));
    } else if (bridgePx < 0.25) {
      traced = traceField(
        this.dist!,
        this.maskW,
        this.maskH,
        Math.max(0, offsetPx),
        'lte',
        traceOpts
      );
    } else {
      // Morphological closing of the offset region: dilate by the bridge
      // radius, then erode by the same amount. Gaps narrower than the bridge
      // merge; scalloped concavities of that scale are smoothed over; the
      // border width stays at `offset`. Both steps are EDT thresholds, and
      // the final erosion is traced on the distance field for a subpixel
      // result.
      const n = this.maskW * this.maskH;
      const region = new Uint8Array(n);
      const dist = this.dist!;
      const offClamped = Math.max(0, offsetPx);
      for (let i = 0; i < n; i++) region[i] = dist[i] <= offClamped ? 1 : 0;
      const dDilate = distanceTransform(region, this.maskW, this.maskH);
      for (let i = 0; i < n; i++) region[i] = dDilate[i] <= bridgePx ? 0 : 1; // complement of dilated
      const dErode = distanceTransform(region, this.maskW, this.maskH);
      traced = traceField(dErode, this.maskW, this.maskH, bridgePx, 'gte', traceOpts);
    }
    timings.trace = now() - t;

    t = now();
    const cornerPx = params.minCornerRadiusMm * pxPerMm;
    const closedRings = v3
      ? minRadiusClosePerContour(traced, cornerPx)
      : minRadiusClose(traced, cornerPx);

    // Fit in work space, then map to source px. Tolerances are physical (mm)
    // so fidelity doesn't depend on the working resolution. Corners are
    // detected on the raw subpixel trace and pinned — curves get smooth
    // beziers, true corners (like an H's serifs) stay sharp. Smoothness
    // relaxes both the corner gate and the fit tolerance instead of running
    // shape-shrinking Chaikin passes.
    const s = Math.round(Math.min(3, Math.max(0, params.smoothness)));
    const cornerAngleDeg = [45, 60, 75, 88][s];
    const fitMult = [0.7, 1, 1.7, 2.6][s];
    const rdpTolPx = Math.max(0.35, params.precisionMm * pxPerMm * 0.6);
    const fitErrPx = Math.max(0.35, params.precisionMm * 1.3 * pxPerMm) * fitMult;
    const toSrc = (p: Pt): Pt => ({
      x: (p.x - this.pad) / this.workScale,
      y: (p.y - this.pad) / this.workScale,
    });

    let beziers: BezierRing[] = [];
    let rings: Pt[][] = [];
    if (params.shape === 'contour') {
      for (const ring of closedRings) {
        if (ring.length < 3) continue;
        const fitted = fitRingWithCorners(ring, rdpTolPx, fitErrPx, 2.5, cornerAngleDeg);
        if (!fitted.beziers.length) continue;
        beziers.push(fitted.beziers.map((seg) => seg.map(toSrc) as typeof seg));
        rings.push(fitted.polyline.map(toSrc));
      }
    } else {
      const bounds: Pt[][] = [];
      for (const ring of closedRings) {
        const simplified = simplifyRing(ring, rdpTolPx);
        if (simplified) bounds.push(simplified.map(toSrc));
      }
      beziers = this.shapeRings(bounds, params);
      rings = beziers.map((r) => bezierRingToPolyline(r));
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

  private v1Key = '';
  private v1Dist: Float32Array | null = null;
  private v1W = 0;
  private v1H = 0;
  private v1Pad = 0;

  /**
   * Faithful replica of the first-commit pipeline, for A/B comparison:
   * binary alpha threshold -> 3x3 morph open/close -> island filter ->
   * EDT threshold trace -> RDP 1.25px -> Chaikin x2 -> whole-ring bezier
   * fit at 1.5px. No subpixel field, no corner pinning, no body mode.
   */
  computeV1(params: CutlineParams): { svgPath: string; ringCount: number; nodeCount: number } {
    const pxPerMm = (params.dpi / 25.4) * this.workScale;
    const minIslandPx2 = Math.max(16, params.minIslandMm2 * pxPerMm * pxPerMm);
    const key = [params.alphaThreshold, params.bgTolerance, params.dpi].join('|');
    if (!this.v1Dist || key !== this.v1Key) {
      const pad = Math.ceil(PAD_MM * pxPerMm);
      const m = extractMask(this.img, {
        alphaThreshold: params.alphaThreshold,
        bgTolerance: params.bgTolerance,
        pad,
        denoiseSigma: 0,
        bodyMode: false,
      });
      legacyMorphOpenClose(m.mask, m.w, m.h);
      filterIslands(m.mask, m.w, m.h, minIslandPx2, minIslandPx2);
      this.v1Dist = distanceTransform(m.mask, m.w, m.h);
      this.v1W = m.w;
      this.v1H = m.h;
      this.v1Pad = pad;
      this.v1Key = key;
    }
    const offsetPx = Math.max(0, params.offsetMm * pxPerMm);
    const traced = traceField(this.v1Dist, this.v1W, this.v1H, offsetPx, 'lte', {
      keepHoles: params.keepHoles,
      minHoleAreaPx2: minIslandPx2,
    });
    const toSrc = (p: Pt): Pt => ({
      x: (p.x - this.v1Pad) / this.workScale,
      y: (p.y - this.v1Pad) / this.workScale,
    });
    const beziers: BezierRing[] = [];
    for (const ring of traced) {
      const simplified = simplifyRing(ring.points, 1.25);
      if (!simplified) continue;
      const smoothed = chaikinClosed(simplified, 2).map(toSrc);
      beziers.push(fitBezierRing(smoothed, 1.5 / this.workScale));
    }
    return {
      svgPath: beziersToSvgPath(beziers),
      ringCount: beziers.length,
      nodeCount: beziers.reduce((a, r) => a + r.length, 0),
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
