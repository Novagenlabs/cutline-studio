/// <reference types="vite/client" />
/* ort 1.21 declares its subpath modules (onnxruntime-web/webgpu) here, but
 * the package's exports map doesn't expose the file to bundler resolution. */
/// <reference path="../node_modules/onnxruntime-web/types.d.ts" />
