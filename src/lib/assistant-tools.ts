/**
 * The assistant's view of the studio, and the things it is allowed to do.
 *
 * Shared by the server (which hands these to the model as tool definitions)
 * and the browser (which validates and executes what the model asks for).
 * One source of truth, so a tool the model can call is always a tool the
 * studio can run — and nothing else is. The model never runs code; it names
 * one of these, with arguments this file has already agreed to.
 *
 * No SDK import here: this file is bundled into the studio.
 */
import { z } from 'zod';

export const PRESET_IDS = ['tight', 'close', 'sticker', 'loose'] as const;
export type PresetName = (typeof PRESET_IDS)[number];

/**
 * Numeric parameters the assistant may set, with the same bounds as the
 * Advanced sliders. Values outside are clamped by the studio, and the model
 * is told the bounds in the tool description so it rarely has to be.
 */
export const PARAM_RANGES = {
  offsetMm: { min: -2, max: 20, step: 0.05, unit: 'mm', label: 'offset' },
  alphaThreshold: { min: 1, max: 254, step: 1, unit: '', label: 'alpha threshold' },
  bgTolerance: { min: 4, max: 120, step: 1, unit: '', label: 'background tolerance' },
  denoisePx: { min: 0, max: 2, step: 0.1, unit: 'px', label: 'denoise' },
  precisionMm: { min: 0.02, max: 0.3, step: 0.01, unit: 'mm', label: 'precision' },
  smoothness: { min: 0, max: 3, step: 1, unit: '', label: 'smoothness' },
  minCornerRadiusMm: { min: 0, max: 3, step: 0.1, unit: 'mm', label: 'corner radius' },
  bridgeMm: { min: 0, max: 20, step: 0.5, unit: 'mm', label: 'bridge gaps' },
  holeMinMm2: { min: 0, max: 80, step: 1, unit: 'mm²', label: 'minimum hole' },
  dpi: { min: 72, max: 1200, step: 1, unit: 'dpi', label: 'print resolution' },
} as const;
export type ParamName = keyof typeof PARAM_RANGES;
export const PARAM_NAMES = Object.keys(PARAM_RANGES) as [ParamName, ...ParamName[]];

/** Snap a requested value into a parameter's range and onto its step. */
export function clampParam(name: ParamName, value: number): number {
  const r = PARAM_RANGES[name];
  const clamped = Math.min(r.max, Math.max(r.min, value));
  const stepped = Math.round((clamped - r.min) / r.step) * r.step + r.min;
  // Floating-point steps like 0.05 leave 3.1500000000000004 behind.
  const decimals = (String(r.step).split('.')[1] ?? '').length;
  return Number(stepped.toFixed(decimals));
}

/** Tool inputs, as zod. The server derives JSON Schema from these. */
export const TOOL_SCHEMAS = {
  set_cut_style: z.object({ style: z.enum(PRESET_IDS) }),
  set_interior_holes: z.object({ enabled: z.boolean() }),
  set_param: z.object({ name: z.enum(PARAM_NAMES), value: z.number() }),
  set_option: z.object({
    name: z.enum(['hugBody', 'halo', 'smartEdges']),
    enabled: z.boolean(),
  }),
  remove_background: z.object({ mode: z.enum(['auto', 'inside_too', 'start_over']) }),
  finish_background_removal: z.object({}),
  undo_background_removal: z.object({}),
  detect_elements: z.object({}),
  clear_elements: z.object({}),
  reset_settings: z.object({}),
  set_mode: z.object({ mode: z.enum(['simple', 'advanced']) }),
  open_export: z.object({ format: z.enum(['SVG', 'PDF', 'DXF', 'PNG']) }),
  get_state: z.object({}),
} as const;
export type ToolName = keyof typeof TOOL_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

/**
 * What each tool does, written for the model. Specific about effects and
 * limits, because the model decides from these alone; silent about
 * implementation, which it cannot act on.
 */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  set_cut_style:
    'Choose a cut style preset. tight = cut right on the artwork edge (0 mm, finest precision, no corner rounding) — for lettering and shapes that must keep their outline. close = 1 mm border. sticker = 3 mm border, the usual kiss-cut sticker outline; nearby parts merge into one shape. loose = 6 mm border. Applies the whole preset (offset, corner radius, precision, smoothing).',
  set_interior_holes:
    'Whether enclosed gaps inside the artwork — the counter of an O, a window in a shape — are cut too. Off (the default) makes a sticker: one outline, holes left filled. On makes a decal with the holes cut out.',
  set_param:
    `Set one Advanced parameter directly, as a number. Names, meaning and bounds: offsetMm = border around the artwork in mm (-2..20; negative cuts inside the edge). alphaThreshold = alpha cutoff 1..254 for transparent artwork; raise it to hug the solid body, lower it to include soft shadows. bgTolerance = colour tolerance 4..120 for finding a flat background on opaque images. denoisePx = 0..2 px blur before tracing, for JPEG noise. precisionMm = 0.02..0.3 mm max deviation of the cut from the traced edge; lower is more faithful with more nodes. smoothness = 0..3. minCornerRadiusMm = 0..3 mm minimum concave corner radius (0 = sharp). bridgeMm = 0..20 mm; gaps narrower than this between parts are bridged into one piece. holeMinMm2 = 0..80 mm²; interior holes smaller than this are not cut. dpi = 72..1200 print resolution (maps px to mm). Values are snapped into range.`,
  set_option:
    'Toggle an option. hugBody = trace the coloured body and peel off outside-connected white keylines or glows. halo = show (and export) a white backing under the cut shape, the vinyl a sticker is printed on; usually off for transparent artwork. smartEdges = trace edges with the on-device neural model instead of the pixel edge; it is approximate (512 px model), slower, downloads ~100 MB the first time, and is only worth it on photographs without a clean edge.',
  remove_background:
    'Remove the background from the artwork so the cut follows the subject. auto = the usual pass: a flat background is found from the image border (or, on a photo, the neural model). inside_too = also remove enclosed areas of the background colour, like white inside letters. start_over = discard any previous removal and corrections and run again from the original image. Does nothing on artwork that is already transparent — say so instead of calling it. After it runs the studio is in a refine session where the user can click the canvas to correct; call finish_background_removal when done.',
  finish_background_removal:
    'End the refine session after a background removal, keeping the result (the Done button).',
  undo_background_removal: 'Put the original artwork back, discarding the background removal and all corrections.',
  detect_elements:
    'Split the artwork into its elements (an icon and a wordmark, say) so each can be tuned separately with set_param while that element is selected. Not needed for ordinary stickers.',
  clear_elements: 'Remove all detected elements and their per-element tuning.',
  reset_settings: 'Put every setting back to its default (Sticker style). Keeps the artwork and the zoom.',
  set_mode: 'Show the Simple tab (cut style and holes) or the Advanced tab (every control).',
  open_export:
    'Open the export sheet with a format selected. SVG = layered print-and-cut file (artwork + cut layer). PDF = spot-colour cut. DXF = cut path only, for plotters; the only format that never sends the artwork anywhere. PNG = print-and-cut raster. The USER confirms the download and it costs 1 credit — you cannot spend credits; say so if they ask you to download directly.',
  get_state: 'Read the current studio state again: image, cut style, parameters, result (rings, nodes), account.',
};

/** What the studio reports about itself before every model turn. */
export interface StudioSnapshot {
  image: null | {
    name: string;
    width: number;
    height: number;
    hasAlpha: boolean;
    backgroundRemoved: boolean;
    refining: boolean;
    corrections: number;
  };
  mode: 'simple' | 'advanced';
  cutStyle: PresetName | 'custom';
  params: Record<ParamName, number> & {
    keepHoles: boolean;
    hugBody: boolean;
    engineVersion: string;
  };
  options: { halo: boolean; smartEdges: boolean };
  elements: { count: number; selected: number };
  cut: null | {
    rings: number;
    nodes: number;
    usedAlpha: boolean;
    widthMm: number;
    heightMm: number;
    overDense: boolean;
  };
  account: { signedIn: boolean; balance: number | null };
  exportDefault: 'SVG' | 'PDF' | 'DXF' | 'PNG' | null;
  /** The hints the studio is currently showing the user, verbatim. */
  notes: string[];
}

/** The same shape, as the server will accept it from a browser. */
export const SnapshotSchema = z.object({
  image: z
    .object({
      name: z.string().max(200),
      width: z.number().int().nonnegative(),
      height: z.number().int().nonnegative(),
      hasAlpha: z.boolean(),
      backgroundRemoved: z.boolean(),
      refining: z.boolean(),
      corrections: z.number().int().nonnegative(),
    })
    .nullable(),
  mode: z.enum(['simple', 'advanced']),
  cutStyle: z.enum([...PRESET_IDS, 'custom']),
  params: z.object({
    offsetMm: z.number(),
    alphaThreshold: z.number(),
    bgTolerance: z.number(),
    denoisePx: z.number(),
    precisionMm: z.number(),
    smoothness: z.number(),
    minCornerRadiusMm: z.number(),
    bridgeMm: z.number(),
    holeMinMm2: z.number(),
    dpi: z.number(),
    keepHoles: z.boolean(),
    hugBody: z.boolean(),
    engineVersion: z.string().max(10),
  }),
  options: z.object({ halo: z.boolean(), smartEdges: z.boolean() }),
  elements: z.object({ count: z.number().int().nonnegative(), selected: z.number().int() }),
  cut: z
    .object({
      rings: z.number().int().nonnegative(),
      nodes: z.number().int().nonnegative(),
      usedAlpha: z.boolean(),
      widthMm: z.number(),
      heightMm: z.number(),
      overDense: z.boolean(),
    })
    .nullable(),
  account: z.object({ signedIn: z.boolean(), balance: z.number().nullable() }),
  exportDefault: z.enum(['SVG', 'PDF', 'DXF', 'PNG']).nullable(),
  notes: z.array(z.string().max(300)).max(8),
});

/** The snapshot as text for the model: compact, labelled, nothing to parse. */
export function describeSnapshot(s: StudioSnapshot): string {
  const lines: string[] = [];
  if (!s.image) {
    lines.push('Image: none open yet. The user must open an image before anything can be cut.');
  } else {
    const i = s.image;
    lines.push(
      `Image: "${i.name}", ${i.width}×${i.height} px, ${i.hasAlpha ? 'transparent (has alpha)' : 'opaque (no alpha)'}` +
        (i.backgroundRemoved ? ', background removed' : '') +
        (i.refining ? `, refine session open (${i.corrections} correction${i.corrections === 1 ? '' : 's'})` : '')
    );
  }
  lines.push(`Tab: ${s.mode}. Cut style: ${s.cutStyle}.`);
  const p = s.params;
  lines.push(
    `Params: offset ${p.offsetMm} mm, corner radius ${p.minCornerRadiusMm} mm, precision ${p.precisionMm} mm, smoothness ${p.smoothness}, bridge ${p.bridgeMm} mm, interior holes ${p.keepHoles ? 'cut' : 'kept filled'} (min ${p.holeMinMm2} mm²), alpha threshold ${p.alphaThreshold}, background tolerance ${p.bgTolerance}, denoise ${p.denoisePx} px, hug body ${p.hugBody ? 'on' : 'off'}, ${p.dpi} dpi, engine ${p.engineVersion}.`
  );
  lines.push(`Options: halo ${s.options.halo ? 'on' : 'off'}, smart edges ${s.options.smartEdges ? 'on' : 'off'}.`);
  if (s.elements.count > 0) {
    lines.push(
      `Elements: ${s.elements.count} detected, ${s.elements.selected >= 0 ? `element ${s.elements.selected + 1} selected (Advanced threshold/denoise/offset apply to it only)` : 'none selected'}.`
    );
  }
  if (s.cut) {
    const c = s.cut;
    lines.push(
      `Cut: ${c.rings} path${c.rings === 1 ? '' : 's'}, ${c.nodes} nodes, ${c.widthMm.toFixed(1)}×${c.heightMm.toFixed(1)} mm, traced from ${c.usedAlpha ? 'the alpha channel' : 'a colour flood of the background'}` +
        (c.overDense ? ' — flagged as over-dense (too many nodes for a plotter; raise precision or smoothness)' : '') +
        '.'
    );
  } else if (s.image) {
    lines.push('Cut: none yet.');
  }
  lines.push(
    `Account: ${s.account.signedIn ? `signed in, ${s.account.balance ?? 0} credit${s.account.balance === 1 ? '' : 's'}` : 'signed out'}. Export default: ${s.exportDefault ?? 'none chosen'}.`
  );
  for (const n of s.notes) lines.push(`Note shown to the user: ${n}`);
  return lines.join('\n');
}

/** A short, human label for a tool call, shown in the transcript. */
export function describeToolCall(name: ToolName, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'set_cut_style':
      return `Cut style → ${capital(String(i.style))}`;
    case 'set_interior_holes':
      return `Interior holes → ${i.enabled ? 'cut' : 'kept'}`;
    case 'set_param': {
      const n = i.name as ParamName;
      const r = PARAM_RANGES[n];
      return `${capital(r?.label ?? String(n))} → ${String(i.value)}${r?.unit ? ' ' + r.unit : ''}`;
    }
    case 'set_option':
      return `${{ hugBody: 'Hug body', halo: 'White halo', smartEdges: 'Smart edges' }[String(i.name)] ?? String(i.name)} → ${i.enabled ? 'on' : 'off'}`;
    case 'remove_background':
      return { auto: 'Remove background', inside_too: 'Remove background, inside too', start_over: 'Remove background, from the original' }[String(i.mode)] ?? 'Remove background';
    case 'finish_background_removal':
      return 'Finish background removal';
    case 'undo_background_removal':
      return 'Undo background removal';
    case 'detect_elements':
      return 'Detect elements';
    case 'clear_elements':
      return 'Clear elements';
    case 'reset_settings':
      return 'Reset settings';
    case 'set_mode':
      return `Show the ${String(i.mode)} tab`;
    case 'open_export':
      return `Open export · ${String(i.format)}`;
    case 'get_state':
      return 'Read the studio state';
  }
}

function capital(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
