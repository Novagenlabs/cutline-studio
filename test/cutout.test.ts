import { describe, expect, it } from 'vitest';
import {
  upsampleMatte,
  applyStrokes,
  cutout,
  floodMatte,
  allColourMatte,
  erodeMatte,
  coverage,
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
