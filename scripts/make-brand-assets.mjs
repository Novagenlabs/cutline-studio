/**
 * Generate the brand images: favicons and the link-preview card.
 *
 *   node scripts/make-brand-assets.mjs
 *
 * Committed output rather than a build step, because these change roughly
 * never and a deploy should not depend on a canvas binary being able to draw.
 * Re-run it if the mark or the palette changes.
 *
 * The card is 1200x630 — the size Open Graph consumers crop to, and what
 * WhatsApp, Slack, iMessage and Twitter all expect. PNG rather than SVG
 * because most of them will not render SVG at all.
 */
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = '#0a0a0b';
const AMBER = '#ff9f0a';
const INK = '#f5f5f7';
const MUTED = '#8a8a90';

mkdirSync('public/brand', { recursive: true });

/**
 * The scissor mark, drawn at an arbitrary size.
 *
 * Same geometry as the SVG favicon in index.html and the animated mark in the
 * app: two blades crossing at a rivet, with the rings beyond the tails so
 * they stay distinct. Kept in sync by hand — it is eight lines of drawing,
 * and sharing it across a browser bundle and a node script would cost more
 * than it saves.
 */
function drawMark(ctx, x, y, size) {
  const s = size / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = AMBER;
  ctx.lineCap = 'round';

  // Widths in the 24-unit coordinate space, matching the SVG favicon, rather
  // than a pixel width divided by the scale. Passing a pixel stroke made the
  // line grow with the icon until it swallowed the 2.4-radius rings and the
  // mark rendered as two solid blobs at 512px.
  // Blades start at 7.2, not 4: the rings are centred at (5.4, 5.4) and
  // (5.4, 18.6) with radius 2.4, so a blade from 4 runs straight through
  // them. At favicon size that overlap is invisible; at 512px it reads as a
  // line skewering two circles. Starting past the ring edge gives the
  // handles-and-blades silhouette the mark is supposed to have.
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  ctx.moveTo(7.2, 7.2);
  ctx.lineTo(20, 20);
  ctx.moveTo(7.2, 16.8);
  ctx.lineTo(20, 4);
  ctx.stroke();

  ctx.lineWidth = 1.4;
  for (const cy of [5.4, 18.6]) {
    ctx.beginPath();
    ctx.arc(5.4, cy, 2.4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Square icon, used for favicons and the apple-touch icon. */
function icon(size) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, size, size);
  // Inset so the mark is not flush to the edge at small sizes, where a
  // browser may round the corners.
  const pad = size * 0.17;
  drawMark(ctx, pad, pad, size - pad * 2);
  return c.toBuffer('image/png');
}

for (const size of [32, 180, 192, 512]) {
  writeFileSync(`public/brand/icon-${size}.png`, icon(size));
  console.log(`public/brand/icon-${size}.png`);
}

/* ---- the link preview card ---- */

const W = 1200;
const H = 630;
const c = createCanvas(W, H);
const ctx = c.getContext('2d');

ctx.fillStyle = BG;
ctx.fillRect(0, 0, W, H);

// A faint checkerboard, the same cue the canvas uses for transparency — it
// says "this is an image tool" without needing to explain.
ctx.fillStyle = '#0e0e10';
const sq = 24;
for (let y = 0; y < H; y += sq) {
  for (let x = 0; x < W; x += sq) {
    if (((x / sq) + (y / sq)) % 2 === 0) ctx.fillRect(x, y, sq, sq);
  }
}

// Amber hairline across the top, the same accent as the app's own busy bar.
const grad = ctx.createLinearGradient(0, 0, W, 0);
grad.addColorStop(0, 'rgba(255,159,10,0)');
grad.addColorStop(0.5, AMBER);
grad.addColorStop(1, 'rgba(255,159,10,0)');
ctx.fillStyle = grad;
ctx.fillRect(0, 0, W, 3);

drawMark(ctx, 96, 150, 116);

ctx.fillStyle = INK;
ctx.font = '600 82px Inter, Helvetica, Arial, sans-serif';
ctx.fillText('Cutline Studio', 96, 360);

ctx.fillStyle = MUTED;
ctx.font = '400 34px Inter, Helvetica, Arial, sans-serif';
ctx.fillText('Print-and-cut contour lines, straight from your artwork.', 96, 418);

// The three things a stranger needs to know, as chips.
ctx.font = '500 26px Inter, Helvetica, Arial, sans-serif';
let x = 96;
for (const label of ['SVG · PDF · DXF', 'CutContour spot colour', 'Runs in your browser']) {
  const w = ctx.measureText(label).width + 40;
  ctx.strokeStyle = '#232326';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, 486, w, 52, 26);
  ctx.stroke();
  ctx.fillStyle = MUTED;
  ctx.fillText(label, x + 20, 519);
  x += w + 14;
}

writeFileSync('public/brand/og.png', c.toBuffer('image/png'));
console.log('public/brand/og.png');
