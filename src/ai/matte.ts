/**
 * Neural matting via BiRefNet-lite (MIT) running fully in the browser on
 * onnxruntime-web — WebGPU with wasm (CPU) fallback, hosted in a dedicated
 * Web Worker so heavy runs never block the UI and a crashed backend can be
 * torn down and replaced cleanly. The model returns a continuous 0..1 alpha
 * matte; we upsample it to the working resolution and splice it in as the
 * image's alpha channel, so the whole existing pipeline (threshold, denoise,
 * hug-body, regions, subpixel field trace) operates on the neural edge
 * unchanged.
 *
 * Model: studioludens/birefnet-lite-512 fp16 (MIT), self-hosted in
 * public/models/ — see scripts/fetch-model.py for provenance. The 512x512
 * export is deliberate: the common 1024x1024 BiRefNet-lite export cannot run
 * in a browser at all — its shaders exceed Metal's 10-storage-buffer WebGPU
 * limit on every Mac, and its ~4.4GB inference peak overflows the 4GB wasm32
 * heap on the CPU path. The 512 export has narrow ops (<=7 bindings) and a
 * ~2.5GB peak, so both backends work; the matte is upsampled and traced at
 * subpixel precision anyway.
 *
 * The ~98MB download happens once per browser (HTTP-cached), only when the
 * user enables the feature.
 */
import type { RasterImage } from '../pipeline/types';

const MODEL_PARTS = ['/models/birefnet-lite-512-fp16.onnx'];
/** A backend that produces nothing for this long is considered dead. */
const WORKER_TIMEOUT_MS = 900_000;

export type AiProgress = (msg: string) => void;

const workers = new Map<string, Worker>();

function getWorker(device: 'webgpu' | 'wasm'): Worker {
  let w = workers.get(device);
  if (!w) {
    w = new Worker(new URL('./matte.worker.ts', import.meta.url), { type: 'module' });
    workers.set(device, w);
  }
  return w;
}

function killWorker(device: 'webgpu' | 'wasm') {
  workers.get(device)?.terminate();
  workers.delete(device);
}

interface WorkerReply {
  type: 'progress' | 'done' | 'error';
  msg?: string;
  message?: string;
  matte?: Float32Array;
  mw?: number;
  mh?: number;
}

function runInWorker(
  img: RasterImage,
  device: 'webgpu' | 'wasm',
  onProgress: AiProgress
): Promise<{ matte: Float32Array; mw: number; mh: number }> {
  const worker = getWorker(device);
  // Copy: the engine still needs the original pixels on the main thread.
  const rgba = img.data.slice().buffer;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killWorker(device); // a failed backend may be wedged — replace it
      reject(new Error(message));
    };
    let timer = window.setTimeout(() => fail(`${device} backend timed out`), WORKER_TIMEOUT_MS);
    worker.onerror = (e) => fail(e.message || `${device} worker crashed`);
    worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
      const d = ev.data;
      if (d.type === 'progress') {
        onProgress(d.msg ?? '');
        clearTimeout(timer);
        timer = window.setTimeout(() => fail(`${device} backend timed out`), WORKER_TIMEOUT_MS);
      } else if (d.type === 'done') {
        settled = true;
        clearTimeout(timer);
        resolve({ matte: d.matte!, mw: d.mw!, mh: d.mh! });
      } else {
        fail(d.message ?? 'AI matting failed');
      }
    };
    worker.postMessage({ rgba, width: img.width, height: img.height, device, parts: MODEL_PARTS }, [rgba]);
  });
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

async function runMatting(
  img: RasterImage,
  device: 'webgpu' | 'wasm',
  onProgress: AiProgress
): Promise<Float32Array> {
  const { matte: raw, mw, mh } = await runInWorker(img, device, onProgress);
  // The export may or may not bake in the final sigmoid — detect logits.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < lo) lo = raw[i];
    if (raw[i] > hi) hi = raw[i];
  }
  if (lo < -0.01 || hi > 1.01) {
    for (let i = 0; i < raw.length; i++) raw[i] = 1 / (1 + Math.exp(-raw[i]));
  }
  const matte = resizeBilinear(raw, mw, mh, img.width, img.height);
  for (let i = 0; i < matte.length; i++) matte[i] *= 255;
  return matte;
}

/**
 * Run BiRefNet on the image and return a 0..255 matte at the image's own
 * resolution. Tries WebGPU first, falls back to CPU (wasm).
 */
export async function computeAiMatte(img: RasterImage, onProgress: AiProgress): Promise<Float32Array> {
  // ?ai=wasm forces the CPU backend (debug / GPUs with broken shaders).
  const forced =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('ai');
  const webgpu = forced !== 'wasm' && typeof navigator !== 'undefined' && 'gpu' in navigator;
  try {
    return await runMatting(img, webgpu ? 'webgpu' : 'wasm', onProgress);
  } catch (err) {
    if (!webgpu) throw err;
    console.warn('WebGPU matting failed, falling back to wasm:', err);
    onProgress('GPU backend unavailable — retrying on CPU (can take a few minutes)…');
    return runMatting(img, 'wasm', onProgress);
  }
}

/** Splice a matte in as the alpha channel; RGB stays untouched. */
export function matteToImage(img: RasterImage, matte: Float32Array): RasterImage {
  const out = new Uint8ClampedArray(img.data.length);
  out.set(img.data);
  for (let i = 0; i < matte.length; i++) out[i * 4 + 3] = matte[i];
  return { data: out, width: img.width, height: img.height };
}
