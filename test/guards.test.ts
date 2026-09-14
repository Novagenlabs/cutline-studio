import { describe, expect, it } from 'vitest';
import type { Pt } from '../src/pipeline/types';

/**
 * The two guards added after auditing an upscaled logo.
 *
 * "Cut interior holes" looked broken: on that artwork it produced
 * byte-identical output whether on or off — 46 rings and 9848 nodes either
 * way. It is not broken. After a background removal that took only the OUTER
 * background, every enclosed area is still opaque artwork, so there are no
 * holes for the flag to keep. Once the enclosed white was actually removed
 * the same flag gave 66 rings and 12,587 nodes.
 *
 * A control that silently does nothing is worse than an absent one, so the UI
 * now detects that state. And the node count itself was three times what the
 * un-upscaled source produced, which is worth flagging: a plotter runs the
 * path node by node.
 */

/** A hole winds opposite to its parent, so its signed area is negative. */
function signedArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  return a / 2;
}

/**
 * Holes exist when the rings do not all wind the same way.
 *
 * Which sign means "hole" depends on the coordinate system — in screen space
 * (y down) an outline comes out negative — so comparing against a fixed sign
 * is a bug waiting for a different input. Mixed winding is the real signal.
 */
const hasHoles = (rings: Pt[][]) => {
  let pos = 0;
  let neg = 0;
  for (const r of rings) {
    const a = signedArea(r);
    if (a > 0) pos++;
    else if (a < 0) neg++;
  }
  return pos > 0 && neg > 0;
};

/** Clockwise square — an outline. */
const outline = (s = 100): Pt[] => [
  { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
];
/** Counter-clockwise square — a hole. */
const hole = (s = 40, o = 30): Pt[] => [
  { x: o, y: o }, { x: o, y: o + s }, { x: o + s, y: o + s }, { x: o + s, y: o },
];

describe('detecting that there are no holes to cut', () => {
  it('an outline alone has none', () => {
    expect(hasHoles([outline()])).toBe(false);
  });

  it('an outline with an enclosed ring has one', () => {
    expect(hasHoles([outline(), hole()])).toBe(true);
  });

  it('several outlines still have none', () => {
    // The exact shape of the bug: 46 separate shapes, no holes among them,
    // so the checkbox had nothing to act on.
    const many = Array.from({ length: 46 }, () => outline());
    expect(hasHoles(many)).toBe(false);
  });

  it('a single ring is an outline whichever way it winds', () => {
    // Mixed winding is the signal, so one ring can never be a hole — it has
    // nothing to be enclosed BY. The first version of this test expected a
    // lone reversed ring to count, which would have made any single-shape
    // artwork claim to have holes.
    expect(hasHoles([hole()])).toBe(false);
    expect(hasHoles([outline()])).toBe(false);
  });

  it('sees a hole regardless of which sign the outline takes', () => {
    expect(hasHoles([outline(), hole()])).toBe(true);
    // Same pair with both windings flipped: still one of each, still a hole.
    expect(hasHoles([[...outline()].reverse(), [...hole()].reverse()])).toBe(true);
  });
});

/** Nodes per mm of bounding-box perimeter, as the warning computes it. */
function density(nodeCount: number, bbox: { w: number; h: number }, dpi: number): number {
  const perimeterMm = ((2 * (bbox.w + bbox.h)) / dpi) * 25.4;
  return perimeterMm > 0 ? nodeCount / perimeterMm : 0;
}
const isBusy = (n: number, bbox: { w: number; h: number }, dpi = 300) =>
  density(n, bbox, dpi) > 11 && n > 2000;

describe('flagging a path denser than the artwork warrants', () => {
  it('accepts the un-upscaled crest', () => {
    // 1369x1149 source, 3208 nodes over a 389mm perimeter = 8.3 nodes/mm.
    // This one traced cleanly and must not be flagged, which is why the
    // threshold sits above it rather than at 8.
    expect(isBusy(3208, { w: 1230, h: 1065 })).toBe(false);
  });

  it('flags the upscaled one', () => {
    // Same artwork at 2738x2298: 9848 nodes for no extra detail.
    expect(isBusy(9848, { w: 2460, h: 2130 })).toBe(true);
  });

  it('judges by size, not by a flat node ceiling', () => {
    // A big detailed piece may legitimately carry many nodes; a small logo
    // carrying the same count is describing noise.
    const big = { w: 8000, h: 8000 };
    const small = { w: 300, h: 300 };
    expect(isBusy(9000, big)).toBe(false);
    expect(isBusy(9000, small)).toBe(true);
  });

  it('stays quiet on small paths whatever their density', () => {
    // Below 2000 nodes there is nothing worth interrupting for, even if the
    // ratio is high on a tiny shape.
    expect(isBusy(500, { w: 50, h: 50 })).toBe(false);
  });

  it('does not divide by zero on an empty bbox', () => {
    expect(() => isBusy(3000, { w: 0, h: 0 })).not.toThrow();
    expect(isBusy(3000, { w: 0, h: 0 })).toBe(false);
  });
});
