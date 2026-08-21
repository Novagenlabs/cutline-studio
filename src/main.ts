import { CutlineEngine, DEFAULT_PARAMS } from './pipeline';
import type { CutlineParams, CutlineResult, RasterImage, RegionOverride, ShapeMode } from './pipeline';
import { computeAiMatte, matteToImage } from './ai/matte';
import { buildSvg } from './export/svg';
import { buildPdf } from './export/pdf';
import { buildDxf } from './export/dxf';
import { buildRaster } from './export/png';
import { makeSampleImage } from './ui/sample';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// Cap the pipeline's working resolution by area, not edge length — tight
// per-character cuts need all the resolution the source has, and the EDT
// stages are O(n), so ~7MP stays interactive.
const WORK_MAX_PIXELS = 7_000_000;

interface AppState {
  params: CutlineParams;
  halo: boolean;
  spotName: string;
  fileBase: string;
  srcW: number;
  srcH: number;
  imageEl: HTMLImageElement | HTMLCanvasElement | null;
  imageDataUrl: string;
  engine: CutlineEngine | null;
  result: CutlineResult | null;
  /** -1 = editing global params; otherwise index into params.regions. */
  activeRegion: number;
  compareV1: boolean;
  /** Downscaled working image (kept for building the AI-matted variant). */
  workImg: RasterImage | null;
  workScale: number;
  aiEngine: CutlineEngine | null;
  useAi: boolean;
}

const state: AppState = {
  params: { ...DEFAULT_PARAMS, regions: [] },
  halo: true,
  spotName: 'CutContour',
  fileBase: 'cutline',
  srcW: 0,
  srcH: 0,
  imageEl: null,
  imageDataUrl: '',
  engine: null,
  result: null,
  activeRegion: -1,
  compareV1: false,
  workImg: null,
  workScale: 1,
  aiEngine: null,
  useAi: false,
};

const activeRegion = (): RegionOverride | null =>
  state.activeRegion >= 0 ? state.params.regions[state.activeRegion] ?? null : null;

/* ---------------- toast ---------------- */

let toastTimer: number | null = null;
function toast(msg: string, kind: 'error' | 'info' = 'info', ms = 5000) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/* ---------------- image loading ---------------- */

function adoptImage(el: HTMLImageElement | HTMLCanvasElement, w: number, h: number, base: string) {
  state.imageEl = el;
  state.srcW = w;
  state.srcH = h;
  state.fileBase = base;

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = w;
  srcCanvas.height = h;
  srcCanvas.getContext('2d')!.drawImage(el, 0, 0, w, h);
  state.imageDataUrl = srcCanvas.toDataURL('image/png');

  const workScale = Math.min(1, Math.sqrt(WORK_MAX_PIXELS / (w * h)));
  const ww = Math.max(1, Math.round(w * workScale));
  const wh = Math.max(1, Math.round(h * workScale));
  const workCanvas = document.createElement('canvas');
  workCanvas.width = ww;
  workCanvas.height = wh;
  const wctx = workCanvas.getContext('2d')!;
  wctx.drawImage(el, 0, 0, ww, wh);
  const workData = wctx.getImageData(0, 0, ww, wh);

  state.engine = new CutlineEngine(workData, ww / w);
  state.workImg = workData;
  state.workScale = ww / w;
  state.aiEngine = null;
  state.useAi = false;
  const aiCheck = $('#in-ai') as HTMLInputElement;
  aiCheck.checked = false;
  aiCheck.disabled = false;
  state.params.regions = [];
  state.activeRegion = -1;
  renderRegions();
  syncRegionControls();

  const art = $('#art') as unknown as SVGImageElement;
  art.setAttribute('href', state.imageDataUrl);
  art.setAttribute('width', String(w));
  art.setAttribute('height', String(h));
  $('#dropzone').classList.add('hidden');
  $('#st-file').textContent = base;
  for (const id of ['#btn-svg', '#btn-pdf', '#btn-dxf', '#btn-png', '#btn-jpg']) {
    ($(id) as HTMLButtonElement).disabled = false;
  }
  recompute();
  requestAnimationFrame(fitView);
}

function loadFile(file: File) {
  const base = file.name.replace(/\.[^.]+$/, '') || 'cutline';
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    try {
      adoptImage(img, img.naturalWidth, img.naturalHeight, base);
    } catch (err) {
      toast(`Could not process "${file.name}": ${err instanceof Error ? err.message : err}`, 'error');
    }
    URL.revokeObjectURL(url);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    const isHeic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/.test(file.type);
    toast(
      isHeic
        ? `"${file.name}" is HEIC — browsers can't decode it. Export it as PNG or JPG first (Preview: File → Export).`
        : `Could not open "${file.name}" — not a decodable image (PNG, JPG, WebP, GIF work best).`,
      'error',
      8000
    );
  };
  img.src = url;
}

/* ---------------- pipeline ---------------- */

let pending: number | null = null;
function recompute(immediate = false) {
  // AI mode traces the neural matte; v1 comparison always uses the original.
  const engine = state.useAi && state.aiEngine ? state.aiEngine : state.engine;
  if (!engine) return;
  if (pending !== null) clearTimeout(pending);
  pending = window.setTimeout(
    () => {
      pending = null;
      const t0 = performance.now();
      const result = engine.compute(state.params);
      state.result = result;
      renderResult(result, performance.now() - t0);
      const v1El = $('#cut-v1') as unknown as SVGPathElement;
      if (state.compareV1 && state.engine) {
        const v1 = state.engine.computeV1(state.params);
        v1El.setAttribute('d', v1.svgPath);
        $('#st-geom').textContent += ` · v1: ${v1.ringCount} paths, ${v1.nodeCount} nodes`;
      } else {
        v1El.setAttribute('d', '');
      }
    },
    immediate ? 0 : 60
  );
}

function renderResult(r: CutlineResult, ms: number) {
  ($('#cut-path') as unknown as SVGPathElement).setAttribute('d', r.svgPath);
  ($('#cut-shadow') as unknown as SVGPathElement).setAttribute('d', r.svgPath);
  const halo = $('#halo-path') as unknown as SVGPathElement;
  halo.setAttribute('d', state.halo ? r.svgPath : '');

  const mm = (px: number) => ((px / state.params.dpi) * 25.4).toFixed(1);
  $('#st-dims').textContent =
    `${state.srcW}×${state.srcH}px · ${mm(state.srcW)}×${mm(state.srcH)}mm @ ${state.params.dpi}dpi`;
  $('#st-geom').textContent = `${r.rings.length} path${r.rings.length === 1 ? '' : 's'} · ${r.nodeCount} nodes`;
  if (r.rings.length === 0) {
    toast(
      r.usedAlpha
        ? 'No shape traced — every pixel is below the alpha threshold. Try lowering it.'
        : 'No shape traced — the flood fill removed everything. Try raising background tolerance, or the artwork may match the background color.',
      'error',
      7000
    );
  }
  $('#st-time').textContent = `${ms.toFixed(0)} ms`;
  $('#out-size').textContent = `${mm(state.srcW)} × ${mm(state.srcH)} mm`;
  $('#hint-mask').textContent =
    state.useAi && state.aiEngine
      ? 'Tracing the AI matte. The threshold slider moves the cut along the neural edge; regions still work.'
      : r.usedAlpha
        ? 'Tracing the alpha channel. Raise the threshold to hug the solid body, lower it to include soft shadows.'
        : 'No transparency found — background removed by flood fill from the edges. Tune with background tolerance.';
}

/* ---------------- view (zoom / pan) ---------------- */

const view = { k: 1, tx: 0, ty: 0 };
const viewport = $('#viewport') as unknown as SVGGElement;
const previewSvg = $('#preview') as unknown as SVGSVGElement;

function applyView() {
  viewport.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.k})`);
  $('#st-zoom').textContent = `${Math.round(view.k * 100)}%`;
}

function fitView() {
  if (!state.srcW) return;
  const box = previewSvg.getBoundingClientRect();
  const b = state.result?.bbox;
  const minX = Math.min(0, b?.x ?? 0);
  const minY = Math.min(0, b?.y ?? 0);
  const maxX = Math.max(state.srcW, b ? b.x + b.w : 0);
  const maxY = Math.max(state.srcH, b ? b.y + b.h : 0);
  const w = maxX - minX;
  const h = maxY - minY;
  const pad = 48;
  view.k = Math.min((box.width - pad * 2) / w, (box.height - pad * 2) / h);
  view.tx = (box.width - w * view.k) / 2 - minX * view.k;
  view.ty = (box.height - h * view.k) / 2 - minY * view.k;
  applyView();
}

previewSvg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = previewSvg.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const factor = Math.exp(-e.deltaY * 0.0016);
  const k2 = Math.min(40, Math.max(0.05, view.k * factor));
  view.tx = px - ((px - view.tx) * k2) / view.k;
  view.ty = py - ((py - view.ty) * k2) / view.k;
  view.k = k2;
  applyView();
}, { passive: false });

function screenToImg(e: PointerEvent): { x: number; y: number } {
  const rect = previewSvg.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - view.tx) / view.k,
    y: (e.clientY - rect.top - view.ty) / view.k,
  };
}

let panFrom: { x: number; y: number; tx: number; ty: number } | null = null;
let marqueeArmed = false;
let marqueeFrom: { x: number; y: number } | null = null;
const marqueeEl = $('#marquee') as unknown as SVGRectElement;

previewSvg.addEventListener('pointerdown', (e) => {
  previewSvg.setPointerCapture(e.pointerId);
  if (marqueeArmed) {
    marqueeFrom = screenToImg(e);
    return;
  }
  panFrom = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  previewSvg.classList.add('panning');
});
previewSvg.addEventListener('pointermove', (e) => {
  if (marqueeFrom) {
    const p = screenToImg(e);
    marqueeEl.setAttribute('x', String(Math.min(marqueeFrom.x, p.x)));
    marqueeEl.setAttribute('y', String(Math.min(marqueeFrom.y, p.y)));
    marqueeEl.setAttribute('width', String(Math.abs(p.x - marqueeFrom.x)));
    marqueeEl.setAttribute('height', String(Math.abs(p.y - marqueeFrom.y)));
    marqueeEl.removeAttribute('hidden');
    return;
  }
  if (!panFrom) return;
  view.tx = panFrom.tx + (e.clientX - panFrom.x);
  view.ty = panFrom.ty + (e.clientY - panFrom.y);
  applyView();
});
previewSvg.addEventListener('pointerup', (e) => {
  if (marqueeFrom) {
    const p = screenToImg(e);
    const x0 = Math.max(0, Math.min(marqueeFrom.x, p.x));
    const y0 = Math.max(0, Math.min(marqueeFrom.y, p.y));
    const x1 = Math.min(state.srcW, Math.max(marqueeFrom.x, p.x));
    const y1 = Math.min(state.srcH, Math.max(marqueeFrom.y, p.y));
    marqueeFrom = null;
    marqueeEl.setAttribute('hidden', '');
    setMarqueeArmed(false);
    if (x1 - x0 > 8 && y1 - y0 > 8) {
      state.params.regions.push({
        x: Math.round(x0),
        y: Math.round(y0),
        w: Math.round(x1 - x0),
        h: Math.round(y1 - y0),
      });
      state.activeRegion = state.params.regions.length - 1;
      renderRegions();
      syncRegionControls();
      recompute(true);
    }
    return;
  }
  panFrom = null;
  previewSvg.classList.remove('panning');
});

function setMarqueeArmed(on: boolean) {
  marqueeArmed = on;
  previewSvg.classList.toggle('marquee-mode', on);
  $('#btn-region').classList.toggle('armed', on);
  $('#region-hint').textContent = on ? 'drag a box on the art' : '';
}

$('#btn-region').addEventListener('click', () => setMarqueeArmed(!marqueeArmed));

function renderRegions() {
  const chips = $('#region-chips');
  chips.innerHTML = '';
  const mk = (label: string, idx: number) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${state.activeRegion === idx ? ' active' : ''}`;
    b.textContent = label;
    if (idx >= 0) {
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '✕';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.params.regions.splice(idx, 1);
        state.activeRegion = -1;
        renderRegions();
        syncRegionControls();
        recompute(true);
      });
      b.appendChild(x);
    }
    b.addEventListener('click', () => {
      state.activeRegion = idx;
      renderRegions();
      syncRegionControls();
    });
    chips.appendChild(b);
  };
  if (state.params.regions.length) mk('All', -1);
  state.params.regions.forEach((_, i) => mk(`R${i + 1} `, i));

  const g = $('#region-rects');
  g.innerHTML = '';
  state.params.regions.forEach((r, i) => {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', `region-rect${state.activeRegion === i ? ' active' : ''}`);
    rect.setAttribute('x', String(r.x));
    rect.setAttribute('y', String(r.y));
    rect.setAttribute('width', String(r.w));
    rect.setAttribute('height', String(r.h));
    g.appendChild(rect);
  });
}

/** Reflect the active target's (global or region) values in the artwork controls. */
function syncRegionControls() {
  const r = activeRegion();
  const thr = r?.alphaThreshold ?? state.params.alphaThreshold;
  const den = r?.denoisePx ?? state.params.denoisePx;
  const body = r?.hugBody ?? state.params.hugBody;
  ($('#in-alpha') as HTMLInputElement).value = String(thr);
  $('#out-alpha').textContent = String(thr);
  ($('#in-denoise') as HTMLInputElement).value = String(den);
  $('#out-denoise').textContent = `${den.toFixed(1)} px`;
  ($('#in-body') as HTMLInputElement).checked = body;
  $('#region-hint').textContent = r
    ? `R${state.activeRegion + 1}: threshold / denoise / hug-body apply to this region only`
    : '';
}

$('#btn-fit').addEventListener('click', fitView);
window.addEventListener('resize', fitView);

function zoomBy(factor: number) {
  const box = previewSvg.getBoundingClientRect();
  const cx = box.width / 2;
  const cy = box.height / 2;
  const k2 = Math.min(80, Math.max(0.05, view.k * factor));
  view.tx = cx - ((cx - view.tx) * k2) / view.k;
  view.ty = cy - ((cy - view.ty) * k2) / view.k;
  view.k = k2;
  applyView();
}

$('#btn-zoom-in').addEventListener('click', () => zoomBy(1.5));
$('#btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.5));
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === '+' || e.key === '=') zoomBy(1.5);
  else if (e.key === '-') zoomBy(1 / 1.5);
  else if (e.key === '0') fitView();
});

/* ---------------- controls ---------------- */

function bindSlider(
  inputSel: string,
  outputSel: string,
  format: (v: number) => string,
  apply: (v: number) => void
) {
  const input = $(inputSel) as HTMLInputElement;
  const out = $(outputSel) as HTMLOutputElement;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    out.textContent = format(v);
    apply(v);
    recompute();
  });
}

bindSlider('#in-offset', '#out-offset', (v) => `${v.toFixed(1)} mm`, (v) => {
  state.params.offsetMm = v;
});
bindSlider('#in-bridge', '#out-bridge', (v) => (v === 0 ? 'off' : `${v.toFixed(1)} mm`), (v) => {
  state.params.bridgeMm = v;
});
bindSlider('#in-holemin', '#out-holemin', (v) => `${v.toFixed(0)} mm²`, (v) => {
  state.params.holeMinMm2 = v;
});
bindSlider('#in-smooth', '#out-smooth', (v) => String(v), (v) => {
  state.params.smoothness = v;
});
bindSlider('#in-corner', '#out-corner', (v) => `${v.toFixed(1)} mm`, (v) => {
  state.params.minCornerRadiusMm = v;
});
bindSlider('#in-alpha', '#out-alpha', (v) => String(v), (v) => {
  const r = activeRegion();
  if (r) r.alphaThreshold = v;
  else state.params.alphaThreshold = v;
});
bindSlider('#in-bgtol', '#out-bgtol', (v) => String(v), (v) => {
  state.params.bgTolerance = v;
});
bindSlider('#in-denoise', '#out-denoise', (v) => `${v.toFixed(1)} px`, (v) => {
  const r = activeRegion();
  if (r) r.denoisePx = v;
  else state.params.denoisePx = v;
});
bindSlider('#in-precision', '#out-precision', (v) => `±${v.toFixed(2)} mm`, (v) => {
  state.params.precisionMm = v;
});

($('#in-dpi') as HTMLInputElement).addEventListener('change', (e) => {
  const v = parseInt((e.target as HTMLInputElement).value, 10);
  if (v >= 72 && v <= 1200) {
    state.params.dpi = v;
    recompute(true);
  }
});

($('#in-holes') as HTMLInputElement).addEventListener('change', (e) => {
  state.params.keepHoles = (e.target as HTMLInputElement).checked;
  recompute(true);
});

($('#in-body') as HTMLInputElement).addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  const r = activeRegion();
  if (r) r.hugBody = checked;
  else state.params.hugBody = checked;
  recompute(true);
});

const aiCheckbox = $('#in-ai') as HTMLInputElement;
aiCheckbox.addEventListener('change', async () => {
  state.useAi = aiCheckbox.checked;
  if (!state.useAi || state.aiEngine) {
    recompute(true);
    return;
  }
  if (!state.workImg) {
    state.useAi = false;
    aiCheckbox.checked = false;
    toast('Open an image first.', 'error');
    return;
  }
  aiCheckbox.disabled = true;
  const hint = $('#hint-ai');
  try {
    const matte = await computeAiMatte(state.workImg, (msg) => {
      hint.textContent = msg;
      toast(msg, 'info', 60000);
    });
    state.aiEngine = new CutlineEngine(matteToImage(state.workImg, matte), state.workScale);
    hint.textContent = 'AI matte active — threshold, denoise and regions now shape the neural edge.';
    toast('AI matte ready.', 'info', 4000);
    recompute(true);
  } catch (err) {
    console.error('AI matting failed', err);
    state.useAi = false;
    aiCheckbox.checked = false;
    hint.textContent = 'AI matting failed on this device/browser — the classic pipeline still works.';
    toast(`AI matting failed: ${err instanceof Error ? err.message : err}`, 'error', 9000);
  } finally {
    aiCheckbox.disabled = false;
  }
});

($('#in-engine') as HTMLSelectElement).addEventListener('change', (e) => {
  state.params.engineVersion = (e.target as HTMLSelectElement).value as 'v2' | 'v3';
  recompute(true);
});

($('#in-v1') as HTMLInputElement).addEventListener('change', (e) => {
  state.compareV1 = (e.target as HTMLInputElement).checked;
  recompute(true);
});

($('#in-halo') as HTMLInputElement).addEventListener('change', (e) => {
  state.halo = (e.target as HTMLInputElement).checked;
  if (state.result) renderResult(state.result, 0);
});

document.querySelectorAll<HTMLButtonElement>('.shape').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.shape').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.params.shape = btn.dataset.shape as ShapeMode;
    recompute(true);
    setTimeout(fitView, 150);
  });
});

const spotInput = $('#in-spot') as HTMLInputElement;
($('#in-cutmode') as HTMLSelectElement).addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  state.spotName = mode === 'perf' ? 'PerfCutContour' : 'CutContour';
  spotInput.value = state.spotName;
});
spotInput.addEventListener('change', () => {
  state.spotName = spotInput.value.trim() || 'CutContour';
  spotInput.value = state.spotName;
});

/* ---------------- file input / drag-drop / sample ---------------- */

const fileInput = $('#file-input') as HTMLInputElement;
$('#btn-open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
  // reset so picking the same file again still fires `change`
  fileInput.value = '';
});

$('#btn-sample').addEventListener('click', () => {
  const c = makeSampleImage();
  adoptImage(c, c.width, c.height, 'sample-sticker');
});

const app = $('#app');
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  app.classList.add('dragover');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) app.classList.remove('dragover');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  app.classList.remove('dragover');
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith('image/')) loadFile(f);
});

/* ---------------- exports ---------------- */

function download(name: string, data: Blob | string, mime = 'application/octet-stream') {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

$('#btn-svg').addEventListener('click', () => {
  if (!state.result) return;
  const svg = buildSvg({
    srcW: state.srcW,
    srcH: state.srcH,
    dpi: state.params.dpi,
    svgPath: state.result.svgPath,
    cutBbox: state.result.bbox,
    imageDataUrl: state.imageDataUrl,
    halo: state.halo,
    spotName: state.spotName,
  });
  download(`${state.fileBase}-cut.svg`, svg, 'image/svg+xml');
});

$('#btn-pdf').addEventListener('click', async () => {
  if (!state.result) return;
  const pngBytes = new Uint8Array(
    await (await (await fetch(state.imageDataUrl)).blob()).arrayBuffer()
  );
  const bytes = await buildPdf({
    srcW: state.srcW,
    srcH: state.srcH,
    dpi: state.params.dpi,
    beziers: state.result.beziers,
    cutBbox: state.result.bbox,
    pngBytes,
    spotName: state.spotName,
  });
  download(`${state.fileBase}-cut.pdf`, new Blob([bytes as BlobPart], { type: 'application/pdf' }));
});

$('#btn-dxf').addEventListener('click', () => {
  if (!state.result) return;
  const dxf = buildDxf({
    rings: state.result.rings,
    srcH: state.srcH,
    dpi: state.params.dpi,
    layerName: state.spotName,
  });
  download(`${state.fileBase}-cut.dxf`, dxf, 'application/dxf');
});

async function exportRaster(format: 'png' | 'jpeg') {
  if (!state.result || !state.imageEl) return;
  try {
    const blob = await buildRaster({
      image: state.imageEl,
      srcW: state.srcW,
      srcH: state.srcH,
      svgPath: state.result.svgPath,
      cutBbox: state.result.bbox,
      halo: state.halo,
      format,
    });
    console.log(`exportRaster ${format}: ${blob.size} bytes`);
    download(`${state.fileBase}-print.${format === 'jpeg' ? 'jpg' : 'png'}`, blob);
  } catch (err) {
    console.error('exportRaster failed', err);
    toast(`${format.toUpperCase()} export failed: ${err instanceof Error ? err.message : err}`, 'error');
  }
}

$('#btn-png').addEventListener('click', () => exportRaster('png'));
$('#btn-jpg').addEventListener('click', () => exportRaster('jpeg'));
