/**
 * Web Worker running BiRefNet inference via onnxruntime-web. Kept off the
 * main thread so long wasm runs don't freeze the UI and a backend crash
 * surfaces as a clean error instead of wedging the page.
 *
 * Protocol: receives {rgba, width, height, device, parts}; posts
 * {type:'progress', msg} during setup and {type:'done', matte, mw, mh}
 * (transfer) or {type:'error', message} at the end.
 */
import * as ort from 'onnxruntime-web/webgpu';

const MODEL_SIZE = 512;

// Threads need cross-origin isolation (COOP/COEP headers); without it ort
// silently runs single-threaded, which is unusably slow for this model.
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(8, navigator.hardwareConcurrency || 4)
  : 1;

// In production the bundler only emits ort's .wasm, not the .mjs loader it
// fetches at runtime (the name is built dynamically, so Rollup can't trace
// it) — serve both from public/ort/ (same pinned version). Dev resolves them
// from node_modules natively.
if (import.meta.env.PROD) {
  ort.env.wasm.wasmPaths = '/ort/';
}

let modelBytes: Uint8Array | null = null;
const sessions = new Map<string, ort.InferenceSession>();

const progress = (msg: string) => (self as unknown as Worker).postMessage({ type: 'progress', msg });

async function fetchModel(parts: string[]): Promise<Uint8Array> {
  if (modelBytes) return modelBytes;
  const heads = await Promise.all(parts.map((u) => fetch(u)));
  for (const r of heads) {
    if (!r.ok) throw new Error(`model download failed: HTTP ${r.status} for ${r.url}`);
  }
  const total = heads.reduce((a, r) => a + Number(r.headers.get('Content-Length') ?? 0), 0);
  let loaded = 0;
  const chunks: Uint8Array[][] = parts.map(() => []);
  await Promise.all(
    heads.map(async (res, i) => {
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks[i].push(value);
        loaded += value.byteLength;
        if (total > 0) {
          progress(`Downloading AI model (one-time)… ${Math.round((loaded / total) * 100)}%`);
        }
      }
    })
  );
  const flat = chunks.flat();
  const bytes = new Uint8Array(flat.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of flat) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  modelBytes = bytes;
  return bytes;
}

async function getSession(device: 'webgpu' | 'wasm', parts: string[]): Promise<ort.InferenceSession> {
  const cached = sessions.get(device);
  if (cached) return cached;
  const bytes = await fetchModel(parts);
  progress(`Preparing AI model (${device})…`);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [device],
    // wasm-only: skip arena/mem-pattern preallocation so the CPU path stays
    // inside the 4GB wasm32 heap. The webgpu path benefits from arena reuse.
    ...(device === 'wasm' ? { enableCpuMemArena: false, enableMemPattern: false } : {}),
  });
  sessions.set(device, session);
  return session;
}

/** Bilinear resample of a single-channel field. */
function resizeBilinear(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1.001, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const i00 = y0 * sw + x0;
      const a = src[i00] * (1 - tx) + src[i00 + 1] * tx;
      const b = src[i00 + sw] * (1 - tx) + src[i00 + sw + 1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** BiRefNet preprocessing (square resize + ImageNet normalization) to CHW. */
function preprocess(rgba: Uint8ClampedArray, w: number, h: number, size: number): Float32Array {
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const chans = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    const a = rgba[i + 3] / 255;
    chans[0][p] = rgba[i] * a + 255 * (1 - a);
    chans[1][p] = rgba[i + 1] * a + 255 * (1 - a);
    chans[2][p] = rgba[i + 2] * a + 255 * (1 - a);
  }
  const out = new Float32Array(3 * size * size);
  for (let c = 0; c < 3; c++) {
    const resized = resizeBilinear(chans[c], w, h, size, size);
    const off = c * size * size;
    for (let i = 0; i < resized.length; i++) {
      out[off + i] = (resized[i] / 255 - mean[c]) / std[c];
    }
  }
  return out;
}

interface MatteRequest {
  rgba: ArrayBuffer;
  width: number;
  height: number;
  device: 'webgpu' | 'wasm';
  parts: string[];
}

self.onmessage = async (ev: MessageEvent<MatteRequest>) => {
  const { rgba, width, height, device, parts } = ev.data;
  try {
    const session = await getSession(device, parts);
    progress(`Running neural matting (${device})…`);
    const chw = preprocess(new Uint8ClampedArray(rgba), width, height, MODEL_SIZE);
    const input = new ort.Tensor('float32', chw, [1, 3, MODEL_SIZE, MODEL_SIZE]);
    const outputs = await session.run({ [session.inputNames[0]]: input });
    const outName = session.outputNames[session.outputNames.length - 1];
    const tensor = outputs[outName] ?? Object.values(outputs)[0];
    if (!tensor?.dims) throw new Error('AI model returned no output tensor');
    const dims = tensor.dims;
    const mh = dims[dims.length - 2];
    const mw = dims[dims.length - 1];
    const flat = Float32Array.from(tensor.data as unknown as ArrayLike<number>);
    const matte = flat.slice(flat.length - mw * mh);
    (self as unknown as Worker).postMessage({ type: 'done', matte, mw, mh }, [matte.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
