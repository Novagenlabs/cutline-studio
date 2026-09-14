import { describe, expect, it } from 'vitest';
import { safeFilenameBase } from '../src/paid-export';

/**
 * The filename that reaches the paid export route.
 *
 * The server validates it against /^[\w. -]+$/ so it cannot break a
 * Content-Disposition header. That rule is right, but nothing was sanitising
 * the name before it got there — and the name comes from whatever file the
 * user opened. "logo (1).png" produced a flat "Malformed export request." at
 * the moment the user had already decided to pay, with nothing on screen
 * saying which field was wrong.
 *
 * Every case here is a filename a real person would plausibly have.
 */

/** The exact rule the server applies. */
const SERVER = /^[\w. -]+$/;

describe('filenames the server will accept', () => {
  const cases = [
    'logo (1)',
    'Müller',
    'design#2',
    'my logo@2x',
    'café menu',
    'sticker/final',
    'a "quoted" name',
    "someone's design",
    '日本語',
    'emoji 🎨 art',
    'trailing   ',
    '...dots...',
    'back\\slash',
    'semi;colon',
  ];

  for (const name of cases) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      const out = safeFilenameBase(name);
      expect(out).toMatch(SERVER);
      expect(out.endsWith('-cut')).toBe(true);
    });
  }
});

describe('and it still produces a useful name', () => {
  it('leaves an already-clean name alone', () => {
    expect(safeFilenameBase('my-logo')).toBe('my-logo-cut');
  });

  it('keeps accented letters readable rather than dashing them out', () => {
    // "M-ller-cut" would be a worse name than "Muller-cut".
    expect(safeFilenameBase('Müller')).toBe('Muller-cut');
  });

  it('collapses a run of rejected characters to one dash', () => {
    // Not "logo---1--cut".
    expect(safeFilenameBase('logo (1)')).toBe('logo-1-cut');
  });

  it('falls back when nothing survives', () => {
    expect(safeFilenameBase('日本語')).toBe('cutline-cut');
    expect(safeFilenameBase('')).toBe('cutline-cut');
    expect(safeFilenameBase('🎨')).toBe('cutline-cut');
  });

  it('stays within the server length limit', () => {
    const out = safeFilenameBase('x'.repeat(500));
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toMatch(SERVER);
  });

  it('does not leave a leading or trailing dash', () => {
    expect(safeFilenameBase('(logo)')).toBe('logo-cut');
    expect(safeFilenameBase('   spaced   ')).toBe('spaced-cut');
  });
});
