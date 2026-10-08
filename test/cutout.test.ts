import { describe, expect, it } from 'vitest';
import {
  upsampleMatte,
  applyStrokes,
  cutout,
  floodMatte,
  allColourMatte,
  erodeMatte,
  coverage,
  keptOpaque,
  keptOpaqueStats,
} from '../src/ai/cutout';
import type { RasterImage } from '../src/pipeline/types';

/**
 * Background removal, as an operation on pixels.
 *
 * The matte already existed but only positioned the cut line — it never
 * touched the artwork, so a logo on a white card exported with the white
 * still behind it. These tests cover turning a matte into a real cutout at
 * full resolution, and the click corrections that fix what the model got
 * wrong.
 */

/** A solid rectangle of `fill` on a `bg` field. */
function scene(
  w: number,
  h: number,
  bg: [number, number, number],
  rect: { x: number; y: number; w: number; h: number },
  fill: [number, number, number]
): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside =
        x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const c = inside ? fill : bg;
      const i = (y * w + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

describe('scaling a matte to the artwork', () => {
  it('leaves a matte that already matches alone', () => {
    const m = new Float32Array([0, 255, 255, 0]);
    expect(upsampleMatte(m, 2, 2, 2, 2)).toBe(m);
  });

  it('grows a small matte to the source size', () => {
    // The model runs on the downscaled working image, so its matte is always
    // smaller than the artwork it has to cut out.
    const m = new Float32Array([0, 0, 255, 255]);
    const out = upsampleMatte(m, 2, 2, 8, 8);
    expect(out.length).toBe(64);
    // Top row came from zeros, bottom row from 255s.
    expect(out[0]).toBeLessThan(64);
    expect(out[63]).toBeGreaterThan(190);
  });

  it('interpolates rather than blocking up', () => {
    // A nearest-neighbour upscale would leave only two distinct values; a
    // diagonal edge would then show stair steps on the cutout.
    const m = new Float32Array([0, 255, 0, 255]);
    const out = upsampleMatte(m, 2, 2, 16, 16);
    const distinct = new Set(Array.from(out).map((v) => Math.round(v / 8)));
    expect(distinct.size).toBeGreaterThan(3);
  });
});

describe('flood removal, for devices without the model', () => {
  const img = scene(60, 60, [255, 255, 255], { x: 20, y: 20, w: 20, h: 20 }, [200, 30, 30]);

  it('drops the background and keeps the subject', () => {
    const m = floodMatte(img);
    const at = (x: number, y: number) => m[y * 60 + x];
    expect(at(1, 1)).toBe(0); // corner: background
    expect(at(30, 30)).toBe(255); // centre: subject
  });

  it('keeps an enclosed hole of background colour', () => {
    // The counter of an O, or a window in a shape: it is background-coloured
    // but not connected to the border, so a flood cannot reach it and the
    // artwork keeps its detail.
    const holed = scene(60, 60, [255, 255, 255], { x: 15, y: 15, w: 30, h: 30 }, [0, 0, 0]);
    for (let y = 25; y < 35; y++) {
      for (let x = 25; x < 35; x++) {
        const i = (y * 60 + x) * 4;
        holed.data[i] = holed.data[i + 1] = holed.data[i + 2] = 255;
      }
    }
    const m = floodMatte(holed);
    expect(m[30 * 60 + 30]).toBe(255); // the hole survives
    expect(m[1 * 60 + 1]).toBe(0); // the outside does not
  });

  it('reports coverage that reflects the subject, not the frame', () => {
    // 20x20 subject in 60x60 = 11%. A failed removal would be ~100%.
    const c = coverage(floodMatte(img));
    expect(c).toBeGreaterThan(0.08);
    expect(c).toBeLessThan(0.15);
  });
});

describe('correcting what the model got wrong', () => {
  const img = scene(40, 40, [255, 255, 255], { x: 10, y: 10, w: 20, h: 20 }, [20, 20, 20]);

  it('a drop stroke removes the whole connected region, not a disc', () => {
    // The point of the rewrite: one click on the background clears all of it,
    // rather than a circle the size of the brush. The old version left the
    // far corner untouched.
    const m = new Float32Array(1600).fill(255);
    const out = applyStrokes(m, img, [{ x: 2, y: 2, r: 20, mode: 'drop' }]);
    expect(out[2 * 40 + 2]).toBe(0);
    expect(out[37 * 40 + 37]).toBe(0); // opposite corner, far beyond any radius
  });

  it('a keep stroke restores the region it lands on', () => {
    const m = new Float32Array(1600).fill(0);
    const out = applyStrokes(m, img, [{ x: 20, y: 20, r: 20, mode: 'keep' }]);
    expect(out[20 * 40 + 20]).toBe(255);
  });

  it('stops at the colour edge', () => {
    // The safety property: flooding the white background must not cross into
    // the dark square, however large the brush.
    const m = new Float32Array(1600).fill(255);
    const out = applyStrokes(m, img, [{ x: 2, y: 2, r: 60, mode: 'drop' }]);
    expect(out[2 * 40 + 2]).toBe(0); // background: gone
    expect(out[20 * 40 + 20]).toBe(255); // subject: untouched
  });

  it('only reaches CONNECTED pixels of that colour', () => {
    // Two separate white areas split by a dark band. Clicking one must not
    // clear the other — otherwise removing a background would punch out white
    // lettering elsewhere in the artwork.
    const w = 40, h = 40;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const band = x >= 18 && x < 22; // dark divider
        const i = (y * w + x) * 4;
        const c = band ? 10 : 255;
        data[i] = data[i + 1] = data[i + 2] = c;
        data[i + 3] = 255;
      }
    const split = { data, width: w, height: h };
    const m = new Float32Array(1600).fill(255);
    const out = applyStrokes(m, split, [{ x: 5, y: 20, r: 30, mode: 'drop' }]);
    expect(out[20 * 40 + 5]).toBe(0); // clicked side: cleared
    expect(out[20 * 40 + 35]).toBe(255); // other side: survives
  });

  it('a bigger brush accepts more colour variation', () => {
    // Size drives tolerance now, so a gentle gradient is crossed by a large
    // brush and not by a small one.
    const w = 60, h = 10;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const c = 255 - x * 2; // 255 down to 137
        data[i] = data[i + 1] = data[i + 2] = c;
        data[i + 3] = 255;
      }
    const ramp = { data, width: w, height: h };
    const small = applyStrokes(new Float32Array(w * h).fill(255), ramp, [
      { x: 0, y: 5, r: 8, mode: 'drop' },
    ]);
    const large = applyStrokes(new Float32Array(w * h).fill(255), ramp, [
      { x: 0, y: 5, r: 120, mode: 'drop' },
    ]);
    const reach = (m: Float32Array) => {
      let far = 0;
      for (let x = 0; x < w; x++) if (m[5 * w + x] === 0) far = x;
      return far;
    };
    expect(reach(large)).toBeGreaterThan(reach(small));
  });

  it('applies strokes in order, so the last correction wins', () => {
    const m = new Float32Array(1600).fill(255);
    const out = applyStrokes(m, img, [
      { x: 2, y: 2, r: 20, mode: 'drop' },
      { x: 2, y: 2, r: 20, mode: 'keep' },
    ]);
    expect(out[2 * 40 + 2]).toBe(255);
  });

  it('leaves the original matte untouched, so undo is dropping a stroke', () => {
    const m = new Float32Array(1600).fill(255);
    applyStrokes(m, img, [{ x: 2, y: 2, r: 20, mode: 'drop' }]);
    expect(m[2 * 40 + 2]).toBe(255);
  });

  it('ignores a stroke outside the image', () => {
    const m = new Float32Array(1600).fill(255);
    expect(() => applyStrokes(m, img, [{ x: -5, y: 900, r: 20, mode: 'drop' }])).not.toThrow();
  });

  it('terminates on a uniform image rather than running away', () => {
    // A click on an image with no colour edges could otherwise walk every
    // pixel; the budget bounds it.
    const flat = scene(200, 200, [255, 255, 255], { x: 0, y: 0, w: 0, h: 0 }, [0, 0, 0]);
    const m = new Float32Array(40000).fill(255);
    const t0 = Date.now();
    applyStrokes(m, flat, [{ x: 100, y: 100, r: 200, mode: 'drop' }]);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('the cutout itself', () => {
  it('writes the matte into alpha and leaves colour alone', () => {
    const img = scene(4, 4, [255, 255, 255], { x: 1, y: 1, w: 2, h: 2 }, [10, 20, 30]);
    const m = new Float32Array(16).fill(0);
    m[5] = 255;
    const out = cutout(img, m);
    expect(out.data[5 * 4 + 3]).toBe(255); // kept
    expect(out.data[0 * 4 + 3]).toBe(0); // removed
    // RGB survives even where alpha is zero, so a later correction can bring
    // a pixel back without having lost its colour.
    expect(out.data[0]).toBe(255);
    expect(out.data[5 * 4]).toBe(10);
  });

  it('clamps out-of-range matte values', () => {
    const img = scene(2, 2, [0, 0, 0], { x: 0, y: 0, w: 1, h: 1 }, [1, 1, 1]);
    const out = cutout(img, new Float32Array([-40, 300, 128, 0]));
    expect(out.data[3]).toBe(0);
    expect(out.data[7]).toBe(255);
  });
});

describe('removing the background INSIDE shapes too', () => {
  /** A ring: dark donut with a background-coloured hole in the middle. */
  const ring = (() => {
    const w = 60, h = 60;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dx = x - 30, dy = y - 30;
        const r = Math.sqrt(dx * dx + dy * dy);
        const ink = r < 22 && r > 10;
        const i = (y * w + x) * 4;
        const c = ink ? 20 : 255;
        data[i] = data[i + 1] = data[i + 2] = c;
        data[i + 3] = 255;
      }
    return { data, width: w, height: h };
  })();

  it('the connected flood keeps the hole, as a sticker should', () => {
    // This is the behaviour that is right by default: the counter of an 'o'
    // is part of the design, not background.
    const m = floodMatte(ring);
    expect(m[30 * 60 + 30]).toBe(255);
  });

  it('and "inside too" removes it', () => {
    // Which is what "remove the white inside the letters" asks for.
    const m = allColourMatte(ring);
    expect(m[30 * 60 + 30]).toBe(0);
  });

  it('both agree about the outside', () => {
    expect(floodMatte(ring)[1]).toBe(0);
    expect(allColourMatte(ring)[1]).toBe(0);
  });

  it('both keep the ink', () => {
    // A point on the donut itself: 16px from centre, between r=10 and r=22.
    const p = (30 + 16) + 30 * 60;
    expect(floodMatte(ring)[p]).toBe(255);
    expect(allColourMatte(ring)[p]).toBe(255);
  });
});

describe('eroding a matte', () => {
  it('peels one pixel off the edge', () => {
    const w = 10, h = 10;
    const m = new Float32Array(w * h).fill(0);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) m[y * w + x] = 255;
    const e = erodeMatte(m, w, h, 1);
    expect(e[3 * w + 3]).toBe(0); // corner: was edge
    expect(e[4 * w + 4]).toBe(255); // interior: survives
  });

  it('repeats for a wider erode', () => {
    const w = 12, h = 12;
    const m = new Float32Array(w * h).fill(0);
    for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) m[y * w + x] = 255;
    const e = erodeMatte(m, w, h, 2);
    expect(e[3 * w + 3]).toBe(0);
    expect(e[6 * w + 6]).toBe(255);
  });

  it('leaves the input alone', () => {
    const w = 8, h = 8;
    const m = new Float32Array(w * h).fill(255);
    erodeMatte(m, w, h, 1);
    expect(m[0]).toBe(255);
  });
});

describe('stepping back through corrections', () => {
  const img = scene(40, 40, [255, 255, 255], { x: 10, y: 10, w: 20, h: 20 }, [20, 20, 20]);

  it('applying one stroke to a running result matches replaying them all', () => {
    // This equivalence is what makes the incremental path safe: the preview
    // keeps a running matte and applies only the newest stroke, which must be
    // indistinguishable from rebuilding from the base every time.
    const base = new Float32Array(1600).fill(255);
    const strokes = [
      { x: 2, y: 2, r: 20, mode: 'drop' as const },
      { x: 20, y: 20, r: 20, mode: 'drop' as const },
      { x: 15, y: 15, r: 6, mode: 'keep' as const },
    ];
    const replayed = applyStrokes(base, img, strokes);
    let running: Float32Array<ArrayBufferLike> = base;
    for (const s of strokes) running = applyStrokes(running, img, [s]);
    expect(Array.from(running)).toEqual(Array.from(replayed));
  });

  it('dropping the last stroke restores the previous state exactly', () => {
    // Undo is "pop the list and rebuild", which only works because
    // applyStrokes never mutates its input.
    const base = new Float32Array(1600).fill(255);
    // Both strokes must actually CHANGE something, or "after two" and "after
    // one" are legitimately identical and the test proves nothing. The first
    // version used a keep-stroke on already-kept pixels and failed for that
    // reason rather than finding a bug.
    const two = [
      { x: 2, y: 2, r: 20, mode: 'drop' as const },
      { x: 20, y: 20, r: 20, mode: 'drop' as const },
    ];
    const afterTwo = applyStrokes(base, img, two);
    const afterUndo = applyStrokes(base, img, two.slice(0, 1));
    const afterOne = applyStrokes(base, img, [two[0]]);
    expect(Array.from(afterUndo)).toEqual(Array.from(afterOne));
    expect(Array.from(afterUndo)).not.toEqual(Array.from(afterTwo));
  });

  it('redo lands on the same state the stroke originally produced', () => {
    // redoStroke() takes the INCREMENTAL path — it appends to bgAccum rather
    // than replaying — on the argument that re-adding to the end of the list
    // is exactly what a fresh stroke does. That is only true if appending to
    // the undone state equals the full replay, so prove it rather than assume.
    const base = new Float32Array(1600).fill(255);
    // Each stroke must change something or the assertions pass vacuously.
    // Measured on this fixture: drop at (2,2) clears the 1200 white pixels,
    // drop at (20,20) the 400 dark ones, and the keep restores those 400.
    // A third DROP here changes nothing — there is nothing left to drop.
    const strokes = [
      { x: 2, y: 2, r: 20, mode: 'drop' as const },
      { x: 20, y: 20, r: 20, mode: 'drop' as const },
      { x: 15, y: 15, r: 6, mode: 'keep' as const },
    ];
    const original = applyStrokes(base, img, strokes);

    // Undo: rebuild without the last stroke. Redo: append it back.
    const undone = applyStrokes(base, img, strokes.slice(0, -1));
    const redone = applyStrokes(undone, img, [strokes[2]]);

    expect(Array.from(redone)).toEqual(Array.from(original));
    expect(Array.from(undone)).not.toEqual(Array.from(original));
  });

  it('redo survives walking the whole history back and forward', () => {
    // The button lets the user hold it down, so the round trip has to be
    // stable over every step, not just one.
    const base = new Float32Array(1600).fill(255);
    // Each stroke must change something or the assertions pass vacuously.
    // Measured on this fixture: drop at (2,2) clears the 1200 white pixels,
    // drop at (20,20) the 400 dark ones, and the keep restores those 400.
    // A third DROP here changes nothing — there is nothing left to drop.
    const strokes = [
      { x: 2, y: 2, r: 20, mode: 'drop' as const },
      { x: 20, y: 20, r: 20, mode: 'drop' as const },
      { x: 15, y: 15, r: 6, mode: 'keep' as const },
    ];
    const original = Array.from(applyStrokes(base, img, strokes));

    // Walk all the way back, keeping the undone strokes in a redo stack.
    const undoStack = [...strokes];
    const redoStack: typeof strokes = [];
    while (undoStack.length) redoStack.push(undoStack.pop()!);
    expect(Array.from(applyStrokes(base, img, undoStack))).toEqual(
      Array.from(base),
    );

    // Walk forward again, appending incrementally the way redoStroke does.
    let running: Float32Array<ArrayBufferLike> = base;
    while (redoStack.length) {
      const s = redoStack.pop()!;
      undoStack.push(s);
      running = applyStrokes(running, img, [s]);
    }
    expect(undoStack).toEqual(strokes);
    expect(Array.from(running)).toEqual(original);
  });

  it('undoing every stroke returns the base matte', () => {
    const base = new Float32Array(1600).fill(255);
    base[0] = 0; // something distinctive to prove it is the ORIGINAL base
    const out = applyStrokes(base, img, []);
    expect(Array.from(out)).toEqual(Array.from(base));
  });

  it('rebuilding is required after a middle stroke is removed', () => {
    // A later stroke can overwrite pixels an earlier one set, so removing one
    // from the middle cannot be undone incrementally — hence undo rebuilds.
    const base = new Float32Array(1600).fill(255);
    const a = { x: 2, y: 2, r: 20, mode: 'drop' as const };
    const b = { x: 2, y: 2, r: 20, mode: 'keep' as const };
    const both = applyStrokes(base, img, [a, b]);
    const onlyA = applyStrokes(base, img, [a]);
    // b overwrote a, so removing b must not leave b's result behind.
    expect(both[2 * 40 + 2]).toBe(255);
    expect(onlyA[2 * 40 + 2]).toBe(0);
  });
});

/**
 * Removal on artwork that is already transparent.
 *
 * The whole regression. A transparent PNG — the app's main input — came back
 * from Remove background with hardened edges, black fill in every enclosed
 * gap, and on dark artwork nothing at all: the flood read RGB only, voted the
 * transparent pixels' black as the background colour, and cutout() then
 * replaced the real alpha with a binary matte. These pin the rules that make
 * removal a no-op on such an image and harmless on any other.
 */
function transparentScene(
  w: number,
  h: number,
  paint: (x: number, y: number) => [number, number, number, number] | null
): RasterImage {
  // Transparent pixels read back as black, as a canvas returns them.
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y) ?? [0, 0, 0, 0];
      const i = (y * w + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
    }
  }
  return { data, width: w, height: h };
}

describe('removal on artwork that is already transparent', () => {
  // A red square on transparency, with a one-pixel soft ramp around it.
  const soft = transparentScene(30, 30, (x, y) => {
    const inside = x >= 10 && x < 20 && y >= 10 && y < 20;
    const ring = !inside && x >= 9 && x < 21 && y >= 9 && y < 21;
    if (inside) return [200, 30, 30, 255];
    if (ring) return [200, 30, 30, 100];
    return null;
  });

  it('transparent pixels never vote, so a transparent border finds no background', () => {
    const m = floodMatte(soft, 32);
    // Nothing opaque was dropped; the transparent fringe is left at 255 too.
    expect(coverage(m)).toBe(1);
    expect(keptOpaque(soft, m)).toBe(1);
  });

  it('leaves the artwork byte-identical, soft ramp included', () => {
    const out = cutout(soft, floodMatte(soft, 32));
    expect(Array.from(out.data)).toEqual(Array.from(soft.data));
  });

  it('never raises alpha: a matte can only take coverage away', () => {
    const keepAll = new Float32Array(30 * 30).fill(255);
    const out = cutout(soft, keepAll);
    for (let i = 3; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(soft.data[i]);
    }
  });

  it('still drops opaque background that matches the border, reached across transparency', () => {
    // A white opaque strip along the left edge votes "white"; a white card
    // floats in the middle, separated from it by transparency. The flood
    // passes through the transparency and drops the card, keeps the red art,
    // and leaves the transparent pixels' own alpha alone.
    const img = transparentScene(40, 20, (x, y) => {
      if (x < 2) return [255, 255, 255, 255];
      if (x >= 15 && x < 22 && y >= 5 && y < 15) return [255, 255, 255, 255];
      if (x >= 28 && x < 36 && y >= 5 && y < 15) return [200, 30, 30, 255];
      return null;
    });
    const m = floodMatte(img, 32);
    const at = (x: number, y: number) => m[y * 40 + x];
    expect(at(1, 10)).toBe(0); // the strip
    expect(at(18, 10)).toBe(0); // the card, across the gap
    expect(at(30, 10)).toBe(255); // the art
    expect(at(10, 10)).toBe(255); // transparency is not "dropped"; multiply hides it
    const out = cutout(img, m);
    expect(out.data[(10 * 40 + 18) * 4 + 3]).toBe(0);
    expect(out.data[(10 * 40 + 30) * 4 + 3]).toBe(255);
    expect(out.data[(10 * 40 + 10) * 4 + 3]).toBe(0);
    expect(keptOpaque(img, m)).toBeLessThan(1);
  });

  it('"inside too" matches opaque pixels only', () => {
    const img = transparentScene(20, 20, (x, y) => {
      if (y < 2) return [255, 255, 255, 255]; // white top edge votes
      if (x >= 8 && x < 12 && y >= 8 && y < 12) return [255, 255, 255, 255]; // enclosed white
      if (x >= 4 && x < 16 && y >= 4 && y < 16) return [20, 20, 20, 255]; // dark ring around it
      return null;
    });
    const m = allColourMatte(img, 32);
    expect(m[10 * 20 + 10]).toBe(0); // enclosed white goes
    expect(m[6 * 20 + 6]).toBe(255); // dark art stays
    expect(m[18 * 20 + 2]).toBe(255); // transparent pixels are not matched
  });

  it('reports the kept share over opaque pixels, not over the whole image', () => {
    const img = transparentScene(10, 10, (x, y) =>
      x < 2 ? [255, 255, 255, 255] : x < 4 ? [200, 30, 30, 255] : null
    );
    const m = floodMatte(img, 32);
    // 40 opaque pixels: 20 white dropped, 20 red kept.
    expect(keptOpaque(img, m)).toBeCloseTo(0.5, 5);
    // coverage would say 0.8, which hides what happened to the artwork.
    expect(coverage(m)).toBeCloseTo(0.8, 5);
    const none = transparentScene(4, 4, () => null);
    expect(keptOpaque(none, floodMatte(none, 32))).toBe(1);
  });

  it('counts kept pixels, so small artwork on a big card is not mistaken for an erasure', () => {
    // 200x200 white card with a 10x10 mark: the flood correctly keeps 100
    // of 40,000 opaque pixels, a 0.25% share. Refusing by share would call
    // that an erasure; the count says 100 pixels of artwork survived.
    const card = scene(200, 200, [255, 255, 255], { x: 95, y: 95, w: 10, h: 10 }, [20, 20, 20]);
    const m = floodMatte(card, 32);
    expect(keptOpaqueStats(card, m)).toEqual({ opaque: 40000, kept: 100 });
    expect(keptOpaque(card, m)).toBeCloseTo(0.0025, 6);
    // Whereas an image the flood really did erase keeps zero.
    const gone = scene(20, 20, [255, 255, 255], { x: 5, y: 5, w: 10, h: 10 }, [250, 250, 250]);
    expect(keptOpaqueStats(gone, floodMatte(gone, 32)).kept).toBe(0);
  });

  it('is unchanged on an opaque image: multiply equals replace', () => {
    const img = scene(40, 40, [255, 255, 255], { x: 10, y: 10, w: 20, h: 20 }, [20, 20, 20]);
    const m = floodMatte(img, 32);
    const out = cutout(img, m);
    for (let i = 0; i < m.length; i++) {
      expect(out.data[i * 4 + 3]).toBe(Math.max(0, Math.min(255, m[i])));
    }
  });
});
