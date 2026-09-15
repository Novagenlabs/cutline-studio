// What the user is told while the AI model downloads.
//
// The worker already computed a real percentage from Content-Length against
// bytes read, and the main thread threw it away into console.info. So the
// first background removal sat behind a motionless "Removing the background"
// for as long as a 40MB fetch takes, which reads as a hang.
//
// humaneProgress decides what reaches the screen. Two rules pull against each
// other: the download figure must get through, and the backend name must not
// — the raw messages say "webgpu" and "wasm", which is implementation detail
// the user did not ask for.
import { describe, it, expect } from 'vitest';
import { humaneProgress } from '../src/ui/loading';

const BASE = 'Removing the background';

describe('what the user is told while the model loads', () => {
  it('shows the download percentage', () => {
    const out = humaneProgress('Downloading AI model (one-time)… 47%', BASE);
    expect(out).toContain('47%');
  });

  it('says the download happens only once', () => {
    // Otherwise the obvious worry is that every removal costs this wait.
    const out = humaneProgress('Downloading AI model (one-time)… 47%', BASE);
    expect(out?.toLowerCase()).toContain('one time');
  });

  it('falls back to megabytes when there is no percentage', () => {
    // A gzipped or proxied response has no Content-Length, so the worker
    // counts bytes instead. A rising number still answers "is this moving".
    const out = humaneProgress('Downloading AI model (one-time)… 12.4 MB', BASE);
    expect(out).toContain('12.4 MB');
  });

  it('still says something when the download reports neither', () => {
    const out = humaneProgress('Downloading AI model (one-time)…', BASE);
    expect(out).toBeTruthy();
    expect(out?.toLowerCase()).toContain('download');
  });

  it('never leaks the execution backend', () => {
    // The user asked for the model name not to be exposed; the same applies
    // to webgpu/wasm, which means nothing to them and worries the rest.
    const raw = [
      'Downloading AI model (one-time)… 47%',
      'Preparing AI model (webgpu)…',
      'Running neural matting (wasm)…',
      'GPU backend unavailable — retrying on CPU (can take a few minutes)…',
    ];
    for (const m of raw) {
      const out = humaneProgress(m, BASE);
      if (out === null) continue;
      expect(out.toLowerCase()).not.toContain('webgpu');
      expect(out.toLowerCase()).not.toContain('wasm');
      expect(out.toLowerCase()).not.toContain('birefnet');
    }
  });

  it('explains the slow path rather than just going quiet', () => {
    const out = humaneProgress(
      'GPU backend unavailable — retrying on CPU (can take a few minutes)…',
      BASE,
    );
    expect(out).toContain(BASE);
    expect(out?.toLowerCase()).toContain('slower');
  });

  it('returns to the plain caption once inference starts', () => {
    // The download is the only stage worth naming; the rest would flicker
    // past too fast to read.
    expect(humaneProgress('Running neural matting (webgpu)…', BASE)).toBe(BASE);
  });

  it('leaves the caption alone for anything it does not recognise', () => {
    expect(humaneProgress('some future stage nobody has written yet', BASE)).toBeNull();
  });
});
