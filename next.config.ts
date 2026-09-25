import type { NextConfig } from 'next';

/**
 * Cross-origin isolation, scoped.
 *
 * The AI matting worker uses SharedArrayBuffer for wasm threading, which the
 * browser only grants to a cross-origin-isolated page (see matte.worker.ts,
 * which reads `crossOriginIsolated` to pick a thread count). That needs
 * COOP: same-origin.
 *
 * But COOP: same-origin also severs a popup's link to its opener, which is
 * how an OAuth popup hands its result back. So isolation is applied to the
 * cutter and its assets only, and deliberately NOT to /api/auth/* — sign-in
 * uses a full-page redirect there, which COOP does not affect, and the
 * cutter keeps multithreaded matting at full speed.
 */
const isolation = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // credentialless rather than require-corp so Google Fonts still load.
  { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
];

const config: NextConfig = {
  // @napi-rs/canvas ships a native .node binary, which cannot be inlined into
  // a JS bundle. Leaving it external makes Node require it at runtime instead
  // of the bundler trying to place it in an ESM chunk.
  serverExternalPackages: ['@napi-rs/canvas'],
  async headers() {
    return [
      { source: '/cutline/:path*', headers: isolation },
      { source: '/models/:path*', headers: isolation },
      { source: '/ort/:path*', headers: isolation },
      { source: '/', headers: isolation },
      // The previous studio, frozen at the commit before the UI overhaul and
      // served beside the current one. Same isolation as the root, so a
      // popup sign-in behaves identically there (see /signin-done below).
      { source: '/v1', headers: isolation },
      { source: '/v1/:path*', headers: isolation },
      // The sign-in popup must land in the SAME browsing-context group as the
      // studio that opened it, or COOP: same-origin severs window.opener and
      // the popup cannot report back. Without this the opener only learns
      // anything by polling for the window to close — which never happens
      // when the browser refuses to close it.
      { source: '/signin-done', headers: isolation },
    ];
  },
  async rewrites() {
    return [
      // The cutter is the product; it lives at the root.
      { source: '/', destination: '/cutline/index.html' },
      // The frozen previous version. public/v1/ is a committed build output
      // (scripts/build-v1.sh), not something `npm run build` produces — the
      // container has no checkout of the old commit to build it from.
      { source: '/v1', destination: '/v1/index.html' },
      // A static directory under public/ is not served at its bare path, so
      // the motion lab needs the same treatment to answer on /motion-lab.
      // Dev-only by intent, but harmless in production: it ships no secrets
      // and the panel it loads is a devDependency that is never bundled into
      // the cutter itself.
      { source: '/motion-lab', destination: '/motion-lab/index.html' },
    ];
  },
};

export default config;
