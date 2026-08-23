import { createCanvas, loadImage, Path2D as NapiPath2D } from '@napi-rs/canvas';
import type { RenderInput } from './render';

/**
 * Server-side PNG export.
 *
 * The client's `buildRaster` cannot be reused directly: it reaches for
 * `document.createElement('canvas')`, the global `Path2D`, and `toBlob`,
 * none of which exist in Node. What CAN be shared is the thing that actually
 * matters — the geometry (`svgPath`, `cutBbox`) is the same data the preview
 * drew, so the framing and halo below reproduce the client's arithmetic
 * exactly rather than approximating it.
 *
 * Keep this in step with `src/export/png.ts`. The padding, bounds, halo fill
 * rule, and draw order are duplicated deliberately (a Node canvas cannot be
 * abstracted behind the DOM one without a shim that would itself drift), and
 * a divergence here means a customer's file differs from their preview.
 */
export async function renderRasterServer(input: RenderInput): Promise<Uint8Array> {
  if (!input.imageDataUrl) throw new Error('PNG export needs the artwork');

  // Same framing as src/export/png.ts.
  const pad = 4;
  const minX = Math.floor(Math.min(0, input.cutBbox.x)) - pad;
  const minY = Math.floor(Math.min(0, input.cutBbox.y)) - pad;
  const maxX = Math.ceil(Math.max(input.srcW, input.cutBbox.x + input.cutBbox.w)) + pad;
  const maxY = Math.ceil(Math.max(input.srcH, input.cutBbox.y + input.cutBbox.h)) + pad;

  const canvas = createCanvas(maxX - minX, maxY - minY);
  const ctx = canvas.getContext('2d');

  ctx.translate(-minX, -minY);

  if (input.halo) {
    // evenodd matches the client, so nested contours (a counter inside a
    // glyph) punch through the halo the same way they do in the preview.
    const path = new NapiPath2D(input.svgPath);
    ctx.fillStyle = '#ffffff';
    ctx.fill(path, 'evenodd');
  }

  const image = await loadImage(input.imageDataUrl);
  ctx.drawImage(image, 0, 0, input.srcW, input.srcH);

  return canvas.encode('png');
}
