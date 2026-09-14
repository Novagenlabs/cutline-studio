/**
 * Background removal as its own operation.
 *
 * The neural matte already existed, but only ever fed the tracer: it decided
 * where the cut line went and never touched a pixel. So a logo on a white
 * card got a perfect cut line drawn over a still-white canvas, which reads as
 * "it didn't remove the background" — and the exported SVG carried that white
 * rectangle behind the artwork.
 *
 * This module turns the same matte into an actual cutout, at full resolution,
 * and lets the user correct it by clicking. Correction matters because no
 * model is right every time, and the failure is always local: a dark logo on
 * a dark background loses a corner, a photo keeps a patch of sky. Clicking
 * the wrong bit is a far smaller ask than explaining a tolerance slider.
 */
import type { RasterImage } from '../pipeline/types';

/** A user correction: keep this region, or drop it. */
export interface Stroke {
  /** Centre, in SOURCE image pixels. */
  x: number;
  y: number;
  /**
   * Brush size in source pixels. Drives the colour tolerance rather than a
   * hard radius — a bigger brush accepts a looser range of colour, the way
   * Quick Select's sizing behaves.
   */
  r: number;
  mode: 'keep' | 'drop';
}

/**
 * Scale a matte up to the source resolution.
 *
 * The model runs on the downscaled working image — the same one the tracer
 * uses — so its matte is smaller than the artwork it has to cut out.
 * Bilinear rather than nearest: a hard-edged upscale leaves visible stair
 * steps on a diagonal, and the matte is a coverage value, so interpolating it
 * is meaningful rather than a smoothing hack.
 */
export function upsampleMatte(
  matte: Float32Array,
  mw: number,
  mh: number,
  w: number,
  h: number
): Float32Array {
  if (mw === w && mh === h) return matte;
  const out = new Float32Array(w * h);
  const sx = mw / w;
  const sy = mh / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(mh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(mh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(mw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(mw - 1, x0 + 1);
      const wx = fx - x0;
      const a = matte[y0 * mw + x0];
      const b = matte[y0 * mw + x1];
      const c = matte[y1 * mw + x0];
      const d = matte[y1 * mw + x1];
      out[y * w + x] = a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) + c * (1 - wx) * wy + d * wx * wy;
    }
  }
  return out;
}

/**
 * Apply the user's corrections to a matte, Quick Select style.
 *
 * Each click samples the colour under it and grows through CONNECTED pixels
 * of a similar colour, with no radius limit. That is what "remove this bit"
 * means in practice: the region ends where the colour changes, not where the
 * cursor stopped. The previous version clamped to the brush radius, so
 * clearing a large area meant clicking across it repeatedly and a stroke
 * could bite a round hole out of an edge it overlapped.
 *
 * Connectivity is the safety property. A pixel matching the sampled colour
 * on the far side of the artwork is never reached, so removing a white
 * background does not also punch out white lettering somewhere else.
 *
 * Strokes are applied in order over an unmodified base matte, so a later
 * correction wins over an earlier one and undo is dropping the last entry.
 */
export function applyStrokes(
  matte: Float32Array,
  img: RasterImage,
  strokes: Stroke[]
): Float32Array {
  if (strokes.length === 0) return matte;
  const { width: w, height: h, data } = img;
  const out = Float32Array.from(matte);

  for (const s of strokes) {
    const cx = Math.round(s.x);
    const cy = Math.round(s.y);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;

    const ci = (cy * w + cx) * 4;
    const cr = data[ci];
    const cg = data[ci + 1];
    const cb = data[ci + 2];
    const target = s.mode === 'keep' ? 255 : 0;

    // Tolerance from the brush size, so one control does the job people
    // expect it to: a bigger brush grabs a looser range of colour, the way
    // Quick Select's own sizing behaves. Squared, because the distance test
    // below is squared and taking a square root per pixel over a few million
    // pixels is the difference between instant and sluggish.
    const tol = Math.max(12, s.r * 0.9);
    const tol2 = tol * tol * 3;

    // Flood from the click, not a disc around it.
    //
    // The old version clamped to the brush radius, so clearing a large area
    // meant clicking across it repeatedly — and a stroke could bite a round
    // hole out of an edge it overlapped. Quick Select grows through connected
    // pixels of a similar colour instead, which is what "remove this bit"
    // actually means: the region ends where the colour changes, not where the
    // cursor stopped.
    //
    // Connectivity is what keeps it safe. A pixel matching the sampled colour
    // on the far side of the artwork is not reached, so removing a white
    // background does not also punch out white lettering elsewhere.
    const seen = new Uint8Array(w * h);
    const stack: number[] = [cy * w + cx];
    seen[cy * w + cx] = 1;
    // A hard cap, so a click on a near-uniform image cannot walk the entire
    // frame and freeze the tab. Generous enough that a real background region
    // completes; small enough that a runaway is bounded.
    const budget = Math.min(w * h, 4_000_000);
    let visited = 0;

    while (stack.length && visited < budget) {
      const p = stack.pop()!;
      visited++;
      out[p] = target;

      const px = p % w;
      const py = (p / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = px + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = py + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (seen[np]) continue;
        const i = np * 4;
        const dr = data[i] - cr;
        const dg = data[i + 1] - cg;
        const db = data[i + 2] - cb;
        if (dr * dr + dg * dg + db * db > tol2) continue;
        seen[np] = 1;
        stack.push(np);
      }
    }
  }
  return out;
}

/** Splice a matte in as the alpha channel; RGB is left alone. */
export function cutout(img: RasterImage, matte: Float32Array): RasterImage {
  const out = new Uint8ClampedArray(img.data.length);
  out.set(img.data);
  for (let i = 0; i < matte.length; i++) {
    out[i * 4 + 3] = Math.max(0, Math.min(255, matte[i]));
  }
  return { data: out, width: img.width, height: img.height };
}

/**
 * Background removal without a model.
 *
 * The same border-vote flood fill the tracer already uses, lifted out so the
 * button works on a device that cannot run the model — or before the ~98MB
 * download finishes. On a flat studio background it is genuinely as good as
 * the neural matte and instant; it is only photographs and gradients where
 * the difference shows.
 */
export function floodMatte(img: RasterImage, tolerance = 32): Float32Array {
  const { width: w, height: h, data } = img;
  const matte = new Float32Array(w * h).fill(255);

  // Most common border colour, quantised so noise in a JPEG does not split
  // the vote across a hundred near-identical whites.
  const votes = new Map<number, number>();
  const vote = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    votes.set(key, (votes.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < Math.min(2, h); y++) {
      vote(x, y);
      vote(x, h - 1 - y);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < Math.min(2, w); x++) {
      vote(x, y);
      vote(w - 1 - x, y);
    }
  }
  let best = 0;
  let bestN = -1;
  for (const [k, n] of votes) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  const br = ((best >> 8) & 0xf) * 17;
  const bg = ((best >> 4) & 0xf) * 17;
  const bb = (best & 0xf) * 17;
  const tol2 = tolerance * tolerance * 3;

  // Scanline flood from every border pixel. Only connected background is
  // removed, so a white letter counter inside the artwork survives.
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * w + x;
    if (seen[p]) return;
    const i = p * 4;
    const dr = data[i] - br;
    const dg = data[i + 1] - bg;
    const db = data[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > tol2) return;
    seen[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const p = stack.pop()!;
    matte[p] = 0;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  return matte;
}

/**
 * Remove EVERY pixel matching the background colour, connected or not.
 *
 * floodMatte only removes background the border can reach, which keeps the
 * counter of an 'o', the middle of a '0' and the soccer ball's white panels
 * as opaque artwork. That is the right default for a sticker — those areas
 * are part of the design — but it is not what "remove all the white including
 * inside the letters" means, and on this crest it leaves 21 white blobs
 * totalling 39,259 pixels.
 *
 * Colour match rather than a second flood: an enclosed region is by
 * definition unreachable from the border, so reachability cannot be the test.
 * The tolerance is the same one the flood uses, so the two modes agree about
 * what counts as background.
 *
 * The cost is real and worth stating: a design that deliberately uses the
 * background colour as ink — white text on a white-backed badge — loses that
 * ink. That is why this is a mode and not the default.
 */
export function allColourMatte(img: RasterImage, tolerance = 32): Float32Array {
  const { width: w, height: h, data } = img;
  const matte = new Float32Array(w * h).fill(255);

  const votes = new Map<number, number>();
  const vote = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    votes.set(key, (votes.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < Math.min(2, h); y++) {
      vote(x, y);
      vote(x, h - 1 - y);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < Math.min(2, w); x++) {
      vote(x, y);
      vote(w - 1 - x, y);
    }
  }
  let best = 0;
  let bestN = -1;
  for (const [k, n] of votes) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  const br = ((best >> 8) & 0xf) * 17;
  const bg = ((best >> 4) & 0xf) * 17;
  const bb = (best & 0xf) * 17;
  const tol2 = tolerance * tolerance * 3;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const dr = data[i] - br;
    const dg = data[i + 1] - bg;
    const db = data[i + 2] - bb;
    if (dr * dr + dg * dg + db * db <= tol2) matte[p] = 0;
  }
  return matte;
}

/**
 * Shrink a matte by one pixel of coverage.
 *
 * JPEG artwork has an anti-aliased edge: between solid ink and solid
 * background sits a ramp of intermediate pixels. A hard threshold puts the
 * cut somewhere in that ramp, which leaves a one-pixel rind of near-background
 * colour attached to every shape — visible as a pale outline once the rest is
 * transparent. Eroding by the same amount removes the rind and lands the edge
 * on the ink.
 */
export function erodeMatte(matte: Float32Array, w: number, h: number, px = 1): Float32Array {
  let src = matte;
  for (let pass = 0; pass < px; pass++) {
    const out = Float32Array.from(src);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (src[p] < 128) continue;
        // Any transparent 4-neighbour makes this an edge pixel.
        if (
          (x > 0 && src[p - 1] < 128) ||
          (x < w - 1 && src[p + 1] < 128) ||
          (y > 0 && src[p - w] < 128) ||
          (y < h - 1 && src[p + w] < 128)
        ) out[p] = 0;
      }
    }
    src = out;
  }
  return src;
}

/** How much of the image a matte keeps, 0..1. Used to sanity-check a result. */
export function coverage(matte: Float32Array): number {
  let kept = 0;
  for (let i = 0; i < matte.length; i++) if (matte[i] >= 128) kept++;
  return kept / matte.length;
}
