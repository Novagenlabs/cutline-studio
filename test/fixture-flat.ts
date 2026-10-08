// A fixture flattened onto white, for verifiers that need a background to
// remove.
//
// Every fixture in test/fixtures is a transparent PNG, and background
// removal on a transparent PNG is now — correctly — a no-op: there is no
// background in it to find. Verifiers that exercise the removal flow
// (refine, retrace, the background menu, the refine cursor) therefore run
// on a copy composited over white, which is the input that flow exists for.
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export async function flatFixture(src: string): Promise<string> {
  const out = join(tmpdir(), `${basename(src, '.png')}-on-white.png`);
  if (existsSync(out)) return out;
  const img = await loadImage(src);
  const c = createCanvas(img.width, img.height);
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, img.width, img.height);
  x.drawImage(img, 0, 0);
  writeFileSync(out, c.toBuffer('image/png'));
  return out;
}
