import { CutlineEngine, DEFAULT_PARAMS } from './pipeline';
import type { CutlineParams, CutlineResult, RasterImage, RegionOverride, ShapeMode } from './pipeline';
import { computeAiMatte, matteToImage } from './ai/matte';
import { buildRaster } from './export/png';
import { makeSampleImage } from './ui/sample';
import { requestExport, fetchBalance, signupGrant, ExportError } from './paid-export';
import { PRESETS, matchPreset } from './presets';
import { toast } from './ui/toast';
import { confirmSpend } from './ui/confirm';
import { jobStart, jobStage, jobEnd } from './ui/job';
import { promptSignIn } from './ui/signin';
import { openCredits } from './ui/credits';
import type { PresetId } from './presets';
import type { PaidFormat } from './paid-export';

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
  /** Credits left, or null when signed out / the account server is unreachable. */
  balance: number | null;
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
  balance: null,
};

const activeRegion = (): RegionOverride | null =>
  state.activeRegion >= 0 ? state.params.regions[state.activeRegion] ?? null : null;

/* ---------------- toast ---------------- */


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

/**
 * Segment the artwork into its elements and seed one region per element, so
 * each can be tuned on its own. Artwork that mixes a heavy mark with fine
 * type has no single set of values that suits all of it.
 */
$('#btn-detect').addEventListener('click', () => {
  const engine = state.useAi && state.aiEngine ? state.aiEngine : state.engine;
  if (!engine) {
    toast('Load an image first.', 'error');
    return;
  }
  if (state.params.engineVersion !== 'v3') {
    toast('Per-element cutting needs the v3 engine — switch Engine to v3.', 'error', 5000);
    return;
  }
  const groups = engine.detectGroups(state.params);
  if (groups.length < 2) {
    toast(
      groups.length === 1
        ? 'This artwork reads as a single element — nothing to split.'
        : 'No elements detected.',
      'error'
    );
    return;
  }
  // Inset by a hair so neighbouring boxes never share an edge, which would
  // make the feather blend of one region bleed into the next.
  // Seed each element with the current global offset so selecting one and
  // dragging the slider adjusts from what is already on screen.
  state.params.regions = groups.map((g) => ({
    x: Math.round(g.bbox.x),
    y: Math.round(g.bbox.y),
    w: Math.round(g.bbox.w),
    h: Math.round(g.bbox.h),
    offsetMm: state.params.offsetMm,
  }));
  state.activeRegion = 0;
  renderRegions();
  syncRegionControls();
  recompute(true);
  toast(
    `${groups.length} elements detected — pick one to tune it on its own.`,
    'info',
    5000
  );
});

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
  const off = r?.offsetMm ?? state.params.offsetMm;
  ($('#in-offset') as HTMLInputElement).value = String(off);
  $('#out-offset').textContent = `${off.toFixed(1)} mm`;
  $('#region-hint').textContent = r
    ? `R${state.activeRegion + 1}: threshold / denoise / hug-body / offset apply to this region only`
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
  // With an element selected the offset applies to that element alone, so a
  // heavy mark and a fine strapline can each carry the border their scale
  // wants. v3 only — v2 has no per-element geometry path.
  const r = activeRegion();
  if (r && state.params.engineVersion === 'v3') r.offsetMm = v;
  else state.params.offsetMm = v;
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
  ($('#in-holes-simple') as HTMLInputElement).checked = state.params.keepHoles;
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

/* ---------------- simple / advanced ---------------- */

/**
 * Simple mode picks a cut style; advanced exposes every control.
 *
 * The rail is not duplicated — advanced shows the same sections simple hides,
 * so there is one source of truth for every parameter and no chance of the
 * two modes disagreeing about what the cut currently is.
 */
function setMode(mode: 'simple' | 'advanced') {
  const simple = mode === 'simple';
  document.body.classList.toggle('mode-simple', simple);
  $('#tab-simple').classList.toggle('active', simple);
  $('#tab-advanced').classList.toggle('active', !simple);
  $('#tab-simple').setAttribute('aria-selected', String(simple));
  $('#tab-advanced').setAttribute('aria-selected', String(!simple));
  if (simple) syncPresetSelection();
}

function applyPreset(id: PresetId) {
  const preset = PRESETS[id];
  Object.assign(state.params, preset.params);
  // The advanced sliders must show what the preset chose, or switching tabs
  // would present stale values that no longer describe the cut.
  syncCutControls();
  syncPresetSelection();
  recompute(true);
}

/** Reflect params in the advanced Cut path controls. */
function syncCutControls() {
  const p = state.params;
  const set = (sel: string, out: string, v: number, fmt: (n: number) => string) => {
    const el = $(sel) as HTMLInputElement | null;
    if (el) el.value = String(v);
    const o = $(out);
    if (o) o.textContent = fmt(v);
  };
  set('#in-offset', '#out-offset', p.offsetMm, (v) => `${v.toFixed(1)} mm`);
  set('#in-corner', '#out-corner', p.minCornerRadiusMm, (v) => `${v.toFixed(1)} mm`);
  set('#in-precision', '#out-precision', p.precisionMm, (v) => `±${v.toFixed(2)} mm`);
  set('#in-smooth', '#out-smooth', p.smoothness, (v) => String(v));
  set('#in-bridge', '#out-bridge', p.bridgeMm, (v) => (v === 0 ? 'off' : `${v.toFixed(1)} mm`));
}

/**
 * Highlight the preset that matches the current parameters, or none.
 *
 * Leaving every button unlit after an advanced tweak is deliberate: a lit
 * button would be claiming to describe a cut it no longer describes.
 */
function syncPresetSelection() {
  const active = matchPreset(state.params);
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.preset')) {
    btn.classList.toggle('active', btn.dataset.preset === active);
  }
  const hint = $('#preset-hint');
  if (hint) {
    hint.textContent = active
      ? PRESETS[active].hint
      : 'Custom settings from the Advanced tab.';
  }
  const holes = $('#in-holes-simple') as HTMLInputElement | null;
  if (holes) holes.checked = state.params.keepHoles;
}

// Simple is the default: it is the mode that answers the question most
// people arrive with, and Advanced is one click away.
setMode('simple');
applyPreset('sticker');

$('#tab-simple').addEventListener('click', () => setMode('simple'));
$('#tab-advanced').addEventListener('click', () => setMode('advanced'));

for (const btn of document.querySelectorAll<HTMLButtonElement>('.preset')) {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset as PresetId));
}

// The two "cut interior holes" checkboxes are one setting shown twice.
$('#in-holes-simple').addEventListener('change', (e) => {
  state.params.keepHoles = (e.target as HTMLInputElement).checked;
  ($('#in-holes') as HTMLInputElement).checked = state.params.keepHoles;
  recompute(true);
});

/* ---------------- account ---------------- */

/** The account page, served by this same app. */
const ACCOUNT_URL = '/account';

function renderBalance() {
  const el = $<HTMLAnchorElement>('#st-credits');
  if (!el) return;
  // Kept as a real href so it still works without JS and can be opened in a
  // new tab deliberately; the click handler below prefers the dialog.
  el.href = ACCOUNT_URL;
  el.removeAttribute('target');
  const count = el.querySelector('.credit-count');
  const label = el.querySelector('.credit-label');
  if (state.balance === null) {
    if (count) count.textContent = 'Sign in';
    if (label) label.textContent = 'to download';
    el.title = 'Sign in to download cut files';
    el.classList.remove('is-empty', 'is-low');
    return;
  }
  if (count) count.textContent = String(state.balance);
  if (label) label.textContent = state.balance === 1 ? 'credit' : 'credits';
  // A balance that has run out, or is about to, is worth seeing before the
  // download fails rather than after.
  el.classList.toggle('is-empty', state.balance === 0);
  el.classList.toggle('is-low', state.balance > 0 && state.balance <= 3);
  el.title =
    state.balance === 0 ? 'Out of credits — click to buy more' : 'Credits remaining';
}

// Advisory only — the export route re-checks the balance when it charges, so
// a stale number here cannot buy anything.
void fetchBalance().then((b) => {
  state.balance = b;
  renderBalance();
});

/**
 * The credit pill opens a dialog rather than a page.
 *
 * Buying credits was the only reason to visit the account, and leaving the
 * studio to do it throws away the loaded artwork and every setting. The
 * dialog keeps that work on screen.
 */
$('#st-credits').addEventListener('click', (e) => {
  // Let deliberate new-tab clicks through to the real page.
  if ((e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey || (e as MouseEvent).shiftKey) return;
  e.preventDefault();
  void openCredits(() => {
    // Signing out from the dialog: reflect it here without a reload.
    state.balance = null;
    renderBalance();
    void fetch('/api/auth/signout', { method: 'POST', credentials: 'include' })
      .catch(() => {})
      .then(() => { window.location.reload(); });
  }).then((balance) => {
    state.balance = balance;
    renderBalance();
  });
});

/* ---------------- exports ---------------- */

/**
 * Cut files come from the server.
 *
 * The preview is computed here and stays here — that is what makes the app
 * fast and keeps artwork on the customer's machine. The deliverable is not:
 * it is generated server-side after a credit is charged, because a file the
 * browser can build is a file the browser already has, and a credit check in
 * front of that only stops the people who were never going to bypass it.
 */
async function paidExport(format: PaidFormat) {
  if (!state.result) return;
  // Signed out: ask here rather than sending them away. The loaded artwork
  // and every slider live in this page, so navigating to sign in would throw
  // away the work they just did.
  if (state.balance === null) {
    // null means EITHER signed out OR the page-load balance check has not come
    // back yet. Confirm with the server before accusing someone of being
    // signed out — a fast click would otherwise show the sign-in modal to a
    // user who is already signed in.
    state.balance = await fetchBalance();
    renderBalance();
  }
  if (state.balance === null) {
    const outcome = await promptSignIn(signupGrant);
    if (outcome !== 'signed-in') return;
    state.balance = await fetchBalance();
    renderBalance();
    // Still signed out — the popup was closed or consent was declined.
    if (state.balance === null) {
      toast('Sign-in was not completed.', 'error', 6000);
      return;
    }
  }

  // Confirm before charging: a click that silently spends money is a support
  // ticket waiting to happen.
  if (!(await confirmSpend(format, state.balance))) return;
  const btn = $(`#btn-${format.toLowerCase()}`) as HTMLButtonElement;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'preparing...';
  // PDF and PNG carry the artwork, which is the slow part of the request;
  // naming that stage explains the wait instead of leaving it unexplained.
  const carriesArtwork = format === 'PDF' || format === 'PNG';
  jobStart(format, carriesArtwork ? 'sending' : 'rendering');
  const toRender = carriesArtwork
    ? window.setTimeout(() => jobStage('rendering', format), 600)
    : null;
  try {
    const { filename, creditsRemaining } = await requestExport(format, {
      result: state.result,
      srcW: state.srcW,
      srcH: state.srcH,
      dpi: state.params.dpi,
      spotName: state.spotName,
      halo: state.halo,
      fileBase: state.fileBase,
      imageDataUrl: state.imageDataUrl,
    });
    state.balance = creditsRemaining;
    renderBalance();
    toast(
      creditsRemaining === null
        ? `${filename} downloaded.`
        : `${filename} downloaded · ${creditsRemaining} credit${creditsRemaining === 1 ? '' : 's'} left`,
      'success',
      5000
    );
    if (creditsRemaining === 0) {
      toast('That was your last credit.', 'info', 9000, {
        label: 'Buy more',
        onClick: () => void openCredits().then((b) => {
          state.balance = b;
          renderBalance();
        }),
      });
    }
  } catch (err) {
    if (err instanceof ExportError) {
      // Each failure implies a different next step, so they get different
      // words rather than one generic "export failed".
      if (err.kind === 'auth') {
        // Reached when a session expires between loading the page and
        // downloading; the modal is the same one the first click would show.
        state.balance = null;
        renderBalance();
        toast('Your session expired.', 'error', 0, {
          label: 'Sign in',
          onClick: () => void promptSignIn(signupGrant).then(async (o) => {
            if (o === 'signed-in') {
              state.balance = await fetchBalance();
              renderBalance();
            }
          }),
        });
      } else if (err.kind === 'credits') {
        toast('Out of credits.', 'error', 0, {
          label: 'Buy credits',
          onClick: () => void openCredits().then((b) => {
            state.balance = b;
            renderBalance();
          }),
        });
      } else if (err.kind === 'rate') {
        toast('Too many exports just now. Try again in a moment.', 'error', 6000);
      } else {
        toast(err.message, 'error', 6000);
      }
    } else {
      toast(`Export failed: ${err instanceof Error ? err.message : err}`, 'error', 6000);
    }
  } finally {
    // The banner reports work in progress; the outcome is the toast's job.
    jobEnd();
    if (toRender !== null) clearTimeout(toRender);
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('#btn-svg').addEventListener('click', () => paidExport('SVG'));
$('#btn-pdf').addEventListener('click', () => paidExport('PDF'));
$('#btn-dxf').addEventListener('click', () => paidExport('DXF'));
$('#btn-png').addEventListener('click', () => paidExport('PNG'));

/**
 * JPEG stays local and free. It has no alpha channel, so it cannot carry a
 * cutline at all — it is a flattened proof to email a print shop, not
 * something a cutter can use. Charging for it would be charging for a
 * screenshot.
 */
async function exportJpegLocal() {
  if (!state.result || !state.imageEl) return;
  try {
    const blob = await buildRaster({
      image: state.imageEl,
      srcW: state.srcW,
      srcH: state.srcH,
      svgPath: state.result.svgPath,
      cutBbox: state.result.bbox,
      halo: state.halo,
      format: 'jpeg',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.fileBase}-proof.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    toast(`JPEG proof failed: ${err instanceof Error ? err.message : err}`, 'error');
  }
}

$('#btn-jpg').addEventListener('click', exportJpegLocal);
