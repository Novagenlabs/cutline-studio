import { describe, expect, it } from 'vitest';
import {
  upsampleMatte,
  applyStrokes,
  cutout,
  floodMatte,
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

  it('a drop stroke removes what it lands on', () => {
    const m = new Float32Array(1600).fill(255); // nothing removed yet
    const out = applyStrokes(m, img, [{ x: 2, y: 2, r: 6, mode: 'drop' }]);
    expect(out[2 * 40 + 2]).toBeLessThan(40);
  });

  it('a keep stroke restores what it lands on', () => {
    const m = new Float32Array(1600).fill(0); // everything removed
    const out = applyStrokes(m, img, [{ x: 20, y: 20, r: 6, mode: 'keep' }]);
    expect(out[20 * 40 + 20]).toBeGreaterThan(215);
  });

  it('does not bleed across a colour edge', () => {
    // The whole point of sampling colour: a stroke on the white background
    // must not eat into the dark subject beside it, even within its radius.
    const m = new Float32Array(1600).fill(255);
    const out = applyStrokes(m, img, [{ x: 8, y: 20, r: 10, mode: 'drop' }]);
    expect(out[20 * 40 + 8]).toBeLessThan(40); // background: removed
    expect(out[20 * 40 + 20]).toBeGreaterThan(215); // subject: untouched
  });

  it('applies strokes in order, so the last correction wins', () => {
    const m = new Float32Array(1600).fill(255);
    const out = applyStrokes(m, img, [
      { x: 2, y: 2, r: 6, mode: 'drop' },
      { x: 2, y: 2, r: 6, mode: 'keep' },
    ]);
    expect(out[2 * 40 + 2]).toBeGreaterThan(215);
  });

  it('leaves the original matte untouched, so undo is dropping a stroke', () => {
    const m = new Float32Array(1600).fill(255);
    applyStrokes(m, img, [{ x: 2, y: 2, r: 6, mode: 'drop' }]);
    expect(m[2 * 40 + 2]).toBe(255);
  });

  it('ignores a stroke outside the image', () => {
    const m = new Float32Array(1600).fill(255);
    expect(() => applyStrokes(m, img, [{ x: -5, y: 900, r: 6, mode: 'drop' }])).not.toThrow();
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
