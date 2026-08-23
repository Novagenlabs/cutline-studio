/**
 * How long does a server render actually take?
 *
 * This is not a pass/fail assertion about speed — it is the measurement that
 * decides whether export needs a job queue or whether a queue would be
 * infrastructure bought before it is needed.
 */
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderExport, type RenderInput } from '../src/lib/render';

describe('render timing', () => {
  it('measures each format on realistic artwork', async () => {
    const logo = readFileSync(new URL('./fixtures/feelathome.png', import.meta.url));
    const dataUrl = `data:image/png;base64,${logo.toString('base64')}`;

    // ~32 contours, matching the Feel at Home logo at flush cut.
    const RINGS = 32, PTS = 60;
    const rings: { x: number; y: number }[][] = [];
    const beziers: RenderInput['beziers'] = [];
    let svgPath = '';
    for (let r = 0; r < RINGS; r++) {
      const cx = 200 + (r % 8) * 350, cy = 200 + Math.floor(r / 8) * 200, rad = 80;
      const ring: { x: number; y: number }[] = [];
      for (let i = 0; i < PTS; i++) {
        const t = (i / PTS) * Math.PI * 2;
        ring.push({ x: cx + rad * Math.cos(t), y: cy + rad * Math.sin(t) });
      }
      const bez = ring.map((a, i) => {
        const b = ring[(i + 1) % PTS];
        return [a, { ...a }, { ...b }, b] as [typeof a, typeof a, typeof a, typeof a];
      });
      rings.push(ring);
      beziers.push(bez);
      svgPath += `M ${ring[0].x.toFixed(2)} ${ring[0].y.toFixed(2)} ` +
        ring.slice(1).map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + ' Z ';
    }

    const base = {
      rings, beziers, svgPath,
      cutBbox: { x: 0, y: 0, w: 3166, h: 940 },
      srcW: 3166, srcH: 940, dpi: 300,
      spotName: 'CutContour', halo: true,
      imageDataUrl: dataUrl,
    };

    console.log(`\nartwork 3166x940, ${(logo.length / 1024 / 1024).toFixed(2)} MB, ${RINGS} contours`);
    console.log('format   cold     warm(median/5)   size');
    for (const format of ['SVG', 'DXF', 'PDF', 'PNG'] as const) {
      const t0 = performance.now();
      const first = await renderExport({ ...base, format });
      const cold = performance.now() - t0;

      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const s = performance.now();
        await renderExport({ ...base, format });
        times.push(performance.now() - s);
      }
      times.sort((a, b) => a - b);
      console.log(
        `${format.padEnd(8)} ${cold.toFixed(0).padStart(5)}ms  ${times[2].toFixed(0).padStart(6)}ms        ` +
        `${(first.bytes.byteLength / 1024).toFixed(0).padStart(6)} KB`
      );
    }
  }, 300_000);
});
