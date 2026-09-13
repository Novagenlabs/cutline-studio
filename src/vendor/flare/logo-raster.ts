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
 * Its width has to hold the whole lockup or the wordmark is cropped — the
 * raster is drawn to a canvas of exactly this aspect, so anything past it is
 * simply not there. Both dimensions are derived rather than fixed:
 * `measuredWidth()` from the mark, the gap and the real glyph advances of the
 * font that actually loaded, and `boxHeight()` from the mark, which is the
 * tallest thing in the lockup.
 */
const MARK_X = 8;
const TEXT_GAP = 54;
const FONT_PX = 132;
const TRACKING = 9;
const TEXT = 'CUTLINE STUDIO';

/**
 * The parts of the lockup worth tuning, settable so the motion lab can drive
 * them live rather than needing a rebuild per adjustment.
 *
 * The box height follows the mark: at MARK_SIZE 192 the old fixed 260 would
 * have clipped the scissors top and bottom.
 */
export interface LockupStyle {
  /** Scissor mark size, in box units. */
  markSize: number;
  /** Stroke weight of the mark. */
  markStroke: number;
  /** Stroke weight of the wordmark's outlined caps. */
  textStroke: number;
}

export const DEFAULT_LOCKUP: LockupStyle = {
  // Doubled from 96: at the old size the mark read as a bullet point beside
  // the type rather than as half the lockup.
  markSize: 192,
  markStroke: 7,
  // Halved from 4.5: at 132px the heavier outline closed up the counters and
  // the caps read as solid rather than hollow.
  textStroke: 2.25,
};

let LOCKUP: LockupStyle = { ...DEFAULT_LOCKUP };

export function setLockupStyle(style: Partial<LockupStyle>): void {
  LOCKUP = { ...LOCKUP, ...style };
}

/** Tall enough for the mark plus breathing room; the type is shorter. */
function boxHeight(): number {
  return Math.max(260, LOCKUP.markSize + 68);
}

/** Width the artwork actually needs, in box units, for the current font. */
function measuredWidth(context: CanvasRenderingContext2D): number {
  context.font = `700 ${FONT_PX}px Inter, system-ui, sans-serif`;
  let width = 0;
  for (const glyph of TEXT) width += context.measureText(glyph).width + TRACKING;
  // Trailing TRACKING is dropped: it is spacing after the last glyph, and
  // leaving it in shifts the whole lockup left of centre by half of it.
  width -= TRACKING;
  return MARK_X + LOCKUP.markSize + TEXT_GAP + width + MARK_X;
}

/** Fallback aspect, used if measurement is unavailable. */
export const CUTLINE_ASPECT = 1420 / 260;

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
  return measuredWidth(context) / boxHeight();
}

/**
 * Where the ink actually sits inside the box, 0–1.
 *
 * Not simply [0.5, 0.5]. The mark starts at MARK_X on the left and the box
 * ends MARK_X after the last glyph, but a stroked cap overhangs its advance
 * width and the scissors' round line caps overhang theirs, so the drawn ink
 * is not quite symmetric within the measured box. The rim and beam passes
 * centre their light on this point, so an error here puts the hotspot off
 * the lockup — measured at about 0.4% before this, which reads as the light
 * favouring one end.
 */
export function measureCutlineCenter(): [number, number] {
  // Measured from the pixels rather than computed from the layout. A formula
  // has to model every overhang — stroke caps, joins, the text baseline's
  // relationship to cap height — and mine disagreed with the real ink by
  // half a percent when checked. Rasterising a small proof and finding the
  // alpha bounds cannot be wrong about where the ink is.
  try {
    const probe = document.createElement('canvas');
    const w = 600;
    const context = probe.getContext('2d');
    if (!context) return [0.5, 0.5];

    const boxW = measuredWidth(context);
    const boxH = boxHeight();
    // Resizing clears the context, so the measurement above has to happen
    // before this and the drawing after it.
    probe.width = w;
    probe.height = Math.max(1, Math.round((w * boxH) / boxW));

    context.scale(probe.width / boxW, probe.height / boxH);
    context.strokeStyle = '#fff';
    drawLockup(context);

    const { data } = context.getImageData(0, 0, probe.width, probe.height);
    let minX = probe.width;
    let maxX = -1;
    let minY = probe.height;
    let maxY = -1;
    for (let y = 0; y < probe.height; y++) {
      for (let x = 0; x < probe.width; x++) {
        if (data[(y * probe.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return [0.5, 0.5];
    return [
      (minX + maxX) / 2 / probe.width,
      (minY + maxY) / 2 / probe.height,
    ];
  } catch {
    return [0.5, 0.5];
  }
}

/** Fallback for callers that cannot measure. */
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

/**
 * Draw the lockup in box units.
 *
 * Shared by the real raster and by the centring probe, so the thing measured
 * is by construction the thing drawn — two copies of this would drift and the
 * light would end up centred on artwork that no longer exists.
 */
function drawLockup(context: CanvasRenderingContext2D): void {
  const boxH = boxHeight();

  drawMark(
    context,
    MARK_X,
    (boxH - LOCKUP.markSize) / 2,
    LOCKUP.markSize,
    LOCKUP.markStroke
  );

  context.font = `700 ${FONT_PX}px Inter, system-ui, sans-serif`;
  context.textBaseline = 'middle';
  context.lineWidth = LOCKUP.textStroke;
  context.lineJoin = 'round';

  // Tracked out by hand: canvas has no letter-spacing, and outlined caps set
  // solid read as a fence rather than as a word.
  let cursor = MARK_X + LOCKUP.markSize + TEXT_GAP;
  for (const glyph of TEXT) {
    context.strokeText(glyph, cursor, boxH / 2);
    cursor += context.measureText(glyph).width + TRACKING;
  }
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

  drawLockup(context);
  context.restore();

  if (signal?.aborted)
    throw new DOMException("Logo rasterization aborted.", "AbortError");
  return canvas;
}
