/**
 * Flattened print file: white halo baked under the artwork.
 * PNG keeps transparency outside the cutline (Cricut / Silhouette
 * print-then-cut); JPEG composites everything on white (print-shop proofs,
 * gang sheets — JPEG has no alpha).
 */
export function buildRaster(opts: {
  image: HTMLImageElement | HTMLCanvasElement;
  srcW: number;
  srcH: number;
  svgPath: string;
  cutBbox: { x: number; y: number; w: number; h: number };
  halo: boolean;
  format: 'png' | 'jpeg';
}): Promise<Blob> {
  const pad = 4;
  const minX = Math.floor(Math.min(0, opts.cutBbox.x)) - pad;
  const minY = Math.floor(Math.min(0, opts.cutBbox.y)) - pad;
  const maxX = Math.ceil(Math.max(opts.srcW, opts.cutBbox.x + opts.cutBbox.w)) + pad;
  const maxY = Math.ceil(Math.max(opts.srcH, opts.cutBbox.y + opts.cutBbox.h)) + pad;
  const canvas = document.createElement('canvas');
  canvas.width = maxX - minX;
  canvas.height = maxY - minY;
  const ctx = canvas.getContext('2d')!;
  if (opts.format === 'jpeg') {
    // JPEG can't carry alpha — anything transparent would encode as black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.translate(-minX, -minY);
  if (opts.halo) {
    const path = new Path2D(opts.svgPath);
    ctx.fillStyle = '#ffffff';
    ctx.fill(path, 'evenodd');
  }
  ctx.drawImage(opts.image, 0, 0, opts.srcW, opts.srcH);
  const mime = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`${opts.format} encode failed`))),
      mime,
      0.92
    );
  });
}
