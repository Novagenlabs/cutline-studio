import type { RasterImage } from './types';

export interface MaskResult {
  mask: Uint8Array;
  /**
   * Continuous coverage field 0-255 in the same padded grid: the raw alpha
   * ramp for transparent images (optionally denoised), a blurred 0/255
   * field for flood-filled opaque images. Tracing this at the threshold
   * gives subpixel-accurate edges that binarization throws away.
   */
  field: Float32Array;
  w: number;
  h: number;
  usedAlpha: boolean;
}

/**
 * Extract a padded coverage field + binary mask from an image.
 * Uses the alpha channel when present; otherwise estimates the background
 * color from the border ring and flood-fills it away from the edges.
 * `pad` transparent pixels are added on every side so the offset band never
 * clips at the image boundary. `denoiseSigma` (px) gaussian-blurs the field
 * before thresholding — suppresses JPEG mottle and ragged low-alpha fringes.
 */
export function extractMask(
  img: RasterImage,
  opts: {
    alphaThreshold: number;
    bgTolerance: number;
    pad: number;
    denoiseSigma: number;
    /** Peel outside-connected white keylines/glows so the trace hugs the colored body. */
    bodyMode: boolean;
  }
): MaskResult {
  const { width: iw, height: ih, data } = img;
  const pad = Math.max(0, Math.round(opts.pad));
  const w = iw + pad * 2;
  const h = ih + pad * 2;
  const mask = new Uint8Array(w * h);
  const field = new Float32Array(w * h);

  let usedAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      usedAlpha = true;
      break;
    }
  }

  if (usedAlpha) {
    for (let y = 0; y < ih; y++) {
      const row = (y + pad) * w + pad;
      const src = y * iw;
      for (let x = 0; x < iw; x++) {
        field[row + x] = data[(src + x) * 4 + 3];
      }
    }
  } else {
    floodFillBackground(img, mask, w, pad, opts.bgTolerance);
    for (let i = 0; i < mask.length; i++) field[i] = mask[i] ? 255 : 0;
    mask.fill(0);
  }

  const t = usedAlpha ? opts.alphaThreshold : 128;
  if (opts.bodyMode) peelWhiteRim(img, field, w, h, pad, t);
  if (opts.denoiseSigma > 0.05) gaussianBlur(field, w, h, opts.denoiseSigma);

  for (let i = 0; i < field.length; i++) {
    if (field[i] >= t) mask[i] = 1;
  }
  return { mask, field, w, h, usedAlpha };
}

/**
 * "Hug colored body" mode. Two stages:
 *
 * 1. Flood-fill inward from the border across pixels that are below the
 *    alpha threshold OR near-white — the white keyline/glow rim that wraps
 *    the artwork. Whites sealed *inside* the art are unreachable and stay.
 * 2. In the reached rim plus a 2px ring around it (the anti-aliased blend
 *    fringe), replace the field with a CONTINUOUS body-coverage estimate:
 *    (alpha) x (distance from white) = alpha x (1 - min(r,g,b)/255).
 *    Blend pixels (letter color mixed with white) get fractional values,
 *    so the subpixel tracer lands mid-blend — on the perceived glyph edge —
 *    instead of a hard in/out decision that leaves a 1-2px white fringe.
 *    (Equivalent to "make the art black-on-white first", generalized to
 *    colored bodies against a white rim.)
 */
function peelWhiteRim(
  img: RasterImage,
  field: Float32Array,
  w: number,
  h: number,
  pad: number,
  alphaThreshold: number
): void {
  const { width: iw, height: ih, data } = img;
  const n = w * h;
  const reached = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;

  const qualifies = (i: number): boolean => {
    if (field[i] < alphaThreshold) return true; // transparent / padding
    const x = (i % w) - pad;
    const y = ((i / w) | 0) - pad;
    if (x < 0 || x >= iw || y < 0 || y >= ih) return true;
    const p = (y * iw + x) * 4;
    // near-white regardless of alpha: all channels high
    return Math.min(data[p], data[p + 1], data[p + 2]) >= 190;
  };

  const seed = (i: number) => {
    if (!reached[i] && qualifies(i)) {
      reached[i] = 1;
      queue[qt++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % w;
    const y = (i / w) | 0;
    const grow = (j: number) => {
      if (!reached[j] && qualifies(j)) {
        reached[j] = 1;
        queue[qt++] = j;
      }
    };
    if (x > 0) grow(i - 1);
    if (x < w - 1) grow(i + 1);
    if (y > 0) grow(i - w);
    if (y < h - 1) grow(i + w);
  }

  // Expand the rim by 2px (4-neighbor dilation) to take in the anti-aliased
  // blend fringe between the white rim and the colored body.
  const zone = new Uint8Array(reached);
  for (let pass = 0; pass < 2; pass++) {
    const prev = new Uint8Array(zone);
    for (let i = 0; i < n; i++) {
      if (prev[i]) continue;
      const x = i % w;
      const y = (i / w) | 0;
      if (
        (x > 0 && prev[i - 1]) ||
        (x < w - 1 && prev[i + 1]) ||
        (y > 0 && prev[i - w]) ||
        (y < h - 1 && prev[i + w])
      ) {
        zone[i] = 1;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    if (!zone[i]) continue;
    const x = (i % w) - pad;
    const y = ((i / w) | 0) - pad;
    if (x < 0 || x >= iw || y < 0 || y >= ih) {
      field[i] = 0;
      continue;
    }
    const p = (y * iw + x) * 4;
    const whiteness = Math.min(data[p], data[p + 1], data[p + 2]) / 255;
    field[i] = (field[i] / 255) * (1 - whiteness) * 255;
  }
}

/**
 * Separable gaussian blur approximated by three box passes
 * (Kovesi's box sizes), in place. Sigma in px.
 */
export function gaussianBlur(f: Float32Array, w: number, h: number, sigma: number): void {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const tmp = new Float32Array(f.length);
  for (let pass = 0; pass < 3; pass++) {
    const r = ((pass < m ? wl : wu) - 1) / 2;
    if (r < 1) continue;
    boxBlurH(f, tmp, w, h, r);
    boxBlurV(tmp, f, w, h, r);
  }
}

function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = src[row] * (r + 1);
    for (let x = 0; x < r; x++) acc += src[row + Math.min(x, w - 1)];
    for (let x = 0; x < w; x++) {
      acc += src[row + Math.min(x + r, w - 1)] - src[row + Math.max(x - r - 1, 0)];
      dst[row + x] = acc * inv;
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = src[x] * (r + 1);
    for (let y = 0; y < r; y++) acc += src[Math.min(y, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      acc +=
        src[Math.min(y + r, h - 1) * w + x] - src[Math.max(y - r - 1, 0) * w + x];
      dst[y * w + x] = acc * inv;
    }
  }
}

/** Modal border color (4-bit quantized vote over a 2px ring) then BFS from all border pixels. */
function floodFillBackground(
  img: RasterImage,
  mask: Uint8Array,
  maskW: number,
  pad: number,
  tolerance: number
): void {
  const { width: iw, height: ih, data } = img;
  const votes = new Map<number, number>();
  const vote = (x: number, y: number) => {
    const i = (y * iw + x) * 4;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    votes.set(key, (votes.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < iw; x++) {
    for (let y = 0; y < Math.min(2, ih); y++) {
      vote(x, y);
      vote(x, ih - 1 - y);
    }
  }
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < Math.min(2, iw); x++) {
      vote(x, y);
      vote(iw - 1 - x, y);
    }
  }
  let bestKey = 0;
  let bestCount = -1;
  for (const [k, c] of votes) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = k;
    }
  }
  const bgR = ((bestKey >> 8) & 0xf) * 17;
  const bgG = ((bestKey >> 4) & 0xf) * 17;
  const bgB = (bestKey & 0xf) * 17;
  const tolSq = tolerance * tolerance;
  // Local neighbor-to-neighbor tolerance: lets the fill ride smooth gradients
  // and JPEG mottle (small local deltas) while the sharp edge of the subject
  // (large local delta) still stops it. Kept well below the global tolerance
  // so it can't creep through an anti-aliased boundary pixel by pixel.
  const localTol = Math.max(6, tolerance / 3);
  const localTolSq = localTol * localTol;

  const isBgColor = (i4: number) => {
    const dr = data[i4] - bgR;
    const dg = data[i4 + 1] - bgG;
    const db = data[i4 + 2] - bgB;
    return dr * dr + dg * dg + db * db <= tolSq;
  };
  const isNearNeighbor = (i4: number, j4: number) => {
    const dr = data[i4] - data[j4];
    const dg = data[i4 + 1] - data[j4 + 1];
    const db = data[i4 + 2] - data[j4 + 2];
    return dr * dr + dg * dg + db * db <= localTolSq;
  };

  // BFS over image pixels; reached = background. A pixel joins the background
  // if it matches the global background color, or if it's locally continuous
  // with the background pixel it was reached from (gradient backgrounds).
  const reached = new Uint8Array(iw * ih);
  const queue = new Int32Array(iw * ih);
  let qh = 0;
  let qt = 0;
  const seed = (x: number, y: number) => {
    const i = y * iw + x;
    if (!reached[i] && isBgColor(i * 4)) {
      reached[i] = 1;
      queue[qt++] = i;
    }
  };
  for (let x = 0; x < iw; x++) {
    seed(x, 0);
    seed(x, ih - 1);
  }
  for (let y = 0; y < ih; y++) {
    seed(0, y);
    seed(iw - 1, y);
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % iw;
    const y = (i / iw) | 0;
    const grow = (j: number) => {
      if (!reached[j] && (isBgColor(j * 4) || isNearNeighbor(j * 4, i * 4))) {
        reached[j] = 1;
        queue[qt++] = j;
      }
    };
    if (x > 0) grow(i - 1);
    if (x < iw - 1) grow(i + 1);
    if (y > 0) grow(i - iw);
    if (y < ih - 1) grow(i + iw);
  }
  for (let y = 0; y < ih; y++) {
    const row = (y + pad) * maskW + pad;
    const src = y * iw;
    for (let x = 0; x < iw; x++) {
      if (!reached[src + x]) mask[row + x] = 1;
    }
  }
}

/**
 * After island/hole filtering changed the binary mask, nudge the continuous
 * field across the threshold at exactly those pixels so a field trace agrees
 * with the mask — edge pixels the filter didn't touch keep their subpixel ramp.
 */
export function reconcileField(
  field: Float32Array,
  mask: Uint8Array,
  threshold: number
): void {
  for (let i = 0; i < field.length; i++) {
    if (mask[i]) {
      if (field[i] < threshold) field[i] = threshold + 0.5;
    } else if (field[i] >= threshold) {
      field[i] = threshold - 0.5;
    }
  }
}

/**
 * Drop foreground islands below minArea px^2 (8-connectivity) and fill
 * interior holes below minHoleArea px^2 (4-connectivity, not edge-connected).
 */
export function filterIslands(
  mask: Uint8Array,
  w: number,
  h: number,
  minArea: number,
  minHoleArea: number
): void {
  const n = w * h;
  const queue = new Int32Array(n);
  const visited = new Uint8Array(n);

  // Foreground components, 8-connected.
  for (let s = 0; s < n; s++) {
    if (!mask[s] || visited[s]) continue;
    let qh = 0;
    let qt = 0;
    queue[qt++] = s;
    visited[s] = 1;
    const members: number[] = [];
    while (qh < qt) {
      const i = queue[qh++];
      members.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const j = yy * w + xx;
          if (mask[j] && !visited[j]) {
            visited[j] = 1;
            queue[qt++] = j;
          }
        }
      }
    }
    if (members.length < minArea) {
      for (const i of members) mask[i] = 0;
    }
  }

  // Background components not touching the border = holes; fill small ones.
  visited.fill(0);
  for (let s = 0; s < n; s++) {
    if (mask[s] || visited[s]) continue;
    let qh = 0;
    let qt = 0;
    queue[qt++] = s;
    visited[s] = 1;
    let touchesBorder = false;
    const members: number[] = [];
    const visit = (xx: number, yy: number) => {
      const j = yy * w + xx;
      if (!mask[j] && !visited[j]) {
        visited[j] = 1;
        queue[qt++] = j;
      }
    };
    while (qh < qt) {
      const i = queue[qh++];
      members.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      if (x > 0) visit(x - 1, y);
      if (x < w - 1) visit(x + 1, y);
      if (y > 0) visit(x, y - 1);
      if (y < h - 1) visit(x, y + 1);
    }
    if (!touchesBorder && members.length < minHoleArea) {
      for (const i of members) mask[i] = 1;
    }
  }
}
