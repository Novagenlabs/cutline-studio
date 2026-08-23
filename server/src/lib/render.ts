import { buildSvg } from '@cutline/pipeline/export/svg';
import { buildDxf } from '@cutline/pipeline/export/dxf';
import { buildPdf } from '@cutline/pipeline/export/pdf';
import type { BezierRing, Pt } from '@cutline/pipeline/pipeline/types';
import { provenanceComment } from './watermark';

/**
 * Server-side rendering of the paid artifact.
 *
 * These are the SAME builders the browser uses, imported from the shared
 * package rather than reimplemented. Two implementations of one cut geometry
 * would eventually disagree, and a customer receiving a file that differs
 * from the preview they approved is the worst possible bug in a print-and-cut
 * product.
 *
 * Nothing here touches the filesystem. Artwork arrives in the request, lives
 * in memory for the render, and is gone when the response is written.
 */

export interface RenderInput {
  format: 'SVG' | 'PDF' | 'DXF' | 'PNG';
  /** Cut geometry in SOURCE PIXELS, matching what the builders expect. */
  rings: Pt[][];
  beziers: BezierRing[];
  svgPath: string;
  cutBbox: { x: number; y: number; w: number; h: number };
  srcW: number;
  srcH: number;
  dpi: number;
  spotName: string;
  halo: boolean;
  imageDataUrl?: string;
}

export async function renderExport(
  input: RenderInput,
  downloadId?: string
): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
  const note = downloadId ? provenanceComment(downloadId) : undefined;

  switch (input.format) {
    case 'SVG': {
      const svg = buildSvg({
        srcW: input.srcW,
        srcH: input.srcH,
        dpi: input.dpi,
        svgPath: input.svgPath,
        cutBbox: input.cutBbox,
        imageDataUrl: input.imageDataUrl,
        halo: input.halo,
        spotName: input.spotName,
      });
      // Provenance rides in a comment: invisible to a cutter, present if the
      // file later needs tracing back to the account that bought it.
      const out = note ? svg.replace(/^(<\?xml[^>]*>\s*)?/, (m) => `${m}<!-- ${note} -->\n`) : svg;
      return { bytes: new TextEncoder().encode(out), mime: 'image/svg+xml', ext: 'svg' };
    }

    case 'DXF': {
      const dxf = buildDxf({
        rings: input.rings,
        srcH: input.srcH,
        dpi: input.dpi,
        layerName: input.spotName,
      });
      // DXF comments are `999` group codes, which every reader skips.
      const out = note ? `999\n${note}\n${dxf}` : dxf;
      return { bytes: new TextEncoder().encode(out), mime: 'application/dxf', ext: 'dxf' };
    }

    case 'PDF': {
      if (!input.imageDataUrl) throw new Error('PDF export needs the artwork');
      const bytes = await buildPdf({
        srcW: input.srcW,
        srcH: input.srcH,
        dpi: input.dpi,
        beziers: input.beziers,
        cutBbox: input.cutBbox,
        pngBytes: dataUrlToBytes(input.imageDataUrl),
        spotName: input.spotName,
      });
      return { bytes, mime: 'application/pdf', ext: 'pdf' };
    }

    case 'PNG': {
      if (!input.imageDataUrl) throw new Error('PNG export needs the artwork');
      // The raster builder needs a canvas and an <img>; on the server those
      // come from @napi-rs/canvas, which implements the same 2D API.
      const { renderRasterServer } = await import('./raster-server');
      const bytes = await renderRasterServer(input);
      return { bytes, mime: 'image/png', ext: 'png' };
    }
  }
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('malformed data URL');
  return Uint8Array.from(Buffer.from(dataUrl.slice(comma + 1), 'base64'));
}
