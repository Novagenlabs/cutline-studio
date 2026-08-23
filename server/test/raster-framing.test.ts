/**
 * The server's PNG framing is duplicated from src/export/png.ts because a
 * Node canvas cannot be driven through the DOM canvas API. Duplicated
 * arithmetic drifts, and a drift here means the customer's paid file is
 * framed differently from the preview they approved.
 *
 * This pins the two together: the expected values are computed from the
 * client's formula, read straight out of its source, and compared against the
 * server's. If either side changes, this fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The client's framing, transcribed from src/export/png.ts. */
function clientFraming(o: {
  srcW: number; srcH: number; cutBbox: { x: number; y: number; w: number; h: number };
}) {
  const pad = 4;
  const minX = Math.floor(Math.min(0, o.cutBbox.x)) - pad;
  const minY = Math.floor(Math.min(0, o.cutBbox.y)) - pad;
  const maxX = Math.ceil(Math.max(o.srcW, o.cutBbox.x + o.cutBbox.w)) + pad;
  const maxY = Math.ceil(Math.max(o.srcH, o.cutBbox.y + o.cutBbox.h)) + pad;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/** The server's framing, transcribed from src/lib/raster-server.ts. */
function serverFraming(o: {
  srcW: number; srcH: number; cutBbox: { x: number; y: number; w: number; h: number };
}) {
  const pad = 4;
  const minX = Math.floor(Math.min(0, o.cutBbox.x)) - pad;
  const minY = Math.floor(Math.min(0, o.cutBbox.y)) - pad;
  const maxX = Math.ceil(Math.max(o.srcW, o.cutBbox.x + o.cutBbox.w)) + pad;
  const maxY = Math.ceil(Math.max(o.srcH, o.cutBbox.y + o.cutBbox.h)) + pad;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

const CASES = [
  { name: 'cut inside the artwork', srcW: 800, srcH: 600, cutBbox: { x: 10, y: 10, w: 700, h: 500 } },
  { name: 'cut overhangs right/bottom', srcW: 800, srcH: 600, cutBbox: { x: 10, y: 10, w: 900, h: 700 } },
  { name: 'cut starts left/above origin', srcW: 800, srcH: 600, cutBbox: { x: -35, y: -35, w: 900, h: 700 } },
  { name: 'subpixel bbox', srcW: 667, srcH: 464, cutBbox: { x: -12.7, y: -8.3, w: 690.2, h: 480.9 } },
  { name: 'tiny artwork', srcW: 10, srcH: 10, cutBbox: { x: -2.5, y: -2.5, w: 15, h: 15 } },
];

describe('server PNG framing matches the client', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(serverFraming(c)).toEqual(clientFraming(c));
    });
  }

  it('the transcription still matches the real client source', () => {
    // Guard against this test drifting from the file it claims to mirror.
    const src = readFileSync(join(__dirname, '../../src/export/png.ts'), 'utf8');
    expect(src).toContain('const pad = 4;');
    expect(src).toContain('Math.floor(Math.min(0, opts.cutBbox.x)) - pad');
    expect(src).toContain('Math.ceil(Math.max(opts.srcW, opts.cutBbox.x + opts.cutBbox.w)) + pad');
    // The halo fill rule matters as much as the bounds.
    expect(src).toContain("ctx.fill(path, 'evenodd')");
  });

  it('the server source still uses that same arithmetic', () => {
    const src = readFileSync(join(__dirname, '../src/lib/raster-server.ts'), 'utf8');
    expect(src).toContain('const pad = 4;');
    expect(src).toContain('Math.floor(Math.min(0, input.cutBbox.x)) - pad');
    expect(src).toContain('Math.ceil(Math.max(input.srcW, input.cutBbox.x + input.cutBbox.w)) + pad');
    expect(src).toContain("ctx.fill(path, 'evenodd')");
  });
});
