import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFOperator,
  PDFOperatorNames,
  PDFNumber,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  setLineWidth,
  setLineJoin,
  LineJoinStyle,
  moveTo,
  appendBezierCurve,
  closePath,
  stroke,
} from 'pdf-lib';
import type { BezierRing } from '../pipeline/types';

export interface PdfExportOpts {
  srcW: number;
  srcH: number;
  dpi: number;
  beziers: BezierRing[];
  cutBbox: { x: number; y: number; w: number; h: number };
  pngBytes?: Uint8Array;
  spotName: string;
}

/**
 * Production PDF: raster artwork + the cutline stroked in a true
 * /Separation spot color (named e.g. "CutContour") with overprint on —
 * exactly what Roland VersaWorks / ONYX / Flexi RIPs key on.
 * Neither jsPDF nor pdf-lib support spot colors natively, so the
 * colorspace, tint transform, and content-stream operators are built by
 * hand per PDF 1.7 §8.6.6.4.
 */
export async function buildPdf(o: PdfExportOpts): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Cutline Studio export');
  doc.setProducer('Cutline Studio');

  const s = 72 / o.dpi; // px -> pt
  const marginPx = (2 * o.dpi) / 25.4;
  const minX = Math.min(0, o.cutBbox.x) - marginPx;
  const minY = Math.min(0, o.cutBbox.y) - marginPx;
  const maxX = Math.max(o.srcW, o.cutBbox.x + o.cutBbox.w) + marginPx;
  const maxY = Math.max(o.srcH, o.cutBbox.y + o.cutBbox.h) + marginPx;
  const pageW = (maxX - minX) * s;
  const pageH = (maxY - minY) * s;
  const page = doc.addPage([pageW, pageH]);

  if (o.pngBytes) {
    const png = await doc.embedPng(o.pngBytes);
    page.drawImage(png, {
      x: (0 - minX) * s,
      y: pageH - (o.srcH - minY) * s,
      width: o.srcW * s,
      height: o.srcH * s,
    });
  }

  const ctx = doc.context;

  // Separation colorspace with a type-2 tint transform to 100% magenta.
  const tintFn = ctx.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: [0, 1, 0, 0],
    N: 1,
  });
  const tintRef = ctx.register(tintFn);
  const sepArray = ctx.obj([
    PDFName.of('Separation'),
    PDFName.of(o.spotName),
    PDFName.of('DeviceCMYK'),
    tintRef,
  ]);
  const sepRef = ctx.register(sepArray);

  // Overprint graphics state so the cutline never knocks out the print.
  const gsDict = ctx.obj({ Type: 'ExtGState', OP: true, op: false, OPM: 1 });
  const gsRef = ctx.register(gsDict);

  const resources = page.node.normalizedEntries().Resources;
  let csDict = resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
  if (!csDict) {
    csDict = ctx.obj({}) as PDFDict;
    resources.set(PDFName.of('ColorSpace'), csDict);
  }
  csDict.set(PDFName.of('CutCS'), sepRef);
  let gsResDict = resources.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  if (!gsResDict) {
    gsResDict = ctx.obj({}) as PDFDict;
    resources.set(PDFName.of('ExtGState'), gsResDict);
  }
  gsResDict.set(PDFName.of('GSCut'), gsRef);

  const ops: PDFOperator[] = [
    pushGraphicsState(),
    PDFOperator.of('gs' as PDFOperatorNames, [PDFName.of('GSCut')]),
    // Map top-left y-down px space onto the page.
    concatTransformationMatrix(s, 0, 0, -s, -minX * s, pageH + minY * s),
    PDFOperator.of(PDFOperatorNames.StrokingColorspace, [PDFName.of('CutCS')]),
    PDFOperator.of(PDFOperatorNames.StrokingColorN, [PDFNumber.of(1)]),
    setLineWidth(0.25 / s),
    setLineJoin(LineJoinStyle.Round),
  ];
  for (const ring of o.beziers) {
    if (!ring.length) continue;
    ops.push(moveTo(ring[0][0].x, ring[0][0].y));
    for (const [, c1, c2, p1] of ring) {
      ops.push(appendBezierCurve(c1.x, c1.y, c2.x, c2.y, p1.x, p1.y));
    }
    ops.push(closePath());
  }
  ops.push(stroke(), popGraphicsState());
  page.pushOperators(...ops);

  // No object streams: legacy RIP parsers (VersaWorks-era) read plain xref PDFs.
  return doc.save({ useObjectStreams: false });
}
