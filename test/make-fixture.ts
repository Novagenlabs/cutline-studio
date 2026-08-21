// Renders test artwork PNGs (transparent background) for manual/browser testing.
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SCRIPT = `((args) => {
  const text = args.text, fontPx = args.fontPx, pad = args.pad;
  const c = document.createElement('canvas');
  const m = c.getContext('2d');
  m.font = 'bold ' + fontPx + 'px Helvetica, Arial, sans-serif';
  const w = Math.ceil(m.measureText(text).width) + pad * 2;
  const h = Math.ceil(fontPx * 1.6) + pad * 2;
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.font = 'bold ' + fontPx + 'px Helvetica, Arial, sans-serif';
  g.fillStyle = '#111'; g.textBaseline = 'middle';
  g.fillText(text, pad, h / 2);
  return c.toDataURL('image/png');
})`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const fixtures: [string, string, number][] = [
    ['hello-small', 'Hello', 60],
    ['hello-large', 'Hello', 240],
    ['sale-script', 'Summer Sale', 90],
  ];
  for (const [name, text, fontPx] of fixtures) {
    const url = (await page.evaluate(
      SCRIPT + '(' + JSON.stringify({ text, fontPx, pad: 40 }) + ')'
    )) as string;
    const b64 = url.split(',')[1];
    const path = `test/fixtures/${name}.png`;
    writeFileSync(path, Buffer.from(b64, 'base64'));
    console.log(`wrote ${path}  ("${text}" @ ${fontPx}px)`);
  }
  await browser.close();
})();
