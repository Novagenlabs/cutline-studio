import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // tsconfig `paths` only teaches the typechecker; the runtime needs the
      // same mapping or the shared-pipeline imports fail to resolve. Next
      // reads tsconfig paths itself, so this exists for vitest specifically —
      // both must point at the same place.
      '@cutline/pipeline': fileURLToPath(new URL('../src', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // The ledger tests talk to a real (remote) Postgres and several of them
    // run 4-8 concurrent Serializable transactions on purpose. Against a
    // hosted database each round trip is tens to hundreds of ms, so the 5s
    // default expires mid-transaction and reports a timeout that reads
    // exactly like a deadlock — which sent this investigation down the wrong
    // path once already. The work is genuinely slow, not stuck.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One file at a time: every test truncates the shared tables in its
    // beforeEach, so parallel files would delete each other's fixtures.
    fileParallelism: false,
  },
});
