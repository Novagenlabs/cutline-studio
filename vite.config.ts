import { defineConfig } from 'vite';

// COOP/COEP make the page cross-origin-isolated so ort's wasm backend can use
// SharedArrayBuffer multithreading (credentialless keeps Google Fonts alive).
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
  // Don't pre-bundle onnxruntime-web: its runtime locates the .wasm next to
  // its own module URL, which breaks when esbuild relocates it to .vite/deps.
  optimizeDeps: {
    exclude: ['onnxruntime-web', 'onnxruntime-web/webgpu'],
  },
});
