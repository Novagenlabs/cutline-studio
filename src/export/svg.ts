export interface SvgExportOpts {
  srcW: number;
  srcH: number;
  dpi: number;
  svgPath: string;
  cutBbox: { x: number; y: number; w: number; h: number };
  imageDataUrl?: string;
  halo: boolean;
  spotName: string;
}

/**
 * Print-and-cut SVG: artwork layer + a stroke-only cutline layer.
 * SVG has no spot-color concept, so the RIP convention is carried by the
 * layer/path id and the 100%-magenta stroke.
 */
export function buildSvg(o: SvgExportOpts): string {
  const marginPx = (2 * o.dpi) / 25.4; // 2 mm around everything
  const minX = Math.min(0, o.cutBbox.x) - marginPx;
  const minY = Math.min(0, o.cutBbox.y) - marginPx;
  const maxX = Math.max(o.srcW, o.cutBbox.x + o.cutBbox.w) + marginPx;
  const maxY = Math.max(o.srcH, o.cutBbox.y + o.cutBbox.h) + marginPx;
  const w = maxX - minX;
  const h = maxY - minY;
  const mmW = ((w / o.dpi) * 25.4).toFixed(2);
  const mmH = ((h / o.dpi) * 25.4).toFixed(2);
  const strokePx = ((0.25 / 72) * o.dpi).toFixed(3); // 0.25 pt

  const halo = o.halo
    ? `  <g id="Halo"><path d="${o.svgPath}" fill="#ffffff" fill-rule="evenodd"/></g>\n`
    : '';
  const image = o.imageDataUrl
    ? `  <g id="Artwork"><image href="${o.imageDataUrl}" x="0" y="0" width="${o.srcW}" height="${o.srcH}"/></g>\n`
    : '';

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${mmW}mm" height="${mmH}mm" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(w)} ${fmt(h)}">\n` +
    halo +
    image +
    `  <g id="${o.spotName}">\n` +
    `    <path id="${o.spotName}-path" d="${o.svgPath}" fill="none" stroke="#ec008c" stroke-width="${strokePx}"/>\n` +
    `  </g>\n` +
    `</svg>\n`
  );
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
