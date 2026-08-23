/**
 * Preview watermarking.
 *
 * What this is for, and what it is not for.
 *
 * A watermark cannot stop a screenshot — anything a person can see, they can
 * photograph. It is not a security control and nothing in the payment path
 * depends on it. Its job is narrower and still worth doing: make the free
 * preview obviously unsuitable for production use, so the honest majority buy
 * a credit rather than shipping the preview to a plotter.
 *
 * The actual enforcement is that the paid artifact is never generated on the
 * client at all. A screenshot of a cut path is worthless to a cutting machine:
 * what a customer needs is the vector geometry, and that only ever comes from
 * the server after a credit is spent. Watermarking protects the thing that is
 * cheap to copy; withholding the vectors protects the thing that has value.
 */

/** Tiling diagonal wordmark, sized relative to the artwork so it scales. */
export function watermarkSvgOverlay(widthMm: number, heightMm: number, label: string): string {
  const step = Math.max(28, Math.min(widthMm, heightMm) / 3);
  const fontSize = step / 5.5;
  return [
    `<defs><pattern id="cl-wm" width="${step}" height="${step}" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">`,
    `<text x="0" y="${step / 2}" font-family="Helvetica,Arial,sans-serif" font-size="${fontSize}"`,
    ` fill="#000" fill-opacity="0.13" letter-spacing="${fontSize * 0.12}">${escapeXml(label)}</text>`,
    `</pattern></defs>`,
    `<rect x="0" y="0" width="${widthMm}" height="${heightMm}" fill="url(#cl-wm)" pointer-events="none"/>`,
  ].join('');
}

/**
 * Paint the same tiling wordmark onto a raster preview.
 * Canvas-2D compatible, so it runs identically on a server canvas and in the
 * browser preview — one implementation, one appearance.
 */
export function drawWatermark(
  ctx: {
    save(): void; restore(): void; translate(x: number, y: number): void; rotate(a: number): void;
    fillText(t: string, x: number, y: number): void;
    measureText(t: string): { width: number };
    font: string; fillStyle: string; globalAlpha: number;
  },
  width: number,
  height: number,
  label: string
): void {
  const step = Math.max(160, Math.min(width, height) / 3);
  const fontSize = Math.round(step / 5.5);
  ctx.save();
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = '#000';
  ctx.font = `${fontSize}px Helvetica, Arial, sans-serif`;
  ctx.translate(width / 2, height / 2);
  ctx.rotate((-30 * Math.PI) / 180);
  const span = Math.hypot(width, height);
  for (let y = -span; y < span; y += step) {
    for (let x = -span; x < span; x += step) {
      ctx.fillText(label, x, y);
    }
  }
  ctx.restore();
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string)
  );
}

/**
 * Per-user forensic marker for PAID files.
 *
 * Paid output carries no visible watermark — customers are paying for a clean
 * cut file. It does carry the download id in metadata, so a file later found
 * circulating can be traced to the account that bought it. This deters
 * redistribution without degrading what the customer paid for, and it is
 * removable by a determined party, which is an accepted limit rather than an
 * oversight: the alternative is degrading every honest customer's file.
 */
export function provenanceComment(downloadId: string, when = new Date()): string {
  return `Cutline Studio · ${downloadId} · ${when.toISOString()}`;
}
