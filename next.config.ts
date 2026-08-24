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
      // The sign-in popup must land in the SAME browsing-context group as the
      // studio that opened it, or COOP: same-origin severs window.opener and
      // the popup cannot report back. Without this the opener only learns
      // anything by polling for the window to close — which never happens
      // when the browser refuses to close it.
      { source: '/signin-done', headers: isolation },
    ];
  },
  async rewrites() {
    // The cutter is the product; it lives at the root.
    return [{ source: '/', destination: '/cutline/index.html' }];
  },
};

export default config;
