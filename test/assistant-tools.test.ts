// The assistant's tool catalogue: the contract between the model and the studio.
//
// Everything the model can do is one of these, with arguments these schemas
// have agreed to. The server derives the model-facing definitions from them
// and the browser validates every call against them before running it, so
// the two cannot drift. These pin the behaviour that matters: ranges are
// enforced, the snapshot reads as the model will see it, and a call is
// described to the user in words.
import { describe, it, expect } from 'vitest';
import {
  TOOL_SCHEMAS,
  TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  PARAM_RANGES,
  clampParam,
  describeSnapshot,
  describeToolCall,
  SnapshotSchema,
  type StudioSnapshot,
} from '../src/lib/assistant-tools';

const snapshot: StudioSnapshot = {
  image: { name: 'logo', width: 3166, height: 940, hasAlpha: true, backgroundRemoved: false, refining: false, corrections: 0 },
  mode: 'simple',
  cutStyle: 'sticker',
  params: {
    offsetMm: 3, alphaThreshold: 128, bgTolerance: 32, denoisePx: 0.4, precisionMm: 0.08,
    smoothness: 2, minCornerRadiusMm: 1, bridgeMm: 0, holeMinMm2: 1, dpi: 300,
    keepHoles: false, hugBody: false, engineVersion: 'v3',
  },
  options: { halo: false, smartEdges: false },
  elements: { count: 0, selected: -1 },
  cut: { rings: 6, nodes: 444, usedAlpha: true, widthMm: 268.1, heightMm: 79.6, overDense: false },
  account: { signedIn: true, balance: 5 },
  exportDefault: 'SVG',
  notes: ['Tracing the alpha channel.'],
};

describe('the tool catalogue', () => {
  it('has a description for every tool, and nothing undescribed', () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_DESCRIPTIONS[name]).toBeTruthy();
    }
    expect(Object.keys(TOOL_DESCRIPTIONS).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('accepts exactly the arguments each tool takes', () => {
    expect(TOOL_SCHEMAS.set_cut_style.safeParse({ style: 'tight' }).success).toBe(true);
    expect(TOOL_SCHEMAS.set_cut_style.safeParse({ style: 'medium' }).success).toBe(false);
    expect(TOOL_SCHEMAS.set_param.safeParse({ name: 'offsetMm', value: 2.5 }).success).toBe(true);
    expect(TOOL_SCHEMAS.set_param.safeParse({ name: 'engineVersion', value: 2 }).success).toBe(false);
    expect(TOOL_SCHEMAS.set_param.safeParse({ name: 'offsetMm', value: '2.5' }).success).toBe(false);
    expect(TOOL_SCHEMAS.open_export.safeParse({ format: 'SVG' }).success).toBe(true);
    expect(TOOL_SCHEMAS.open_export.safeParse({}).success).toBe(false);
    expect(TOOL_SCHEMAS.get_state.safeParse({}).success).toBe(true);
  });

  it('never lets the model name a parameter outside the Advanced controls', () => {
    // The whitelist IS the ranges table; a param without a range cannot be set.
    const allowed = TOOL_SCHEMAS.set_param.shape.name.options;
    expect([...allowed].sort()).toEqual(Object.keys(PARAM_RANGES).sort());
    expect(allowed).not.toContain('regions');
    expect(allowed).not.toContain('shape');
  });
});

describe('clamping a requested value into a control', () => {
  it('keeps a sane value and snaps it to the step', () => {
    expect(clampParam('offsetMm', 3.17)).toBe(3.15);
    expect(clampParam('precisionMm', 0.125)).toBe(0.13);
    expect(clampParam('smoothness', 1.4)).toBe(1);
  });

  it('refuses to go outside the slider, either way', () => {
    expect(clampParam('offsetMm', 99)).toBe(20);
    expect(clampParam('offsetMm', -9)).toBe(-2);
    expect(clampParam('alphaThreshold', 0)).toBe(1);
    expect(clampParam('dpi', 10)).toBe(72);
  });

  it('does not leave floating-point dust behind', () => {
    // 0.05 steps are where 3.1500000000000004 comes from.
    expect(String(clampParam('offsetMm', 3.15))).toBe('3.15');
    expect(String(clampParam('denoisePx', 0.7))).toBe('0.7');
  });
});

describe('what the model is told about the studio', () => {
  it('states the facts it has to act on', () => {
    const text = describeSnapshot(snapshot);
    expect(text).toContain('"logo", 3166×940 px, transparent');
    expect(text).toContain('Cut style: sticker');
    expect(text).toContain('6 paths, 444 nodes');
    expect(text).toContain('signed in, 5 credits');
    expect(text).toContain('Note shown to the user: Tracing the alpha channel.');
  });

  it('says plainly when there is no image, because nothing can be cut', () => {
    const text = describeSnapshot({ ...snapshot, image: null, cut: null });
    expect(text).toContain('Image: none open yet');
    expect(text).not.toContain('Cut:');
  });

  it('flags an over-dense cut with what to do about it', () => {
    const text = describeSnapshot({ ...snapshot, cut: { ...snapshot.cut!, overDense: true } });
    expect(text).toContain('over-dense');
    expect(text).toContain('precision');
  });

  it('validates a snapshot as the server will', () => {
    expect(SnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(SnapshotSchema.safeParse({ ...snapshot, mode: 'expert' }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...snapshot, notes: Array(20).fill('x') }).success).toBe(false);
  });
});

describe('how a tool call is shown to the user', () => {
  it('names the change in the words the controls use', () => {
    expect(describeToolCall('set_cut_style', { style: 'tight' })).toBe('Cut style → Tight');
    expect(describeToolCall('set_interior_holes', { enabled: true })).toBe('Interior holes → cut');
    expect(describeToolCall('set_param', { name: 'offsetMm', value: 2.5 })).toBe('Offset → 2.5 mm');
    expect(describeToolCall('set_option', { name: 'smartEdges', enabled: false })).toBe('Smart edges → off');
    expect(describeToolCall('remove_background', { mode: 'inside_too' })).toBe('Remove background, inside too');
    expect(describeToolCall('open_export', { format: 'DXF' })).toBe('Open export · DXF');
  });
});
