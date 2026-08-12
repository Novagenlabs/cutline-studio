import { extractMask, filterIslands, reconcileField } from './mask';
import { distanceTransform } from './edt';
import { traceField, signedArea } from './trace';
import type { TracedRing } from './trace';
import {
  beziersToSvgPath,
  bezierRingToPolyline,
  circleBezier,
  fitRingWithCorners,
  minRadiusClose,
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
    ].join('|');

    if (!this.mask || maskKey !== this.maskKey) {
      let t = now();
      this.pad = Math.ceil(PAD_MM * pxPerMm);
      const m = extractMask(this.img, {
        alphaThreshold: params.alphaThreshold,
        bgTolerance: params.bgTolerance,
        pad: this.pad,
        denoiseSigma: params.denoisePx,
        bodyMode: params.hugBody,
      });
      this.usedAlpha = m.usedAlpha;
      this.fieldThreshold = m.usedAlpha ? params.alphaThreshold : 128;
      filterIslands(m.mask, m.w, m.h, minIslandPx2, minIslandPx2);
      reconcileField(m.field, m.mask, this.fieldThreshold);
      this.mask = m.mask;
      this.field = m.field;
      this.maskW = m.w;
      this.maskH = m.h;
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
    // Small offsets ride the subpixel field trace + exact geometric offset;
    // beyond this the EDT (which merges regions for free) takes over.
    const geomLimitPx = 2 * pxPerMm;

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
    const closedRings = minRadiusClose(traced, cornerPx);

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
