import type { CutlineParams } from './pipeline/types';

/**
 * Cut styles for the simple mode.
 *
 * Most jobs are one of four decisions — cut on the line, or leave a small,
 * standard, or generous border — and every other control exists to serve
 * that choice. Advanced mode keeps all of them; this collapses them into the
 * decision an operator actually makes at the machine.
 *
 * The tight preset is deliberately uncompromising: zero offset so the blade
 * follows the artwork edge exactly, zero corner radius so nothing is rounded
 * away, and the finest precision the fitter offers. Those settings are only
 * safe together at zero offset — at a border you want some corner relief, or
 * a drag knife cannot articulate the inside corners — so each preset carries
 * a radius matched to its own offset rather than one global default.
 */
export type PresetId = 'tight' | 'close' | 'sticker' | 'loose';

export interface Preset {
  id: PresetId;
  label: string;
  /** What this does, in the operator's terms. */
  hint: string;
  params: Pick<
    CutlineParams,
    'offsetMm' | 'minCornerRadiusMm' | 'precisionMm' | 'smoothness' | 'bridgeMm'
  >;
}

export const PRESETS: Record<PresetId, Preset> = {
  tight: {
    id: 'tight',
    label: 'Tight',
    hint:
      'Cuts exactly on the artwork edge — no border, no corner rounding, finest ' +
      'precision. Best for lettering and shapes that must keep their outline.',
    params: {
      offsetMm: 0,
      // Any radius here would round off the very corners a flush cut exists
      // to preserve.
      minCornerRadiusMm: 0,
      precisionMm: 0.02,
      // Smoothing trades fidelity for fewer nodes; a flush cut wants fidelity.
      smoothness: 0,
      bridgeMm: 0,
    },
  },
  close: {
    id: 'close',
    label: 'Close',
    hint: 'A 1 mm border. Keeps letters separate while giving the blade a little room.',
    params: {
      offsetMm: 1,
      // Enough relief for the blade without merging tight counters.
      minCornerRadiusMm: 0.3,
      precisionMm: 0.04,
      smoothness: 1,
      bridgeMm: 0,
    },
  },
  sticker: {
    id: 'sticker',
    label: 'Sticker',
    hint: 'A 3 mm border — the usual kiss-cut sticker outline. Nearby parts merge into one shape.',
    params: {
      offsetMm: 3,
      minCornerRadiusMm: 1,
      precisionMm: 0.08,
      smoothness: 2,
      bridgeMm: 0,
    },
  },
  loose: {
    id: 'loose',
    label: 'Loose',
    hint: 'A 6 mm border with generous smoothing. For die-cut singles and easy weeding.',
    params: {
      offsetMm: 6,
      minCornerRadiusMm: 2,
      precisionMm: 0.12,
      smoothness: 3,
      bridgeMm: 0,
    },
  },
};

/**
 * Does the current state still match a preset?
 *
 * Used to keep the simple tab honest: if someone sets a preset, switches to
 * advanced, and nudges a slider, the preset button should stop claiming to
 * describe what the cut is doing.
 */
export function matchPreset(p: CutlineParams): PresetId | null {
  for (const preset of Object.values(PRESETS)) {
    const q = preset.params;
    if (
      near(p.offsetMm, q.offsetMm) &&
      near(p.minCornerRadiusMm, q.minCornerRadiusMm) &&
      near(p.precisionMm, q.precisionMm) &&
      p.smoothness === q.smoothness &&
      near(p.bridgeMm, q.bridgeMm)
    ) {
      return preset.id;
    }
  }
  return null;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
