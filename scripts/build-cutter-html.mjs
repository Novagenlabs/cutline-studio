// Generate public/cutline/index.html from the source index.html.
//
// index.html is the editable source; the copy under public/ is a build
// artifact. Doing this in the build rather than as a one-off copy is what
// stops the two drifting — an edit to the source that never reached the
// served page would look like the change simply had no effect, which is
// exactly how the stylesheet went missing in the first place.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const src = readFileSync('index.html', 'utf8');

// The source references its TypeScript entry; the served page needs the
// bundle esbuild just produced.
const out = src.replace(
  /<script type="module" src="[^"]*main\.ts"><\/script>/,
  '<script type="module" src="/cutline/app.js"></script>'
);

if (!out.includes('/cutline/app.js')) {
  console.error('build-cutter-html: could not find the module script tag in index.html');
  process.exit(1);
}
if (!out.includes('/cutline/app.css')) {
  console.error('build-cutter-html: index.html does not link /cutline/app.css');
  process.exit(1);
}

mkdirSync('public/cutline', { recursive: true });
writeFileSync('public/cutline/index.html', out);
console.log('public/cutline/index.html generated');
