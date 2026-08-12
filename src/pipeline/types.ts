export interface Pt {
  x: number;
  y: number;
}

/** One closed cubic-bezier ring: list of segments [p0, c1, c2, p1] in source-image px. */
export type BezierSeg = [Pt, Pt, Pt, Pt];
export type BezierRing = BezierSeg[];

export type ShapeMode = 'contour' | 'rect' | 'rounded' | 'circle';

/** Local parameter overrides applied inside a rectangle (source px). */
export interface RegionOverride {
  x: number;
  y: number;
  w: number;
  h: number;
  alphaThreshold?: number;
  denoisePx?: number;
  hugBody?: boolean;
}

export interface CutlineParams {
  /** Alpha cutoff 0-255 for images with transparency. */
  alphaThreshold: number;
  /** RGB euclidean tolerance for background flood-fill on opaque images. */
  bgTolerance: number;
  /** Gaussian sigma (px) applied to the coverage field before tracing — JPEG noise / ragged fringe suppression. */
  denoisePx: number;
  /** Trace the colored glyph body, peeling off outside-connected white keylines/glows. */
  hugBody: boolean;
  /** Max deviation (mm) of the fitted cutline from the traced edge. Lower = more faithful, more nodes. */
  precisionMm: number;
  /** Outward offset of the cutline from the artwork edge, in mm. */
  offsetMm: number;
  /**
   * Morphological closing radius control: gaps up to this width between
   * offset regions are bridged into one piece, and scalloped concavities
   * of similar scale are smoothed over — without inflating the border.
   */
  bridgeMm: number;
  /** Interior holes smaller than this (mm^2) are filled (white) instead of cut. */
  holeMinMm2: number;
  /** Print resolution used to map px <-> mm. */
  dpi: number;
  /** 0 = raw trace, 3 = very smooth. Controls Chaikin iterations + bezier fit error. */
  smoothness: number;
  /** Minimum concave corner radius in mm (0 disables the Clipper closing pass). */
  minCornerRadiusMm: number;
  /** Keep interior holes that survive the offset (vinyl decals). Default drops them. */
  keepHoles: boolean;
  /** Islands smaller than this (mm^2) are treated as noise and dropped. */
  minIslandMm2: number;
  shape: ShapeMode;
  /** Per-rectangle overrides of threshold/denoise/body mode, feather-blended into the global field. */
  regions: RegionOverride[];
}

export const DEFAULT_PARAMS: CutlineParams = {
  alphaThreshold: 128,
  bgTolerance: 32,
  denoisePx: 0.4,
  hugBody: false,
  precisionMm: 0.08,
  offsetMm: 3,
  bridgeMm: 0,
  holeMinMm2: 1,
  dpi: 300,
  smoothness: 2,
  minCornerRadiusMm: 1,
  keepHoles: false,
  minIslandMm2: 1,
  shape: 'contour',
  regions: [],
};

export interface CutlineResult {
  /** Polygon rings (polyline approximation) in source-image px, y-down. */
  rings: Pt[][];
  /** Smooth cubic-bezier rings in source-image px. */
  beziers: BezierRing[];
  /** SVG path data ("M .. C .. Z" per ring) in source-image px. */
  svgPath: string;
  /** Bounding box of the cutline in source px. */
  bbox: { x: number; y: number; w: number; h: number };
  nodeCount: number;
  usedAlpha: boolean;
  timings: Record<string, number>;
}

/** Minimal ImageData shape so the pipeline also runs under node for tests. */
export interface RasterImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
