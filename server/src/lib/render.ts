import { buildSvg } from '@cutline/pipeline/export/svg';
import { buildDxf } from '@cutline/pipeline/export/dxf';
import { buildPdf } from '@cutline/pipeline/export/pdf';
import { provenanceComment } from './watermark';

/**
 * Server-side rendering of the paid artifact.
 *
 * These are the SAME builders the browser uses for its preview, imported from
 * the shared pipeline rather than reimplemented — two implementations of the
 * same cut geometry would eventually disagree, and a customer receiving a file
 * that differs from the preview they approved is the worst possible bug in a
 * print-and-cut product.
 *
 * Nothing here touches the filesystem. The artwork arrives in the request,
 * lives in memory for the duration of the render, and is gone when the
 * response is written.
 */

export interface RenderInput {
  format: 'SVG' | 'PDF' | 'DXF' | 'PNG';
  beziers: number[][][][];
  widthMm: number;
  heightMm: number;
  dpi: number;
  imageDataUrl?: string;
}

export async function renderExport(
  input: RenderInput,
  downloadId?: string
): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
  const beziers = toBezierRings(input.beziers);
  const note = downloadId ? provenanceComment(downloadId) : undefined;

  switch (input.format) {
    case 'SVG': {
      const svg = buildSvg({
        beziers,
        widthMm: input.widthMm,
        heightMm: input.heightMm,
        dpi: input.dpi,
      });
      // Provenance rides in a comment: invisible to a cutter, present if the
      // file later needs to be traced back to the account that bought it.
      const withNote = note ? svg.replace(/^(<\?xml[^>]*>\s*)?/, (m) => `${m}<!-- ${note} -->\n`) : svg;
      return { bytes: new TextEncoder().encode(withNote), mime: 'image/svg+xml', ext: 'svg' };
    }
    case 'DXF': {
      const dxf = buildDxf({
        beziers,
        widthMm: input.widthMm,
        heightMm: input.heightMm,
        dpi: input.dpi,
      });
      return { bytes: new TextEncoder().encode(dxf), mime: 'application/dxf', ext: 'dxf' };
    }
    case 'PDF': {
      if (!input.imageDataUrl) throw new Error('PDF export needs the artwork');
      const bytes = await buildPdf({
        beziers,
        widthMm: input.widthMm,
        heightMm: input.heightMm,
        dpi: input.dpi,
        imageBytes: dataUrlToBytes(input.imageDataUrl),
      } as Parameters<typeof buildPdf>[0]);
      return { bytes, mime: 'application/pdf', ext: 'pdf' };
    }
    case 'PNG': {
      if (!input.imageDataUrl) throw new Error('PNG export needs the artwork');
      // The raster builder needs a canvas; on the server that comes from
      // @napi-rs/canvas, which implements the same 2D API the browser path
      // uses, so drawWatermark and the raster builder are shared unchanged.
      const { renderRasterServer } = await import('./raster-server');
      const bytes = await renderRasterServer(input);
      return { bytes, mime: 'image/png', ext: 'png' };
    }
  }
}

/** The wire format is plain arrays; the builders want {x,y} points. */
function toBezierRings(rings: number[][][][]) {
  return rings.map((ring) =>
    ring.map((seg) => seg.map(([x, y]) => ({ x, y })) as [
      { x: number; y: number }, { x: number; y: number },
      { x: number; y: number }, { x: number; y: number }
    ])
  );
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('malformed data URL');
  return Uint8Array.from(Buffer.from(dataUrl.slice(comma + 1), 'base64'));
}
