/**
 * Flattened print-then-cut PNG: white halo baked under the artwork,
 * transparent outside the cutline (Cricut / Silhouette print-then-cut).
 */
export function buildPng(opts: {
  image: HTMLImageElement | HTMLCanvasElement;
  srcW: number;
  srcH: number;
  svgPath: string;
  cutBbox: { x: number; y: number; w: number; h: number };
  halo: boolean;
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
  ctx.translate(-minX, -minY);
  if (opts.halo) {
    const path = new Path2D(opts.svgPath);
    ctx.fillStyle = '#ffffff';
    ctx.fill(path, 'evenodd');
  }
  ctx.drawImage(opts.image, 0, 0, opts.srcW, opts.srcH);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
}
