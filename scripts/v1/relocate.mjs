// Turn the old studio's built index.html into the page served at /v1.
//
// Two edits. The page's only absolute references are its own two assets,
// which move from /cutline/ to /v1/. And it gains one control the old version
// never had — a way back to the current studio — placed among v1's own
// top-bar actions so it uses v1's own button styles rather than new CSS.
//
// Usage: node scripts/v1/relocate.mjs <built index.html> <public/v1/index.html>
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: relocate.mjs <src index.html> <dst index.html>');
  process.exit(2);
}

let html = readFileSync(src, 'utf8');

const before = html;
html = html.split('/cutline/').join('/v1/');
if (html === before) {
  console.error('relocate: no /cutline/ paths found to move to /v1/');
  process.exit(1);
}

const anchor = '<button id="btn-sample"';
if (!html.includes(anchor)) {
  console.error('relocate: top-bar anchor <button id="btn-sample"> not found');
  process.exit(1);
}
html = html.replace(
  anchor,
  // Inline, because v1's stylesheet is frozen and its .btn rule was only
  // ever applied to <button>s — on an <a> it leaves the underline.
  '<a id="btn-current-version" class="btn ghost" href="/" style="text-decoration:none" ' +
    'title="You are using the previous version of Cutline Studio">' +
    'Switch to current version</a>\n          ' +
    anchor,
);

// Name it in the tab, so two open studios can be told apart.
html = html.replace('<title>', '<title>v1 · ');

writeFileSync(dst, html);
console.log(`relocate: wrote ${dst}`);
