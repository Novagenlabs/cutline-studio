import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The ledger tests talk to a real (remote) Postgres and several of them
    // run concurrent Serializable transactions on purpose. Against a hosted
    // database each round trip is tens to hundreds of ms, so the 5s default
    // expires mid-transaction and reports a timeout that reads exactly like a
    // deadlock. The work is genuinely slow, not stuck.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One file at a time: tests truncate shared tables in beforeEach, so
    // parallel files would delete each other's fixtures.
    fileParallelism: false,
    // Only the server-side suites run under vitest; the cutter's own checks
    // are plain tsx scripts (npm run smoke / verify:*).
    include: ['test/{credits,hash,render,raster-framing,e2e-export,signup-grant,same-origin,render-timing}.test.ts'],
  },
});
