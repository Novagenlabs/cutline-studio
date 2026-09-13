import { logoPixelSize } from "./pipeline";

/**
 * ADAPTED FROM THE UPSTREAM EXAMPLE.
 *
 * Upstream this rasterises the Next.js "N" from an inline SVG. This file
 * exists to turn a logo into a canvas, and ours is a different logo, so this
 * is the one file that is supposed to differ. The exported signature and the
 * abort handling are unchanged, because `renderer.ts` depends on both.
 *
 * The artwork is drawn rather than embedded as an SVG string: the wordmark is
 * live text, so it picks up the app's own typeface and needs no second copy
 * of the letterforms to keep in sync. Everything is STROKED, not filled —
 * outlined glyphs are the point, since the rim pass lights edges, and a solid
 * fill would give it nothing to find.
 */

/**
 * The artwork box.
 *
 * BOX_W has to hold the whole lockup or the wordmark is cropped — the raster
 * is drawn to a canvas of exactly this aspect, so anything past it is simply
 * not there. The width below is measured, not guessed: mark (96) + gap (54) +
 * the tracked-out caps at 132px, with a margin. `measuredWidth()` re-derives
 * it at runtime, because a font that falls back to system-ui sets wider than
 * Inter and would crop again.
 */
const BOX_H = 260;
const MARK_SIZE = 96;
const MARK_X = 8;
const TEXT_GAP = 54;
const FONT_PX = 132;
const TRACKING = 9;
const TEXT = 'CUTLINE STUDIO';

/** Width the artwork actually needs, in box units, for the current font. */
function measuredWidth(context: CanvasRenderingContext2D): number {
  context.font = `700 ${FONT_PX}px Inter, system-ui, sans-serif`;
  let width = 0;
  for (const glyph of TEXT) width += context.measureText(glyph).width + TRACKING;
  return MARK_X + MARK_SIZE + TEXT_GAP + width + MARK_X;
}

/** Fallback aspect, used if measurement is unavailable. */
export const CUTLINE_ASPECT = 1420 / BOX_H;

/**
 * The lockup's true aspect for the font that actually loaded.
 *
 * The rasteriser scales to fit whatever box it is given, so this and the box
 * must agree — pass the result to setLogoGeometry({ aspect }) before the
 * first raster, or the artwork is drawn into a shape of the wrong proportion
 * and either crops or floats.
 */
export function measureCutlineAspect(): number {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return CUTLINE_ASPECT;
  return measuredWidth(context) / BOX_H;
}

/** Where the ink sits in that box. Centred, so the light centres on it. */
export const CUTLINE_CENTER: [number, number] = [0.5, 0.5];

/** The scissor mark, in a 24-unit box, matching src/ui/cutmark.ts. */
function drawMark(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  lineWidth: number
): void {
  const u = size / 24;
  context.save();
  context.translate(x, y);
  context.lineWidth = lineWidth;
  context.lineCap = "round";

  // Two blades crossing at the rivet, mirrored about the horizontal.
  for (const sign of [-1, 1] as const) {
    context.save();
    context.translate(12 * u, 12 * u);
    context.rotate((sign * 40 * Math.PI) / 180);
    context.beginPath();
    context.moveTo(-6.4 * u, 0);
    context.lineTo(8 * u, 0);
    context.stroke();
    // The finger hole, beyond the tail so the two never merge.
    context.beginPath();
    context.arc(-8.8 * u, 0, 2.4 * u, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
  context.restore();
}

export async function rasterizeLogo(
  size: number,
  signal?: AbortSignal
): Promise<HTMLCanvasElement> {
  if (signal?.aborted)
    throw new DOMException("Logo rasterization aborted.", "AbortError");

  const [width, height] = logoPixelSize(size);
  const pad = 3;
  const canvas = document.createElement("canvas");
  canvas.width = width + pad * 2;
  canvas.height = height + pad * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create the logo raster canvas.");

  // Web fonts may still be loading on a cold start, and a wordmark rasterised
  // in the fallback face would be baked into the texture for the life of the
  // splash. Waiting is cheap and the alternative is not correctable.
  try {
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  } catch {
    // A missing or failed font manifest is not worth failing the splash over.
  }
  if (signal?.aborted)
    throw new DOMException("Logo rasterization aborted.", "AbortError");

  // Scale from the measured box, so the lockup always fits the raster it is
  // drawn into whatever font actually loaded.
  const boxW = measuredWidth(context);
  const scale = width / boxW;
  context.save();
  context.translate(pad, pad);
  context.scale(scale, scale);

  // White ink: the rim and composite passes tint it, so the artwork itself is
  // a mask rather than a coloured thing.
  context.strokeStyle = "#ffffff";
  context.fillStyle = "#ffffff";

  drawMark(context, MARK_X, (BOX_H - MARK_SIZE) / 2, MARK_SIZE, 7);

  context.font = `700 ${FONT_PX}px Inter, system-ui, sans-serif`;
  context.textBaseline = "middle";
  context.lineWidth = 4.5;
  context.lineJoin = "round";

  // Tracked out by hand: canvas has no letter-spacing, and outlined caps set
  // solid read as a fence rather than as a word.
  let cursor = MARK_X + MARK_SIZE + TEXT_GAP;
  for (const glyph of TEXT) {
    context.strokeText(glyph, cursor, BOX_H / 2);
    cursor += context.measureText(glyph).width + TRACKING;
  }
  context.restore();

  if (signal?.aborted)
    throw new DOMException("Logo rasterization aborted.", "AbortError");
  return canvas;
}
