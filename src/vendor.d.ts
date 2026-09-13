/// <reference types="@webgpu/types" />
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


/**
 * WGSL shader sources, imported as text by the esbuild `--loader:.wgsl=text`
 * rule. The vendored vgpu flare imports its four passes this way.
 */
declare module '*.wgsl' {
  const source: string;
  export default source;
}
