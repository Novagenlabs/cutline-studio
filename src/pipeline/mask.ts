import type { RasterImage } from './types';

export interface MaskResult {
  mask: Uint8Array;
  w: number;
  h: number;
  usedAlpha: boolean;
}

/**
 * Extract a padded binary foreground mask from an image.
 * Uses the alpha channel when present; otherwise estimates the background
 * color from the border ring and flood-fills it away from the edges.
 * `pad` transparent pixels are added on every side so the offset band never
 * clips at the image boundary.
 */
export function extractMask(
  img: RasterImage,
  opts: { alphaThreshold: number; bgTolerance: number; pad: number }
): MaskResult {
  const { width: iw, height: ih, data } = img;
  const pad = Math.max(0, Math.round(opts.pad));
  const w = iw + pad * 2;
  const h = ih + pad * 2;
  const mask = new Uint8Array(w * h);

  let usedAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      usedAlpha = true;
      break;
    }
  }

  if (usedAlpha) {
    const t = opts.alphaThreshold;
    for (let y = 0; y < ih; y++) {
      const row = (y + pad) * w + pad;
      const src = y * iw;
      for (let x = 0; x < iw; x++) {
        if (data[(src + x) * 4 + 3] >= t) mask[row + x] = 1;
      }
    }
  } else {
    floodFillBackground(img, mask, w, pad, opts.bgTolerance);
  }
  return { mask, w, h, usedAlpha };
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

  const isBgColor = (x: number, y: number) => {
    const i = (y * iw + x) * 4;
    const dr = data[i] - bgR;
    const dg = data[i + 1] - bgG;
    const db = data[i + 2] - bgB;
    return dr * dr + dg * dg + db * db <= tolSq;
  };

  // BFS over image pixels; reached = background. 0 = unvisited fg-candidate.
  const reached = new Uint8Array(iw * ih);
  const queue = new Int32Array(iw * ih);
  let qh = 0;
  let qt = 0;
  const push = (x: number, y: number) => {
    const i = y * iw + x;
    if (!reached[i] && isBgColor(x, y)) {
      reached[i] = 1;
      queue[qt++] = i;
    }
  };
  for (let x = 0; x < iw; x++) {
    push(x, 0);
    push(x, ih - 1);
  }
  for (let y = 0; y < ih; y++) {
    push(0, y);
    push(iw - 1, y);
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % iw;
    const y = (i / iw) | 0;
    if (x > 0) push(x - 1, y);
    if (x < iw - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < ih - 1) push(x, y + 1);
  }
  for (let y = 0; y < ih; y++) {
    const row = (y + pad) * maskW + pad;
    const src = y * iw;
    for (let x = 0; x < iw; x++) {
      if (!reached[src + x]) mask[row + x] = 1;
    }
  }
}

/** 3x3 morphological open (kill specks) then close (seal pinholes), in place. */
export function morphOpenClose(mask: Uint8Array, w: number, h: number): void {
  const tmp = new Uint8Array(w * h);
  erode3(mask, tmp, w, h);
  dilate3(tmp, mask, w, h);
  dilate3(mask, tmp, w, h);
  erode3(tmp, mask, w, h);
}

function erode3(src: Uint8Array, dst: Uint8Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!src[i]) {
        dst[i] = 0;
        continue;
      }
      let on = 1;
      for (let dy = -1; dy <= 1 && on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) {
          on = 0;
          break;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || !src[yy * w + xx]) {
            on = 0;
            break;
          }
        }
      }
      dst[i] = on;
    }
  }
}

function dilate3(src: Uint8Array, dst: Uint8Array, w: number, h: number): void {
  dst.fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue;
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(h - 1, y + 1);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w - 1, x + 1);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) dst[yy * w + xx] = 1;
      }
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
