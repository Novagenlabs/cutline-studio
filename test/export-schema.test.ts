// What a rejected export tells whoever has to fix it.
//
// The endpoint answered every schema failure with a bare "Malformed export
// request." The one fact that identifies the bug — which field was wrong —
// was computed by zod and then discarded, so a real report ("400, rejected by
// the server schema") could not be acted on by anyone, including the person
// who wrote the schema.
//
// A 400 here is always a client bug: the browser builds this body itself.
// So the detail is safe to return and is the difference between a
// reproducible report and a shrug.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { requestExport } from '../src/paid-export';

// The schema as the route defines it. Kept in step by the shape tests below:
// if the route's rules change, these expectations change with them.
const Pt = z.object({ x: z.number().finite(), y: z.number().finite() });

const Body = z.object({
  format: z.enum(['SVG', 'PDF', 'DXF', 'PNG']),
  rings: z.array(z.array(Pt).min(3)).min(1).max(20_000),
  beziers: z.array(z.array(z.tuple([Pt, Pt, Pt, Pt]))).min(1).max(20_000),
  svgPath: z.string().min(1).max(20_000_000),
  cutBbox: z.object({
    x: z.number().finite(), y: z.number().finite(),
    w: z.number().positive(), h: z.number().positive(),
  }),
  srcW: z.number().int().positive().max(30_000),
  srcH: z.number().int().positive().max(30_000),
  dpi: z.number().int().min(72).max(2400),
  spotName: z.string().min(1).max(64).regex(/^[\w -]+$/),
  halo: z.boolean(),
  filenameBase: z.string().min(1).max(120).regex(/^[\w. -]+$/),
  filenameDisplay: z.string().min(1).max(200).optional(),
  imageDataUrl: z.string().startsWith('data:image/').max(48_000_000).optional(),
});

/** The route's reporting shape: path plus message, never values. */
function report(body: unknown) {
  const parsed = Body.safeParse(body);
  if (parsed.success) return null;
  return parsed.error.issues.slice(0, 8).map((i) => ({
    field: i.path.join('.') || '(root)',
    problem: i.message,
  }));
}

const P = (x: number, y: number) => ({ x, y });
const valid = {
  format: 'SVG' as const,
  rings: [[P(0, 0), P(10, 0), P(10, 10)]],
  beziers: [[[P(0, 0), P(1, 0), P(2, 0), P(3, 0)]]],
  svgPath: 'M0 0 L10 0 Z',
  cutBbox: { x: 0, y: 0, w: 10, h: 10 },
  srcW: 100,
  srcH: 100,
  dpi: 300,
  spotName: 'CutContour',
  halo: false,
  filenameBase: 'logo-cut',
  filenameDisplay: 'logo-cut',
};

describe('what a rejected export reports', () => {
  it('accepts an ordinary body', () => {
    expect(report(valid)).toBeNull();
  });

  it('names the field rather than saying only "malformed"', () => {
    const r = report({ ...valid, dpi: 0 });
    expect(r).not.toBeNull();
    expect(r![0].field).toBe('dpi');
    expect(r![0].problem).toBeTruthy();
  });

  it('names a nested field by its full path', () => {
    // "cutBbox" alone would not say which side was degenerate.
    const r = report({ ...valid, cutBbox: { x: 0, y: 0, w: 0, h: 10 } });
    expect(r![0].field).toBe('cutBbox.w');
  });

  it('names an indexed field by its position', () => {
    // Which ring, out of possibly thousands.
    const r = report({ ...valid, rings: [[P(0, 0), P(1, 1)]] });
    expect(r![0].field).toBe('rings.0');
  });

  it('reports several bad fields at once', () => {
    // An empty spotName trips two rules at once (min length and the pattern),
    // so the same field appears more than once — de-duplicated here rather
    // than in the route, since seeing both reasons is useful when debugging.
    const r = report({ ...valid, dpi: 0, spotName: '' });
    expect(r!.length).toBeGreaterThan(1);
    expect([...new Set(r!.map((f) => f.field))].sort()).toEqual(['dpi', 'spotName']);
  });

  it('never echoes the value it rejected', () => {
    // The body carries the artwork and the user's filename. A rejected field
    // must not put either into a log or a response.
    const secret = 'data:image/png;base64,SECRETPIXELS';
    const r = report({ ...valid, imageDataUrl: 123, filenameBase: secret });
    const text = JSON.stringify(r);
    expect(text).not.toContain('SECRETPIXELS');
    expect(text).not.toContain(secret);
  });

  it('caps how much it reports', () => {
    // A body that is wrong in every field should not produce an unbounded
    // response, or an unbounded log line.
    const r = report({});
    expect(r!.length).toBeLessThanOrEqual(8);
  });

  it('survives a body that is not an object at all', () => {
    expect(report(null)).not.toBeNull();
    expect(report('nonsense')).not.toBeNull();
  });
});

describe('shapes a real export can legitimately produce', () => {
  it('rejects an empty beziers array', () => {
    // Worth knowing: a cut with no fitted curves is refused outright, so if
    // the tracer can ever emit one, this is where an export dies.
    const r = report({ ...valid, beziers: [] });
    expect(r![0].field).toBe('beziers');
  });

  it('allows a ring whose bezier list is empty', () => {
    expect(report({ ...valid, beziers: [[]] })).toBeNull();
  });

  it('allows a filename with spaces and dots', () => {
    expect(report({ ...valid, filenameBase: 'my logo v1.2-cut' })).toBeNull();
  });

  it('rejects parentheses, which is why the client sanitises', () => {
    const r = report({ ...valid, filenameBase: 'logo (1)-cut' });
    expect(r![0].field).toBe('filenameBase');
  });
});

describe('an empty cut never reaches the server', () => {
  it('is refused before the request, with a reason', async () => {
    // The tracer skips rings that fit no curves, so an empty result is a
    // state the app can genuinely reach. It used to be sent anyway and come
    // back as a bare 400 — after a round trip that may have carried the whole
    // artwork. Refused here instead, with a sentence naming the cause.
    let called = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      const ctx = {
        result: { rings: [], beziers: [], svgPath: '', bbox: { x: 0, y: 0, w: 0, h: 0 }, nodeCount: 0 },
        srcW: 100,
        srcH: 100,
        dpi: 300,
        spotName: 'CutContour',
        halo: false,
        fileBase: 'logo',
        imageDataUrl: 'data:image/png;base64,AAAA',
      } as unknown as Parameters<typeof requestExport>[1];

      await expect(requestExport('SVG', ctx)).rejects.toThrow(/no cut to export/i);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
