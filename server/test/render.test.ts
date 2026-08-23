/**
 * The server renders real files from the SHARED builders.
 *
 * The point of these is not that a string contains a substring — it is that
 * the server can import the client's export code at all and produce output
 * with the properties a cutter depends on (spot colour naming, mm sizing,
 * a real PDF/PNG header). If the shared-package wiring breaks, this fails.
 */
import { describe, it, expect } from 'vitest';
import { renderExport, type RenderInput } from '../src/lib/render';

// A 2x2 red PNG, enough for the formats that embed a raster.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';

const base: RenderInput = {
  format: 'SVG',
  rings: [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }]],
  beziers: [[
    [{ x: 0, y: 0 }, { x: 33, y: 0 }, { x: 66, y: 0 }, { x: 100, y: 0 }],
    [{ x: 100, y: 0 }, { x: 100, y: 27 }, { x: 100, y: 53 }, { x: 100, y: 80 }],
    [{ x: 100, y: 80 }, { x: 66, y: 80 }, { x: 33, y: 80 }, { x: 0, y: 80 }],
    [{ x: 0, y: 80 }, { x: 0, y: 53 }, { x: 0, y: 27 }, { x: 0, y: 0 }],
  ]],
  svgPath: 'M 0 0 C 33 0 66 0 100 0 C 100 27 100 53 100 80 C 66 80 33 80 0 80 C 0 53 0 27 0 0 Z',
  cutBbox: { x: 0, y: 0, w: 100, h: 80 },
  srcW: 100,
  srcH: 80,
  dpi: 300,
  spotName: 'CutContour',
  halo: true,
  imageDataUrl: TINY_PNG,
};

describe('server rendering via the shared pipeline', () => {
  it('SVG carries the cut layer and mm dimensions', async () => {
    const { bytes, mime, ext } = await renderExport({ ...base, format: 'SVG' });
    const svg = new TextDecoder().decode(bytes);
    expect(mime).toBe('image/svg+xml');
    expect(ext).toBe('svg');
    expect(svg).toContain('<svg');
    expect(svg).toContain('mm');
    expect(svg).toContain('CutContour');
  });

  it('SVG stamps provenance when a download id is known', async () => {
    const { bytes } = await renderExport({ ...base, format: 'SVG' }, 'dl_abc123');
    const svg = new TextDecoder().decode(bytes);
    expect(svg).toContain('dl_abc123');
    expect(svg).toMatch(/<!--[^>]*Cutline Studio/);
    // The marker must not disturb the document root.
    expect(svg.trimStart().startsWith('<!--') || svg.trimStart().startsWith('<?xml')).toBe(true);
  });

  it('SVG without a download id carries no marker', async () => {
    const { bytes } = await renderExport({ ...base, format: 'SVG' });
    expect(new TextDecoder().decode(bytes)).not.toContain('Cutline Studio ·');
  });

  it('DXF is a real DXF on the named layer', async () => {
    const { bytes, ext } = await renderExport({ ...base, format: 'DXF' });
    const dxf = new TextDecoder().decode(bytes);
    expect(ext).toBe('dxf');
    expect(dxf).toContain('SECTION');
    expect(dxf).toContain('POLYLINE');
    expect(dxf).toContain('CutContour');
  });

  it('DXF provenance uses a 999 comment, which readers skip', async () => {
    const { bytes } = await renderExport({ ...base, format: 'DXF' }, 'dl_xyz789');
    const dxf = new TextDecoder().decode(bytes);
    expect(dxf.startsWith('999\n')).toBe(true);
    expect(dxf).toContain('dl_xyz789');
    // The drawing itself must still be intact after the comment.
    expect(dxf).toContain('SECTION');
    expect(dxf).toContain('POLYLINE');
  });

  it('PDF is a real PDF naming the spot colour', async () => {
    const { bytes, mime } = await renderExport({ ...base, format: 'PDF' });
    expect(mime).toBe('application/pdf');
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(new TextDecoder().decode(bytes)).toContain('CutContour');
  });

  it('PNG renders through the Node canvas', async () => {
    const { bytes, mime } = await renderExport({ ...base, format: 'PNG' });
    expect(mime).toBe('image/png');
    // PNG magic number.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.byteLength).toBeGreaterThan(100);
  });

  it('formats needing artwork refuse to render without it', async () => {
    const noArt = { ...base, imageDataUrl: undefined };
    await expect(renderExport({ ...noArt, format: 'PDF' })).rejects.toThrow();
    await expect(renderExport({ ...noArt, format: 'PNG' })).rejects.toThrow();
    // Vector-only formats need no artwork, which is what keeps the
    // "artwork never leaves the machine" promise true for SVG and DXF.
    await expect(renderExport({ ...noArt, format: 'SVG' })).resolves.toBeTruthy();
    await expect(renderExport({ ...noArt, format: 'DXF' })).resolves.toBeTruthy();
  });
});
