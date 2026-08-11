import Drawing from 'dxf-writer';
import type { Pt } from '../pipeline/types';

export interface DxfExportOpts {
  rings: Pt[][];
  srcH: number;
  dpi: number;
  layerName: string;
}

/**
 * Cut-only DXF (R12 polylines, mm, y-up) for Silhouette Studio, plotter
 * software, and laser cutters. Polylines rather than splines — cutters
 * prefer them and R12 has no spline entity anyway.
 */
export function buildDxf(o: DxfExportOpts): string {
  const mmPerPx = 25.4 / o.dpi;
  const d = new Drawing();
  d.setUnits('Millimeters');
  d.addLayer(o.layerName, Drawing.ACI.MAGENTA, 'CONTINUOUS');
  d.setActiveLayer(o.layerName);
  for (const ring of o.rings) {
    if (ring.length < 3) continue;
    const pts = ring.map((p) => [p.x * mmPerPx, (o.srcH - p.y) * mmPerPx] as [number, number]);
    d.drawPolyline(pts, true);
  }
  return d.toDxfString();
}
