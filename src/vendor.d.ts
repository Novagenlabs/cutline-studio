declare module 'clipper-lib' {
  const ClipperLib: any;
  export default ClipperLib;
}

declare module 'fit-curve' {
  /** Schneider cubic-bezier fitting. Returns segments [p0, c1, c2, p1] as [x,y] pairs. */
  export default function fitCurve(points: number[][], maxError: number): number[][][];
}

declare module 'simplify-js' {
  interface SimplifyPoint {
    x: number;
    y: number;
  }
  export default function simplify(
    points: SimplifyPoint[],
    tolerance?: number,
    highQuality?: boolean
  ): SimplifyPoint[];
}

