import { CutlineEngine, DEFAULT_PARAMS } from './pipeline';
import type { CutlineParams, CutlineResult, RasterImage, RegionOverride, ShapeMode } from './pipeline';
import { computeAiMatte, matteToImage } from './ai/matte';
import { upsampleMatte, applyStrokes, cutout, floodMatte, coverage, type Stroke } from './ai/cutout';
import { buildRaster } from './export/png';
import { makeSampleImage } from './ui/sample';
import { requestExport, fetchBalance, signupGrant, ExportError } from './paid-export';
import { PRESETS, matchPreset } from './presets';
import { toast } from './ui/toast';
import { confirmSpend } from './ui/confirm';
import { chooseExport, defaultFormat } from './ui/export-dialog';
import { jobStart, jobStage, jobEnd } from './ui/job';
import { showLoading } from './ui/loading';
import { createSplash, splashSeen } from './ui/splash';
import { createTour, tourSeen } from './ui/tour';
import { mountCutSlider, mountValueSlider, mountCheckbox, mountSelect } from './ui/controls';
import { promptSignIn, signOutNow } from './ui/signin';
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

  /**
   * Background removal state.
   *
   * `bgMatte` is at SOURCE resolution, not working resolution: it has to cut
   * out the artwork the user exports, and the model runs on the downscaled
   * copy. `bgOriginal` keeps the untouched artwork so Undo is exact and a
   * restore stroke still has colour to bring back.
   */
  bgMatte: Float32Array | null;
  bgOriginal: string | null;
  bgStrokes: Stroke[];
  bgMode: 'drop' | 'keep';
  bgBrush: number;
  bgReviewing: boolean;
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
  bgMatte: null,
  bgOriginal: null,
  bgStrokes: [],
  bgMode: 'drop',
  bgBrush: 40,
  bgReviewing: false,
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
  redrawCheckboxes();
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
  // The toolbar names the file the way the user knows it, with its pixel
  // dimensions beside it; the status bar keeps the derived measurements.
  $('#ct-name').textContent = base;
  $('#ct-dims').textContent = `${w} × ${h}`;
  for (const id of ['#btn-svg', '#btn-pdf', '#btn-dxf', '#btn-png', '#btn-jpg', '#btn-export']) {
    ($(id) as HTMLButtonElement).disabled = false;
  }
  // A new image has no removal history; the panel appears now that there is
  // something for it to act on.
  state.bgMatte = null;
  state.bgOriginal = null;
  state.bgStrokes = [];
  state.bgReviewing = false;
  syncBackgroundUi();
  // Reveals the Elements section now that there is artwork to detect within.
  renderElementList();
  // The baseline for "edited" is whatever this image opened with, so opening
  // a second file clears the tag rather than inheriting the first one's.
  openedWith = cutFingerprint();
  syncEditedState();
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
/**
 * A snapshot of the cut settings as the current image was opened.
 *
 * "Edited" is derived by comparing against this rather than set by a flag on
 * every interaction: a flag would have to be cleared by hand in a dozen
 * places and would eventually lie. Comparing means moving a slider and moving
 * it back correctly reports "not edited", because it isn't.
 */
let openedWith = '';

function cutFingerprint(): string {
  const p = state.params;
  return JSON.stringify([
    p.offsetMm, p.minCornerRadiusMm, p.precisionMm, p.smoothness, p.bridgeMm,
    p.keepHoles, p.alphaThreshold, p.bgTolerance, p.denoisePx, p.engineVersion,
    state.halo, state.spotName,
    p.regions.map((r) => [r.x, r.y, r.w, r.h, r.offsetMm ?? null]),
  ]);
}

/** Show the edited tag and the top-bar export only once something changed. */
function syncEditedState() {
  const edited = state.imageEl !== null && cutFingerprint() !== openedWith;
  const tag = $('#edited-tag');
  const btn = $('#btn-export-top') as HTMLButtonElement | null;
  if (tag) tag.hidden = !edited;
  if (btn) btn.hidden = !edited;
}

function recompute(immediate = false) {
  // AI mode traces the neural matte; v1 comparison always uses the original.
  const engine = state.useAi && state.aiEngine ? state.aiEngine : state.engine;
  if (!engine) return;
  if (pending !== null) clearTimeout(pending);

  // Say that work is happening BEFORE it starts.
  //
  // engine.compute() is synchronous and can run for well over a second on a
  // large image, and a blocked main thread paints nothing — so setting a flag
  // and calling compute() in the same task shows the flag only after the work
  // it was meant to announce has finished. Switching a preset therefore
  // looked like nothing happened at all, for as long as it took.
  //
  // Marking the canvas here and yielding below is what gets the state on
  // screen first. The mark is cheap enough to leave on for fast recomputes;
  // the CSS holds it back with a transition delay so a 20ms trace does not
  // flicker.
  document.body.classList.add('is-tracing');

  pending = window.setTimeout(
    () => {
      pending = null;
      syncEditedState();
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
      document.body.classList.remove('is-tracing');
    },
    // Never 0, even when immediate: a zero-delay timeout can be serviced
    // before the browser has painted the is-tracing state, which puts us back
    // to showing the indicator only after the work it announces is done.
    // One frame is enough to get it on screen and is imperceptible.
    immediate ? 16 : 60
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
  // "Cut ready" means there is geometry to export — which is exactly the
  // condition under which the export button does anything, so it is read
  // from the same fact rather than set optimistically alongside it.
  $('#st-ready').hidden = r.rings.length === 0;
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
  const zoom = `${Math.round(view.k * 100)}%`;
  $('#st-zoom').textContent = zoom;
  // The toolbar reading is the one beside the +/− buttons that change it.
  const ctZoom = $('#ct-zoom');
  if (ctZoom) ctZoom.textContent = zoom;
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

  // Refining a background removal takes the click before panning does: while
  // the review panel is up, the canvas is a correction surface. Panning stays
  // available on the scroll wheel and on a two-finger trackpad drag.
  if (state.bgReviewing && state.bgMatte) {
    const p = screenToImg(e);
    state.bgStrokes.push({ x: p.x, y: p.y, r: state.bgBrush, mode: state.bgMode });
    applyBackgroundPreview();
    return;
  }

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
// Two entry points, one behaviour: the Simple tab's "Detect" link and the
// Advanced tab's button run the same detection rather than diverging.
$('#btn-detect-simple').addEventListener('click', () => $('#btn-detect').click());

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

/**
 * Name a detected element from where it sits and how tall it is.
 *
 * The detector returns boxes, not meanings, so these are descriptions rather
 * than claims: the tallest band is almost always the icon or the display
 * type, and a short band under it is a strapline. Getting a name slightly
 * wrong is harmless — the row is identified by its swatch and its position in
 * the list — but "R2" tells the user nothing at all.
 */
function elementName(r: RegionOverride, all: RegionOverride[]): string {
  if (all.length === 1) return 'Whole artwork';
  const tallest = Math.max(...all.map((x) => x.h));
  const widest = Math.max(...all.map((x) => x.w));

  const base = (x: RegionOverride): string => {
    // A tall, narrow block beside wider ones reads as a mark rather than text.
    if (x.h >= tallest * 0.8 && x.w <= widest * 0.55) return 'Icon';
    if (x.h >= tallest * 0.8) return 'Display type';
    if (x.h <= tallest * 0.5) return 'Strapline';
    return 'Element';
  };

  const name = base(r);
  // Two bands of similar height genuinely earn the same description, so the
  // duplicates are numbered rather than left identical — a list with two rows
  // reading "Strapline" cannot be talked about or told apart.
  const sameName = all.filter((x) => base(x) === name);
  if (sameName.length < 2) return name;
  return `${name} ${sameName.indexOf(r) + 1}`;
}

/** The element list in the Simple tab: one row per detected region. */
function renderElementList() {
  const panel = $('#panel-elements');
  const list = $('#el-list');
  if (!panel || !list) return;

  const regions = state.params.regions;
  // The section appears as soon as there is artwork to detect within, not
  // once regions exist — otherwise the control that creates them is hidden
  // behind their existence.
  panel.hidden = state.imageEl === null;
  list.innerHTML = '';

  if (regions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Detect to tune the icon and the text separately.';
    list.appendChild(empty);
    return;
  }

  regions.forEach((r, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `el-row${state.activeRegion === i ? ' active' : ''}`;

    const sw = document.createElement('span');
    sw.className = 'el-swatch';

    const name = document.createElement('span');
    name.className = 'el-name';
    name.textContent = elementName(r, regions);

    const mm = document.createElement('span');
    mm.className = 'el-mm';
    // Falls back to the global offset: a region with no override of its own
    // is cut at whatever the slider says, and showing a blank there would
    // imply it is not being cut at all.
    mm.textContent = `${(r.offsetMm ?? state.params.offsetMm).toFixed(1)} mm`;

    row.append(sw, name, mm);
    row.addEventListener('click', () => {
      state.activeRegion = i;
      renderRegions();
      syncRegionControls();
    });
    list.appendChild(row);
  });
}

function renderRegions() {
  renderElementList();
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
  // The mounted sliders read their input, so a write has to tell them to
  // re-read it — otherwise selecting a region updates the numbers while the
  // handles stay where the last region left them.
  redrawSlider('#in-alpha');
  redrawSlider('#in-denoise');
  redrawSlider('#in-offset');
  redrawCheckboxes();
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

/**
 * Bind a rail slider.
 *
 * The markup still carries an <input type="range"> so the min/max/step and
 * the current value live in one place, but it is never shown: a Base UI
 * slider is mounted over it and the input becomes the model. That keeps every
 * existing `input.value = x` write working — syncRegionControls does a dozen
 * of them — while the thing on screen is a control whose thumb is a real
 * element rather than an unmeasurable pseudo-element.
 */
const sliderRedraws = new Map<string, () => void>();

function bindSlider(
  inputSel: string,
  outputSel: string,
  format: (v: number) => string,
  apply: (v: number) => void
) {
  const input = $(inputSel) as HTMLInputElement;
  const out = $(outputSel) as HTMLOutputElement;

  const host = document.createElement('div');
  host.className = 'bui-slider-host';
  input.after(host);
  input.hidden = true;

  const draw = () => {
    mountValueSlider(host, {
      value: parseFloat(input.value),
      min: parseFloat(input.min || '0'),
      max: parseFloat(input.max || '100'),
      step: parseFloat(input.step || '1'),
      label: out.id.replace(/^out-/, ''),
      onChange: (v) => {
        // The input stays the source of truth, so anything that reads or
        // writes it later still sees the value the user chose.
        input.value = String(v);
        out.textContent = format(v);
        apply(v);
        // Deliberately NOT re-mounting here. React re-renders the same tree
        // from the new input value on the next redraw; calling draw() during
        // a drag replaces the element the pointer is captured on, and the
        // drag dies on the first move. Only external writes redraw.
        recompute();
      },
    });
  };

  // The hidden input is still a real range input, so anything that sets its
  // value and fires `input` — a test, a script, an automation — keeps working
  // exactly as it did before the mount existed. Without this the model can
  // only be seeded, never driven, and code that used to move a slider would
  // silently do nothing.
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isNaN(v)) return;
    out.textContent = format(v);
    apply(v);
    draw();
    recompute();
  });

  sliderRedraws.set(inputSel, draw);
  draw();
}

/** Re-read a slider from its input after code has written input.value. */
function redrawSlider(inputSel: string): void {
  sliderRedraws.get(inputSel)?.();
}

/**
 * Upgrade every option checkbox to a Base UI Checkbox.
 *
 * Same shape as the sliders: the native input stays as the model so all the
 * existing `.checked` reads and writes keep working, and a drawn control is
 * mounted beside it. Done as a sweep rather than per control because these
 * are seven instances of one thing — and because the hand-drawn version was
 * a tick built from rotated borders, which is exactly the kind of CSS that
 * collides with the next control that also wants an ::after.
 */
const checkboxRedraws = new Map<HTMLInputElement, () => void>();

function upgradeCheckboxes(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('.row.check input[type="checkbox"]')) {
    if (checkboxRedraws.has(input)) continue;

    const host = document.createElement('span');
    host.className = 'bui-checkbox-host';
    input.after(host);
    input.hidden = true;

    const label = input.closest('.row.check')?.querySelector('label')?.textContent?.trim() ?? '';

    const draw = () => {
      mountCheckbox(host, {
        checked: input.checked,
        label,
        onChange: (on) => {
          input.checked = on;
          draw();
          // Dispatched so the existing change listeners — which are where the
          // behaviour actually lives — run exactly as they did before.
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
    };

    checkboxRedraws.set(input, draw);
    draw();
  }
}

/** Re-read every checkbox after code has written .checked directly. */
function redrawCheckboxes(): void {
  for (const draw of checkboxRedraws.values()) draw();
}

/**
 * Upgrade the native selects.
 *
 * A native <select> draws its popup with the OS, so on a near-black interface
 * it opens as a bright system list no stylesheet can reach — the old one had
 * a background-image chevron painted on to disguise half the problem. Same
 * model-behind-a-mount shape as the other controls: the <select> keeps the
 * value and the change handlers, the mounted control is what the user sees.
 */
function upgradeSelects(): void {
  for (const el of document.querySelectorAll<HTMLSelectElement>('.row select')) {
    const host = document.createElement('span');
    host.className = 'bui-select-host';
    el.after(host);
    el.hidden = true;

    const options = [...el.options].map((o) => ({ value: o.value, label: o.textContent ?? o.value }));
    const label = el.closest('.row')?.querySelector('label')?.textContent?.trim() ?? el.id;

    const draw = () => {
      mountSelect(host, {
        value: el.value,
        options,
        label,
        onChange: (v) => {
          el.value = v;
          draw();
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
    };
    draw();
  }
}

bindSlider('#in-offset', '#out-offset', (v) => `${v.toFixed(1)} mm`, (v) => {
  // With an element selected the offset applies to that element alone, so a
  // heavy mark and a fine strapline can each carry the border their scale
  // wants. v3 only — v2 has no per-element geometry path.
  const r = activeRegion();
  if (r && state.params.engineVersion === 'v3') r.offsetMm = v;
  else state.params.offsetMm = v;
  // The element rows quote their own offsets, so they have to follow the
  // slider rather than only refreshing when the selection changes.
  renderElementList();
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
  // The mirrored box is a model behind a mounted control, so writing it is
  // only half the job — without this the two copies of one setting disagree
  // on screen while agreeing underneath.
  redrawCheckboxes();
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
    redrawCheckboxes();
    toast('Open an image first.', 'error');
    return;
  }
  aiCheckbox.disabled = true;
  const hint = $('#hint-ai');
  // The first run can take minutes while the model downloads, so the wait
  // gets the full overlay rather than a toast in the corner.
  //
  // The progress messages are deliberately NOT shown. They name the model and
  // its size, which is implementation detail the user did not ask about and
  // cannot act on — "Preparing your workspace" is the whole of what they need
  // to know. The messages still reach the console, where they are useful to
  // whoever is debugging a slow first run.
  const closeLoading = showLoading('Preparing your workspace');
  try {
    const matte = await computeAiMatte(state.workImg, (msg) => {
      console.info('[matte]', msg);
    });
    state.aiEngine = new CutlineEngine(matteToImage(state.workImg, matte), state.workScale);
    hint.textContent = 'Smart edges active — threshold, denoise and regions now shape them.';
    toast('Smart edges ready.', 'info', 4000);
    recompute(true);
  } catch (err) {
    console.error('Smart edge detection failed', err);
    state.useAi = false;
    aiCheckbox.checked = false;
    redrawCheckboxes();
    hint.textContent = 'Smart edges are not available on this device — the usual trace still works.';
    // The underlying error goes to the console, not to the user: it names
    // wasm backends and model files, which is noise to someone who just
    // wanted a cutline.
    toast('Smart edges are not available on this device.', 'error', 7000);
  } finally {
    closeLoading();
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

// The empty canvas offers two ways in, and both have to work: drag a file, or
// press the button. Before this, the only way to open an image from an empty
// canvas was the top bar, which is a long way from where the user is looking.
$('#btn-drop-open').addEventListener('click', () => fileInput.click());
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

/**
 * Put every setting back to its shipped default.
 *
 * Deliberately not a reload: the artwork, the zoom and the sign-in state are
 * not settings, and throwing them away to reset a slider would be a worse
 * surprise than the one the user is trying to undo. Only params, the two
 * view toggles and the spot name go back.
 *
 * The values come from DEFAULT_PARAMS rather than from literals repeated
 * here, so a setting added to the defaults is reset without anyone
 * remembering to update this function. Regions are cleared rather than
 * defaulted: they describe the image that happens to be open, and a default
 * for them is meaningless.
 */
function resetAllSettings() {
  state.params = { ...DEFAULT_PARAMS, regions: [] };
  state.activeRegion = -1;
  state.halo = true;
  state.compareV1 = false;
  state.spotName = 'CutContour';
  state.useAi = false;

  // Numeric inputs and their mounted sliders.
  syncCutControls();
  const p = state.params;
  const setSlider = (sel: string, out: string, v: number, fmt: (n: number) => string) => {
    const el = $(sel) as HTMLInputElement | null;
    if (el) el.value = String(v);
    const o = $(out);
    if (o) o.textContent = fmt(v);
    redrawSlider(sel);
  };
  setSlider('#in-alpha', '#out-alpha', p.alphaThreshold, (v) => String(v));
  setSlider('#in-bgtol', '#out-bgtol', p.bgTolerance, (v) => String(v));
  setSlider('#in-denoise', '#out-denoise', p.denoisePx, (v) => `${v.toFixed(1)} px`);
  setSlider('#in-holemin', '#out-holemin', p.holeMinMm2, (v) => `${v.toFixed(0)} mm²`);
  ($('#in-dpi') as HTMLInputElement).value = String(p.dpi);

  // Checkboxes are mirrored by a custom control, so writing .checked is not
  // enough on its own — redrawCheckboxes() is what makes the change visible.
  const check = (sel: string, on: boolean) => {
    const el = $(sel) as HTMLInputElement | null;
    if (el) el.checked = on;
  };
  check('#in-holes', p.keepHoles);
  check('#in-holes-simple', p.keepHoles);
  check('#in-body', p.hugBody);
  check('#in-ai', false);
  check('#in-halo', true);
  check('#in-v1', false);
  redrawCheckboxes();

  // Die shape is a button group, not an input: its state is the active class.
  document.querySelectorAll<HTMLButtonElement>('.shape').forEach((b) => {
    b.classList.toggle('active', b.dataset.shape === p.shape);
  });

  // Output.
  const cutmode = $('#in-cutmode') as HTMLSelectElement | null;
  if (cutmode) {
    cutmode.value = 'kiss';
    cutmode.dispatchEvent(new Event('change', { bubbles: true }));
  }
  spotInput.value = state.spotName;

  // The Simple tab reads the same params, so it has to follow too.
  syncPresetSelection();
  renderElementList();
  recompute(true);
  toast('Settings reset to defaults.', 'info', 3000);
}

/** Reflect params in the advanced Cut path controls. */
function syncCutControls() {
  const p = state.params;
  const set = (sel: string, out: string, v: number, fmt: (n: number) => string) => {
    const el = $(sel) as HTMLInputElement | null;
    if (el) el.value = String(v);
    const o = $(out);
    if (o) o.textContent = fmt(v);
    // The mounted slider reads its input, so it has to be told to re-read.
    redrawSlider(sel);
  };
  set('#in-offset', '#out-offset', p.offsetMm, (v) => `${v.toFixed(1)} mm`);
  set('#in-corner', '#out-corner', p.minCornerRadiusMm, (v) => `${v.toFixed(1)} mm`);
  set('#in-precision', '#out-precision', p.precisionMm, (v) => `±${v.toFixed(2)} mm`);
  set('#in-smooth', '#out-smooth', p.smoothness, (v) => String(v));
  set('#in-bridge', '#out-bridge', p.bridgeMm, (v) => (v === 0 ? 'off' : `${v.toFixed(1)} mm`));
}

/**
 * The four presets in the order the slider walks them: tightest to loosest.
 * This is the slider's axis, so it must stay ordered by offset.
 */
const PRESET_ORDER: PresetId[] = ['tight', 'close', 'sticker', 'loose'];

/** The stop whose offset is closest to an arbitrary value. */
function nearestStopByOffset(mm: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < PRESET_ORDER.length; i++) {
    const gap = Math.abs(PRESETS[PRESET_ORDER[i]].params.offsetMm - mm);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

/**
 * Highlight the preset that matches the current parameters, or none.
 *
 * Leaving every button unlit after an advanced tweak is deliberate: a lit
 * button would be claiming to describe a cut it no longer describes.
 */
function syncPresetSelection() {
  const active = matchPreset(state.params);
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.cutstop')) {
    btn.classList.toggle('active', btn.dataset.preset === active);
  }

  // The knob follows the parameters, not the other way round: an advanced
  // tweak that lands between presets leaves the stops unlit but must not
  // leave the knob somewhere that contradicts the numbers, so it parks at the
  // nearest stop by offset while the labels stay dark.
  const host = $('#mount-cutstyle');
  if (host) {
    const idx = active
      ? PRESET_ORDER.indexOf(active)
      : nearestStopByOffset(state.params.offsetMm);
    mountCutSlider(host, {
      stops: PRESET_ORDER.map((id) => ({
        id,
        label: PRESETS[id].label,
        sub: `${PRESETS[id].params.offsetMm} mm`,
      })),
      value: idx,
      onChange: (i) => applyPreset(PRESET_ORDER[i] ?? 'tight'),
    });
  }

  // The live offset, in the section header. This is the number the whole
  // control exists to set, so it is shown even when no preset matches.
  const value = $('#out-cut-offset');
  if (value) value.textContent = `${state.params.offsetMm.toFixed(2)} mm`;

  const hint = $('#preset-hint');
  if (hint) {
    hint.textContent = active
      ? PRESETS[active].hint
      : 'Custom settings from the Advanced tab.';
  }
  const holes = $('#in-holes-simple') as HTMLInputElement | null;
  if (holes) holes.checked = state.params.keepHoles;
  redrawCheckboxes();
}

// Simple is the default: it is the mode that answers the question most
// people arrive with, and Advanced is one click away.
// Upgrade the option checkboxes before the first sync, so nothing draws the
// native control even briefly.
upgradeCheckboxes();
upgradeSelects();
setMode('simple');
applyPreset('sticker');

// role="tablist" promises arrow-key navigation to anyone using a screen
// reader or the keyboard, so the tabs have to honour it. Left as two plain
// buttons rather than rebuilt on a tab component: the roles and the styling
// are already right, and this is the only behaviour that was missing.
$('.mode-tabs').addEventListener('keydown', (e) => {
  const key = (e as KeyboardEvent).key;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
  e.preventDefault();
  const simple = key === 'ArrowLeft' || key === 'Home';
  setMode(simple ? 'simple' : 'advanced');
  $(simple ? '#tab-simple' : '#tab-advanced').focus();
});

$('#tab-simple').addEventListener('click', () => setMode('simple'));
$('#tab-advanced').addEventListener('click', () => setMode('advanced'));

/* ---------------- background removal ---------------- */

/**
 * Cut the artwork out of its background.
 *
 * The neural matte already existed but only ever positioned the cut line, so
 * a logo on a white card got a perfect outline drawn over still-white pixels
 * — and exported that white with it. This does the thing the name implies.
 *
 * Two engines, chosen by what the image needs rather than by a setting:
 * the model for photographs and busy backgrounds, and the border-vote flood
 * fill for flat studio backgrounds, where it is as good and finishes in
 * milliseconds instead of minutes. The flood runs first precisely because it
 * is instant: if it produces a sane result there is no reason to download
 * ~98MB to do better.
 */
async function removeBackground(): Promise<void> {
  if (!state.imageEl || !state.workImg) {
    toast('Open an image first.', 'error');
    return;
  }
  const btn = $('#btn-remove-bg') as HTMLButtonElement;
  btn.disabled = true;

  // Full-resolution copy: the matte has to cut out what gets exported, and
  // the working image is downscaled.
  const src = document.createElement('canvas');
  src.width = state.srcW;
  src.height = state.srcH;
  src.getContext('2d')!.drawImage(state.imageEl, 0, 0, state.srcW, state.srcH);
  const full = src.getContext('2d')!.getImageData(0, 0, state.srcW, state.srcH);

  let matte = floodMatte(full, state.params.bgTolerance);
  let kept = coverage(matte);

  // A flood that kept almost everything found no background it could reach;
  // one that kept almost nothing ate the artwork. Either way the image is not
  // the flat-background kind, so it is worth the model.
  const floodFailed = kept > 0.92 || kept < 0.02;

  if (floodFailed) {
    const close = showLoading('Removing the background');
    try {
      const aiMatte = await computeAiMatte(state.workImg, (m) => console.info('[matte]', m));
      matte = upsampleMatte(
        aiMatte,
        state.workImg.width,
        state.workImg.height,
        state.srcW,
        state.srcH
      );
      kept = coverage(matte);
    } catch (err) {
      console.error('Neural background removal failed', err);
      // Keep the flood result rather than nothing: on some images it is
      // still better than leaving the background in.
      toast('Used a simpler background removal — this device cannot run the better one.', 'info', 6000);
    } finally {
      close();
    }
  }

  if (kept > 0.985) {
    btn.disabled = false;
    toast('No background found to remove.', 'info', 5000);
    return;
  }

  // Remember the original before the first removal, so Undo is exact.
  if (!state.bgOriginal) state.bgOriginal = state.imageDataUrl;
  state.bgMatte = matte;
  state.bgStrokes = [];
  state.bgReviewing = true;
  applyBackgroundPreview();
  btn.disabled = false;
}

/** Redraw the canvas from the current matte plus whatever strokes exist. */
function applyBackgroundPreview(): void {
  if (!state.bgMatte || !state.imageEl) return;

  const src = document.createElement('canvas');
  src.width = state.srcW;
  src.height = state.srcH;
  const sctx = src.getContext('2d')!;
  // From the ORIGINAL element, never from the current canvas: compounding a
  // removal onto an already-cut image would erode the artwork a little more
  // with every stroke, and a restore stroke would have no colour to bring
  // back.
  sctx.drawImage(state.imageEl, 0, 0, state.srcW, state.srcH);
  const full = sctx.getImageData(0, 0, state.srcW, state.srcH);

  const withStrokes = applyStrokes(state.bgMatte, full, state.bgStrokes);
  const cut = cutout(full, withStrokes);

  const out = document.createElement('canvas');
  out.width = state.srcW;
  out.height = state.srcH;
  const octx = out.getContext('2d')!;
  const id = octx.createImageData(state.srcW, state.srcH);
  id.data.set(cut.data);
  octx.putImageData(id, 0, 0);

  const url = out.toDataURL('image/png');
  ($('#art') as unknown as SVGImageElement).setAttribute('href', url);
  state.imageDataUrl = url;

  syncBackgroundUi();
}

function syncBackgroundUi(): void {
  const panel = $('#panel-bg');
  if (panel) panel.hidden = state.imageEl === null;
  const review = $('#bg-review');
  if (review) review.hidden = !state.bgReviewing;
  const label = $('#out-bg-state');
  if (label) label.textContent = state.bgOriginal ? 'removed' : 'original';
  const btn = $('#btn-remove-bg') as HTMLButtonElement | null;
  if (btn) btn.textContent = state.bgOriginal ? 'Remove again' : 'Remove background';
  for (const b of document.querySelectorAll<HTMLButtonElement>('.bg-mode')) {
    b.classList.toggle('active', b.dataset.mode === state.bgMode);
  }
  document.body.classList.toggle('is-refining-bg', state.bgReviewing);
}

/** Put the artwork back exactly as it was opened. */
function undoBackground(): void {
  if (!state.bgOriginal) return;
  ($('#art') as unknown as SVGImageElement).setAttribute('href', state.bgOriginal);
  state.imageDataUrl = state.bgOriginal;
  state.bgOriginal = null;
  state.bgMatte = null;
  state.bgStrokes = [];
  state.bgReviewing = false;
  syncBackgroundUi();
  rebuildEngineFromCanvas();
  toast('Background restored.', 'info', 3000);
}

/**
 * Rebuild the tracer from the artwork currently on the canvas.
 *
 * A cutout has a real alpha channel, so the mask builder takes its alpha
 * path and traces the cutout edge — which is the whole point: the cut now
 * follows what the user can see rather than a guess about colour.
 */
function rebuildEngineFromCanvas(): void {
  if (!state.imageEl) return;
  const img = new Image();
  img.onload = () => {
    const w = state.srcW;
    const h = state.srcH;
    const workScale = Math.min(1, Math.sqrt(WORK_MAX_PIXELS / (w * h)));
    const ww = Math.max(1, Math.round(w * workScale));
    const wh = Math.max(1, Math.round(h * workScale));
    const c = document.createElement('canvas');
    c.width = ww;
    c.height = wh;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, ww, wh);
    ctx.drawImage(img, 0, 0, ww, wh);
    const work = ctx.getImageData(0, 0, ww, wh);
    state.engine = new CutlineEngine(work, ww / w);
    state.workImg = work;
    state.workScale = ww / w;
    // The neural engine was built from the pre-cutout image; it no longer
    // describes what is on screen.
    state.aiEngine = null;
    state.useAi = false;
    const aiCheck = $('#in-ai') as HTMLInputElement | null;
    if (aiCheck) aiCheck.checked = false;
    redrawCheckboxes();
    recompute(true);
  };
  img.src = state.imageDataUrl;
}

$('#btn-remove-bg').addEventListener('click', () => void removeBackground());

$('#btn-bg-keep').addEventListener('click', () => {
  state.bgReviewing = false;
  syncBackgroundUi();
  rebuildEngineFromCanvas();
  toast('Background removed.', 'success', 3000);
});

$('#btn-bg-undo').addEventListener('click', undoBackground);

for (const b of document.querySelectorAll<HTMLButtonElement>('.bg-mode')) {
  b.addEventListener('click', () => {
    state.bgMode = (b.dataset.mode as 'drop' | 'keep') ?? 'drop';
    syncBackgroundUi();
  });
}

bindSlider('#in-bg-brush', '#out-bg-brush', (v) => `${v} px`, (v) => {
  state.bgBrush = v;
});

$('#btn-reset').addEventListener('click', () => resetAllSettings());

// Replaying the tour switches to Simple first: every step points at a Simple
// control, and running it from Advanced would highlight things that are not
// on screen — which the step filter would then drop, leaving a shorter and
// more confusing tour than the one the button promises.
$('#btn-help').addEventListener('click', () => {
  setMode('simple');
  void createTour().run();
});

// Advanced is four sections deep and most jobs touch one of them. Each
// heading collapses its own body so the rail can be narrowed to the section
// in hand. Toggling `hidden` on the body rather than a class keeps the
// collapsed controls out of the accessibility tree as well as out of view.
for (const toggle of document.querySelectorAll<HTMLButtonElement>('.group-toggle')) {
  const body = toggle.closest('.group')?.querySelector<HTMLElement>('.group-body');
  if (!body) continue;
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    body.hidden = open;
  });
}

// Two ways into the same four presets: drag the slider, or click a stop by
// name. The slider's own handler is passed to the mount in
// syncPresetSelection(); this is the by-name path.
for (const btn of document.querySelectorAll<HTMLButtonElement>('.cutstop')) {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset as PresetId));
}

// The two "cut interior holes" checkboxes are one setting shown twice.
$('#in-holes-simple').addEventListener('change', (e) => {
  state.params.keepHoles = (e.target as HTMLInputElement).checked;
  ($('#in-holes') as HTMLInputElement).checked = state.params.keepHoles;
  redrawCheckboxes();
  recompute(true);
});

/* ---------------- account ---------------- */

/** The account page, served by this same app. */
const ACCOUNT_URL = '/account';

/**
 * Sign in, then show what that bought.
 *
 * Every entry point that discovers it needs an account ends the same way: the
 * popup closes, the balance is fetched, and the pill has to stop saying "Sign
 * in". Sharing it keeps those paths from drifting — one of them silently not
 * refreshing the balance is the kind of bug that looks like a failed sign-in.
 */
async function signInThenRefresh(): Promise<void> {
  const outcome = await promptSignIn(signupGrant);
  if (outcome !== 'signed-in') return;
  // The popup, the session check and the balance fetch are several seconds
  // between the click and anything visible changing.
  jobStart(null, 'loading');
  try {
    state.balance = await fetchBalance();
    renderBalance();
  } finally {
    jobEnd();
  }
  if (state.balance !== null) {
    toast(`Signed in · ${state.balance} credits`, 'success', 4000);
  }
}

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
    // Swaps the live-state dot for a person, and drops the mono number
    // styling that a balance wants and a prompt does not.
    el.classList.add('is-signed-out');
    return;
  }
  el.classList.remove('is-signed-out');
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
//
// The overlay is on a grace timer rather than shown outright: this request is
// usually tens of milliseconds, and a splash that flashes up and vanishes
// makes a fast app feel slower than one that simply appeared ready. It only
// takes over the screen if the wait is long enough to be worth explaining.
{
  // The splash is decoration over a live app, not a gate in front of one.
  // The request goes out immediately and the result is applied the moment it
  // lands — the balance must not wait on an animation, or the studio is
  // genuinely slower than it was for the sake of looking faster.
  let settled = false;
  const balance = fetchBalance().then((b) => {
    state.balance = b;
    renderBalance();
    settled = true;
  });

  // Once per session — a brand moment on every navigation is a tax on the
  // people who use this all day.
  const intro = splashSeen() ? Promise.resolve() : createSplash().play();

  // The boot cover is a black square with no way out of its own: if the
  // splash never appends (seen already, an exception on the way there), it
  // would sit over a working studio forever. Clearing it here means the only
  // way to be stuck behind it is for this module never to run at all — at
  // which point there is no studio underneath to be stuck in front of.
  document.documentElement.classList.remove('is-booting');

  void intro.then(() => {
    // Usually the answer arrived while the light was crossing the wordmark,
    // and there is nothing left to wait for.
    if (settled) return;

    let close: (() => void) | null = null;
    // The overlay is on a grace timer rather than shown outright: this
    // request is usually tens of milliseconds, and a screen that flashes up
    // and vanishes makes a fast app feel slower than one that simply
    // appeared ready. It only takes over if the wait is worth explaining.
    const grace = window.setTimeout(() => {
      close = showLoading('Loading your workspace');
    }, 400);

    void balance.finally(() => {
      clearTimeout(grace);
      close?.();
    });
  });

  // Coming back from checkout.
  //
  // Credits are granted by the webhook, not by the redirect, so the balance
  // in hand may predate the payment by a second or two. Rather than claim a
  // number we cannot vouch for, poll briefly for it to move and say which
  // happened. The URL is cleaned either way so a refresh does not re-announce
  // a purchase that already landed.
  // Sent here by /checkout because there was nobody signed in to attach a
  // purchase to. Open the sheet that actually works, and resume the purchase
  // once they are through it.
  const params = new URLSearchParams(location.search);
  if (params.get('signin') === '1') {
    const wanted = params.get('pack');
    history.replaceState(null, '', location.pathname);
    void promptSignIn(signupGrant).then((outcome) => {
      if (outcome !== 'signed-in') return;
      if (wanted) window.location.href = `/checkout?pack=${encodeURIComponent(wanted)}`;
      else void signInThenRefresh();
    });
  }

  const returned = params.get('purchase');
  if (returned === 'success') {
    history.replaceState(null, '', location.pathname);
    void balance.then(async () => {
      const before = state.balance ?? 0;
      for (let i = 0; i < 10; i++) {
        const now = await fetchBalance();
        if (now !== null && now > before) {
          state.balance = now;
          renderBalance();
          toast(`Payment received · ${now} credits`, 'success', 5000);
          return;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      // Twelve seconds without the balance moving. The payment is almost
      // certainly fine — Whop retries for ~71 hours — so this reassures
      // rather than alarms.
      toast(
        'Payment received. Your credits will appear here shortly.',
        'info',
        8000
      );
    });
  }

  // The tour waits for both the splash and the balance: starting it while the
  // loading overlay is still up would put a bubble on top of a screen that is
  // about to change, and the last step points at the credit pill, which is
  // still showing a placeholder until the balance lands.
  void Promise.all([intro, balance.catch(() => {})]).then(() => {
    if (tourSeen()) return;
    // A first-time visitor has no artwork open, so the steps that need one
    // are filtered out by the tour itself. What is left is the shape of the
    // job, which is exactly what someone arriving cold needs.
    void createTour().run();
  });
}

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

  // Signed out the pill reads "Sign in to download", so that is what it must
  // do. It used to open the credits dialog either way, which signed out is a
  // dead end: nothing there can be bought without an account, so the control
  // named an action and then offered no way to take it.
  if (state.balance === null) {
    void signInThenRefresh();
    return;
  }

  void openCredits(() => {
    // Signing out from the dialog: reflect it here without a reload.
    state.balance = null;
    renderBalance();
    // A bare POST here answered 302 and changed nothing: Auth.js needs a CSRF
    // token to actually clear the cookie and delete the session row, so the
    // reload simply re-presented the same live session and the user stayed
    // signed in. signOutNow() submits a real form and navigates.
    void signOutNow();
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
async function paidExport(format: PaidFormat, preconfirmed = false) {
  if (!state.result) return;
  // Signed out: ask here rather than sending them away. The loaded artwork
  // and every slider live in this page, so navigating to sign in would throw
  // away the work they just did.
  if (state.balance === null) {
    // null means EITHER signed out OR the page-load balance check has not come
    // back yet. Confirm with the server before accusing someone of being
    // signed out — a fast click would otherwise show the sign-in modal to a
    // user who is already signed in.
    jobStart(null, 'checking');
    try {
      state.balance = await fetchBalance();
      renderBalance();
    } finally {
      jobEnd();
    }
  }
  if (state.balance === null) {
    const outcome = await promptSignIn(signupGrant);
    if (outcome !== 'signed-in') return;

    // Signing in is several seconds of popup, session check and balance
    // fetch. Leaving the screen silent through all of it is what made a
    // successful sign-in look like a hang.
    jobStart(null, 'loading');
    try {
      state.balance = await fetchBalance();
      renderBalance();
    } finally {
      jobEnd();
    }
    // Still signed out — the popup was closed or consent was declined.
    if (state.balance === null) {
      toast('Sign-in was not completed.', 'error', 6000);
      return;
    }
    toast(`Signed in · ${state.balance} credits`, 'success', 4000);
  }

  // Confirm before charging: a click that silently spends money is a support
  // ticket waiting to happen. The export dialog already states the cost and
  // the balance after, so a call that came from there passes `preconfirmed`
  // rather than asking the same question twice.
  if (!preconfirmed && !(await confirmSpend(format, state.balance))) return;
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
          onClick: () => void openCredits(undefined, () => void signInThenRefresh()).then((b) => {
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

/**
 * The rail's one export button: choose a format, then export it.
 *
 * The balance is refreshed before the dialog opens rather than after, because
 * the dialog's whole job is to show what a download will cost and what will
 * be left — stale numbers there would undermine the point of having it.
 */
async function openExportDialog() {
  if (!state.result) return;
  const chosen = await chooseExport(state.balance);
  if (!chosen) return;
  syncExportCaption();
  await paidExport(chosen, true);
}

/** Keep the caption under the export button honest about the saved default. */
function syncExportCaption() {
  const el = $('#export-default');
  if (!el) return;
  const f = defaultFormat();
  el.textContent = f ? `${f} is your default` : 'choose a format';
}

$('#btn-export').addEventListener('click', () => void openExportDialog());
// Same dialog from the top bar: one export path, two places to start it.
$('#btn-export-top').addEventListener('click', () => void openExportDialog());
syncExportCaption();

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
