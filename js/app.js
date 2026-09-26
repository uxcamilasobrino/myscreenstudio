import { GRADIENTS, renderScene, outputSize, layout, cropRect, sourceAspect, zoomRect } from './renderer.js';
import { exportMp4, canExportMp4 } from './exporter.js';

const MAX_SECONDS = 10;
const MIN_CLIP = 0.5;
const MIN_ZOOM = 0.4;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const state = {
  srcW: 1920, srcH: 1080,
  duration: 0,
  trim: { start: 0, end: 0 },
  background: { type: 'gradient', gradient: 0, color: '#111827', image: null },
  padding: 0.08,
  radius: 14,
  shadow: 0.6,
  chrome: 'none',
  bgMode: 'background', // 'background' | 'none' (the recording itself)
  crop: { x: 0, y: 0, w: 1, h: 1 }, // normalized area of the recording to use
  aspect: '16:9',
  zooms: [],          // { id, start, end, scale, x, y }
  zoomRamp: 0.7,
  resolution: 1080,
  fps: 60,
};
let selectedZoomId = null;
let loaded = false;
let sourceUrl = null;
let exportAbort = null;

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const video = $('source');
const preview = $('preview');
const pctx = preview.getContext('2d', { alpha: false });
const tracks = $('tracks');

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (s) => (Math.max(0, s)).toFixed(2);
const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/** Load a URL into a <video> and make sure duration is finite (MediaRecorder WebM files report Infinity). */
async function prepareVideo(v, url, knownDuration) {
  v.src = url;
  v.load();
  await once(v, 'loadedmetadata');
  if (!Number.isFinite(v.duration)) {
    v.currentTime = 1e7;
    await new Promise((resolve) => {
      const check = () => { if (Number.isFinite(v.duration)) { v.removeEventListener('durationchange', check); resolve(); } };
      v.addEventListener('durationchange', check);
      setTimeout(resolve, 3000);
    });
    v.currentTime = 0;
    await once(v, 'seeked');
  }
  const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : knownDuration || 0;
  return d;
}

/* ------------------------------------------------------------------ */
/* Loading a clip                                                      */
/* ------------------------------------------------------------------ */
async function loadClip(blob, knownDuration, crop) {
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(blob);
  video.pause();
  const duration = await prepareVideo(video, sourceUrl, knownDuration);
  if (!duration) { toast('Could not read that video. Try another file.'); return; }
  if (video.readyState < 2) await once(video, 'loadeddata');

  state.duration = duration;
  state.srcW = video.videoWidth || 1920;
  state.srcH = video.videoHeight || 1080;
  state.trim = { start: 0, end: Math.min(duration, MAX_SECONDS) };
  state.crop = crop ? { ...crop } : { x: 0, y: 0, w: 1, h: 1 };
  state.zooms = [];
  selectedZoomId = null;
  loaded = true;
  updateCropInfo();

  if (duration > MAX_SECONDS + 0.01) {
    toast(`Clip is ${duration.toFixed(1)}s — trimmed to the first ${MAX_SECONDS}s. Drag the purple handles to pick a different part.`, 5000);
  }

  $('emptyState').hidden = true;
  $('canvasWrap').hidden = false;
  $('timeline').hidden = false;
  $('btnNew').hidden = false;
  $('btnImportTop').hidden = false;
  $('btnExport').disabled = false;
  $('sidebar').classList.remove('disabled');

  resizePreview();
  renderRuler();
  renderTimeline();
  renderZoomPanel();
  updateExportInfo();
  makeThumbnails(sourceUrl, duration);
}

async function makeThumbnails(url, duration) {
  const box = $('thumbs');
  box.innerHTML = '';
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    await prepareVideo(v, url, duration);
    const n = Math.max(4, Math.min(14, Math.round(tracks.clientWidth / 90)));
    const c = document.createElement('canvas');
    c.height = 96; c.width = Math.round(96 * (v.videoWidth / v.videoHeight || 16 / 9));
    const cx = c.getContext('2d');
    for (let i = 0; i < n; i++) {
      if (url !== sourceUrl) return; // a new clip was loaded
      v.currentTime = Math.min(duration - 0.05, ((i + 0.5) / n) * duration);
      await Promise.race([once(v, 'seeked'), new Promise((r) => setTimeout(r, 1500))]);
      cx.drawImage(v, 0, 0, c.width, c.height);
      const img = new Image();
      img.src = c.toDataURL('image/jpeg', 0.7);
      box.appendChild(img);
    }
    v.removeAttribute('src'); v.load();
  } catch { /* thumbnails are optional */ }
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */
let recorder = null, recTimer = 0, recStream = null;
const liveVideo = document.createElement('video');
liveVideo.muted = true; liveVideo.playsInline = true;

async function startRecording() {
  if (recorder || recStream) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Screen recording is not supported in this browser. Try Chrome, Edge or Firefox on desktop.');
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 }, width: { ideal: 3840 }, height: { ideal: 2160 }, cursor: 'always' },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (e) {
    recStream = null;
    if (e.name !== 'NotAllowedError') toast('Could not start recording: ' + e.message);
    return;
  }
  video.pause();
  recStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (recorder) stopRecording();
    else { closeCrop(); cancelRecording(); }
  });
  liveVideo.srcObject = recStream;
  await liveVideo.play().catch(() => {});
  if (!liveVideo.videoWidth) await once(liveVideo, 'loadedmetadata');

  // Let the user choose the part of the screen to record.
  openCrop({
    mode: 'record',
    source: liveVideo,
    initial: FULL_CROP,
    onConfirm: async (crop) => {
      await countdown(3);
      if (recStream) beginRecording(crop);
    },
    onCancel: cancelRecording,
  });
}

function cancelRecording() {
  recStream?.getTracks().forEach((t) => t.stop());
  recStream = null;
  liveVideo.srcObject = null;
}

function countdown(n) {
  return new Promise((resolve) => {
    const el = $('countdown');
    el.hidden = false;
    let i = n;
    const step = () => {
      if (i === 0 || !recStream) { el.hidden = true; resolve(); return; }
      $('countdownNum').textContent = i;
      document.title = `Recording in ${i}… — MyScreenStudio`;
      i--;
      setTimeout(step, 1000);
    };
    step();
  });
}

function beginRecording(crop) {
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const mimeType = types.find((t) => window.MediaRecorder?.isTypeSupported(t)) || '';
  const chunks = [];
  const stream = recStream;
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 25_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const t0 = performance.now();
  let elapsed = 0;
  recorder.onstop = async () => {
    clearInterval(recTimer);
    stream.getTracks().forEach((t) => t.stop());
    recStream = null;
    liveVideo.srcObject = null;
    $('recPill').hidden = true;
    document.title = 'MyScreenStudio';
    $('emptyState').style.opacity = '';
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    recorder = null;
    if (blob.size) await loadClip(blob, elapsed, crop);
  };

  recorder.start(250);
  $('recPill').hidden = false;
  $('emptyState').style.opacity = loaded ? '' : '0.25';
  recTimer = setInterval(() => {
    elapsed = (performance.now() - t0) / 1000;
    $('recTime').textContent = `${Math.min(elapsed, MAX_SECONDS).toFixed(1)}s`;
    $('recBar').style.width = `${Math.min(100, (elapsed / MAX_SECONDS) * 100)}%`;
    document.title = `● ${Math.max(0, Math.ceil(MAX_SECONDS - elapsed))}s left — MyScreenStudio`;
    if (elapsed >= MAX_SECONDS) stopRecording();
  }, 50);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

/* ------------------------------------------------------------------ */
/* Area selection (crop)                                               */
/* ------------------------------------------------------------------ */
const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };
const CROP_ASPECTS = { free: null, '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3 };
const cropCanvas = $('cropCanvas');
const cctx = cropCanvas.getContext('2d');
let crop = null; // { mode, source, sel, aspect, onConfirm, onCancel }

function openCrop({ mode, source, initial, onConfirm, onCancel }) {
  crop = { mode, source, sel: { ...initial }, aspect: 'free', onConfirm, onCancel };
  $('cropTitle').textContent = mode === 'record' ? 'Select the area to record' : 'Crop the recording';
  $('cropConfirmLabel').textContent = mode === 'record' ? 'Start recording' : 'Apply crop';
  $('btnCropConfirm').querySelector('svg').style.display = mode === 'record' ? '' : 'none';
  $('btnCropFull').textContent = mode === 'record' ? 'Full screen' : 'Reset';
  $('cropOverlay').hidden = false;
  syncCropAspectSeg();
  layoutCrop();
}

function closeCrop() {
  $('cropOverlay').hidden = true;
  crop = null;
}

function cropSrcSize() {
  const s = crop.source;
  return { w: s.videoWidth || 1920, h: s.videoHeight || 1080 };
}

function layoutCrop() {
  if (!crop) return;
  const { w, h } = cropSrcSize();
  const stage = $('cropStage');
  const maxW = stage.clientWidth, maxH = stage.clientHeight;
  const s = Math.min(maxW / w, maxH / h);
  const cw = Math.max(50, Math.floor(w * s)), ch = Math.max(50, Math.floor(h * s));
  const dpr = window.devicePixelRatio || 1;
  cropCanvas.style.width = cw + 'px';
  cropCanvas.style.height = ch + 'px';
  cropCanvas.width = Math.round(cw * dpr);
  cropCanvas.height = Math.round(ch * dpr);
  positionCropBox();
}

function positionCropBox() {
  const { sel } = crop;
  const b = $('cropBox');
  const W = cropCanvas.clientWidth, H = cropCanvas.clientHeight;
  b.style.left = sel.x * W + 'px';
  b.style.top = sel.y * H + 'px';
  b.style.width = sel.w * W + 'px';
  b.style.height = sel.h * H + 'px';
  const { w, h } = cropSrcSize();
  $('cropSize').textContent = `${Math.round(sel.w * w)} × ${Math.round(sel.h * h)}`;
}

function drawCrop() {
  if (!crop) return;
  const s = crop.source;
  if (s.videoWidth) cctx.drawImage(s, 0, 0, cropCanvas.width, cropCanvas.height);
}

function syncCropAspectSeg() {
  $('cropAspectSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === crop.aspect));
}

/** k = normalized height per normalized width for the locked aspect (null if free). */
function cropK() {
  const a = CROP_ASPECTS[crop.aspect];
  if (!a) return null;
  const { w, h } = cropSrcSize();
  return w / (h * a);
}

function minCropN() {
  const { w, h } = cropSrcSize();
  return { w: Math.min(1, 64 / w), h: Math.min(1, 64 / h) };
}

/** Rect from a fixed anchor to a pointer, honoring aspect lock and screen bounds. */
function rectFromAnchor(ax, ay, px, py) {
  const k = cropK();
  const dx = px >= ax ? 1 : -1, dy = py >= ay ? 1 : -1;
  const maxW = dx > 0 ? 1 - ax : ax, maxH = dy > 0 ? 1 - ay : ay;
  const mn = minCropN();
  let w = clamp(Math.abs(px - ax), mn.w, maxW);
  let h = clamp(Math.abs(py - ay), mn.h, maxH);
  if (k) {
    w = Math.max(w, h / k);
    h = w * k;
    if (w > maxW) { w = maxW; h = w * k; }
    if (h > maxH) { h = maxH; w = h / k; }
  }
  return { x: dx > 0 ? ax : ax - w, y: dy > 0 ? ay : ay - h, w, h };
}

function setCropAspect(v) {
  crop.aspect = v;
  syncCropAspectSeg();
  const k = cropK();
  if (!k) return;
  const { sel } = crop;
  const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2;
  // largest rect of that aspect that fits the screen, at 80%, centered on the current selection
  let w = 1, h = k;
  if (h > 1) { h = 1; w = 1 / k; }
  w *= 0.8; h *= 0.8;
  crop.sel = { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
  positionCropBox();
}

$('cropMedia').addEventListener('pointerdown', (e) => {
  if (!crop) return;
  e.preventDefault();
  const r = cropCanvas.getBoundingClientRect();
  const P = (ev) => ({ x: clamp((ev.clientX - r.left) / r.width, 0, 1), y: clamp((ev.clientY - r.top) / r.height, 0, 1) });
  const p0 = P(e);
  const s0 = { ...crop.sel };
  const handle = e.target.dataset.h;
  const inBox = e.target.closest('#cropBox');
  const k = cropK();

  let onMove;
  if (handle) {
    const x2 = s0.x + s0.w, y2 = s0.y + s0.h;
    if (handle.length === 2) {
      // corner: anchor is the opposite corner
      const ax = handle.includes('w') ? x2 : s0.x;
      const ay = handle.includes('n') ? y2 : s0.y;
      onMove = (p) => (crop.sel = rectFromAnchor(ax, ay, p.x, p.y));
    } else {
      const mn = minCropN();
      onMove = (p) => {
        let { x, y, w, h } = s0;
        if (handle === 'e') w = clamp(p.x - x, mn.w, 1 - x);
        if (handle === 'w') { const nx = clamp(p.x, 0, x2 - mn.w); w = x2 - nx; x = nx; }
        if (handle === 's') h = clamp(p.y - y, mn.h, 1 - y);
        if (handle === 'n') { const ny = clamp(p.y, 0, y2 - mn.h); h = y2 - ny; y = ny; }
        if (k) {
          const cx = s0.x + s0.w / 2, cy = s0.y + s0.h / 2;
          if (handle === 'e' || handle === 'w') { h = w * k; if (h > 1) { h = 1; w = h / k; } y = clamp(cy - h / 2, 0, 1 - h); }
          else { w = h / k; if (w > 1) { w = 1; h = w * k; } x = clamp(cx - w / 2, 0, 1 - w); }
          if (handle === 'w') x = x2 - w;
          if (handle === 'n') y = y2 - h;
        }
        crop.sel = { x, y, w, h };
      };
    }
  } else if (inBox) {
    onMove = (p) => {
      crop.sel = { ...s0, x: clamp(s0.x + p.x - p0.x, 0, 1 - s0.w), y: clamp(s0.y + p.y - p0.y, 0, 1 - s0.h) };
    };
  } else {
    // draw a new selection
    onMove = (p) => { crop.sel = rectFromAnchor(p0.x, p0.y, p.x, p.y); };
  }
  drag(e, (ev) => { if (!crop) return; onMove(P(ev)); positionCropBox(); });
});

$('cropAspectSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && crop) setCropAspect(b.dataset.v);
});
$('btnCropFull').addEventListener('click', () => {
  if (!crop) return;
  crop.aspect = 'free';
  syncCropAspectSeg();
  crop.sel = { ...FULL_CROP };
  positionCropBox();
});
$('btnCropCancel').addEventListener('click', () => { const c = crop; closeCrop(); c?.onCancel?.(); });
$('btnCropConfirm').addEventListener('click', () => {
  const c = crop;
  if (!c) return;
  const { sel } = c;
  const isFull = sel.w > 0.995 && sel.h > 0.995;
  closeCrop();
  c.onConfirm(isFull ? { ...FULL_CROP } : { ...sel });
});
new ResizeObserver(() => crop && layoutCrop()).observe($('cropStage'));

function editCrop() {
  if (!loaded) return;
  video.pause();
  openCrop({
    mode: 'edit',
    source: video,
    initial: state.crop,
    onConfirm: (c) => {
      state.crop = c;
      updateCropInfo();
      resizePreview();
      updateExportInfo();
      if (selectedZoomId) renderZoomPanel();
    },
  });
}

function updateCropInfo() {
  const c = state.crop;
  const full = c.w > 0.995 && c.h > 0.995;
  $('cropInfo').textContent = full ? 'Full screen' : `${Math.round(c.w * state.srcW)} × ${Math.round(c.h * state.srcH)} area`;
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */
function resizePreview() {
  const stage = $('canvasWrap');
  const { w, h } = outputSize(state, 1080);
  const dpr = window.devicePixelRatio || 1;
  const maxW = Math.max(200, stage.clientWidth) * dpr;
  const maxH = Math.max(150, stage.clientHeight) * dpr;
  const s = Math.min(1, maxW / w, maxH / h);
  preview.width = Math.round(w * s);
  preview.height = Math.round(h * s);
}

function loop() {
  if (loaded && !exportAbort) {
    if (!video.paused && video.currentTime >= state.trim.end) {
      video.currentTime = state.trim.start;
    }
    const z = focusDrag && selectedZoom();
    renderScene(pctx, state, preview.width, preview.height, video.currentTime, video, { noZoom: !!z });
    if (z) {
      const lay = layout(state, preview.width, preview.height);
      const c = lay.content;
      drawFocusOverlay(pctx, z, c.x, c.y, c.w, c.h, Math.max(1, preview.width / 1000));
    }
    updatePlayhead();
    if (selectedZoomId) drawFocusPicker();
  }
  if (crop) drawCrop();
  requestAnimationFrame(loop);
}

function togglePlay() {
  if (!loaded) return;
  if (video.paused) {
    if (video.currentTime >= state.trim.end - 0.02 || video.currentTime < state.trim.start) video.currentTime = state.trim.start;
    video.play().catch(() => {});
  } else video.pause();
}
video.addEventListener('play', () => { $('icoPlay').hidden = true; $('icoPause').hidden = false; });
video.addEventListener('pause', () => { $('icoPlay').hidden = false; $('icoPause').hidden = true; });

function seek(t) {
  video.currentTime = clamp(t, 0, state.duration);
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */
const pxToTime = (clientX) => {
  const r = tracks.getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * state.duration;
};
const pct = (t) => `${(t / state.duration) * 100}%`;

function renderRuler() {
  const ruler = $('ruler');
  ruler.innerHTML = '';
  const d = state.duration;
  const step = d <= 3 ? 0.5 : d <= 12 ? 1 : d <= 30 ? 5 : d <= 120 ? 10 : 30;
  for (let t = 0; t <= d + 1e-6; t += step) {
    const s = document.createElement('span');
    s.style.left = pct(t);
    s.textContent = `${Number.isInteger(t) ? t : t.toFixed(1)}s`;
    ruler.appendChild(s);
  }
}

function renderTimeline() {
  const { start, end } = state.trim;
  $('shadeL').style.width = pct(start);
  $('shadeR').style.width = pct(state.duration - end);
  $('trimBox').style.left = pct(start);
  $('trimBox').style.width = pct(end - start);
  $('trimLabel').textContent = `Clip ${fmt(end - start)}s · max ${MAX_SECONDS}s`;

  const zt = $('zoomTrack');
  zt.innerHTML = '';
  for (const z of state.zooms) {
    const el = document.createElement('div');
    el.className = 'zoom-seg' + (z.id === selectedZoomId ? ' selected' : '');
    el.style.left = pct(z.start);
    el.style.width = pct(z.end - z.start);
    el.dataset.id = z.id;
    el.innerHTML = `<div class="zh l" data-h="start"></div>
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M11 8v6M8 11h6"/></svg>
      <span>${z.scale.toFixed(1)}×</span>
      <div class="zh r" data-h="end"></div>`;
    zt.appendChild(el);
  }
  updateExportInfo();
}

function updatePlayhead() {
  const t = video.currentTime;
  $('playhead').style.left = `${(t / state.duration) * 100}%`;
  $('timeLabel').textContent = `${fmt(t - state.trim.start)} / ${fmt(state.trim.end - state.trim.start)}`;
}

/** Generic horizontal drag helper. */
function drag(e, onMove, onEnd) {
  e.preventDefault();
  const target = e.currentTarget || e.target;
  target.setPointerCapture?.(e.pointerId);
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onEnd?.(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Scrub by dragging on the ruler / video track
function startScrub(e) {
  if (e.target.classList.contains('trim-handle')) return;
  video.pause();
  seek(pxToTime(e.clientX));
  drag(e, (ev) => seek(pxToTime(ev.clientX)));
}
$('ruler').addEventListener('pointerdown', startScrub);
$('videoTrack').addEventListener('pointerdown', startScrub);

// Trim handles
document.querySelectorAll('.trim-handle').forEach((h) => {
  h.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    video.pause();
    const which = h.dataset.h;
    drag(e, (ev) => {
      const t = pxToTime(ev.clientX);
      if (which === 'start') {
        state.trim.start = clamp(t, Math.max(0, state.trim.end - MAX_SECONDS), state.trim.end - MIN_CLIP);
        seek(state.trim.start);
      } else {
        state.trim.end = clamp(t, state.trim.start + MIN_CLIP, Math.min(state.duration, state.trim.start + MAX_SECONDS));
        seek(state.trim.end - 0.01);
      }
      renderTimeline();
    });
  });
});

// Zoom segments
function neighbors(z) {
  const others = state.zooms.filter((o) => o !== z);
  const prevEnd = Math.max(0, ...others.filter((o) => o.end <= z.start + 1e-6).map((o) => o.end));
  const nextStart = Math.min(state.duration, ...others.filter((o) => o.start >= z.end - 1e-6).map((o) => o.start));
  return { prevEnd, nextStart };
}

$('zoomTrack').addEventListener('pointerdown', (e) => {
  const segEl = e.target.closest('.zoom-seg');
  if (!segEl) { addZoom(pxToTime(e.clientX)); return; }
  const z = state.zooms.find((o) => o.id === segEl.dataset.id);
  selectZoom(z.id);
  const handle = e.target.dataset.h;
  const t0 = pxToTime(e.clientX);
  const orig = { start: z.start, end: z.end };
  const { prevEnd, nextStart } = neighbors(z);
  let moved = false;
  drag(e, (ev) => {
    const dt = pxToTime(ev.clientX) - t0;
    if (Math.abs(dt) > 0.01) moved = true;
    if (handle === 'start') z.start = clamp(orig.start + dt, prevEnd, z.end - MIN_ZOOM);
    else if (handle === 'end') z.end = clamp(orig.end + dt, z.start + MIN_ZOOM, nextStart);
    else {
      const len = orig.end - orig.start;
      z.start = clamp(orig.start + dt, prevEnd, nextStart - len);
      z.end = z.start + len;
    }
    renderTimeline();
  }, () => { if (!moved) seek(Math.max(z.start, Math.min(z.end, t0))); });
});

function addZoom(at = video.currentTime) {
  if (!loaded) return;
  // Find free space starting at `at`
  const sorted = [...state.zooms].sort((a, b) => a.start - b.start);
  if (sorted.some((z) => at >= z.start && at < z.end)) { toast('There is already a zoom here.'); return; }
  const next = sorted.find((z) => z.start >= at);
  let start = at;
  let end = Math.min(at + 2, next ? next.start : state.duration, state.duration);
  if (end - start < MIN_ZOOM) { toast('Not enough room for a zoom here.'); return; }
  const prev = selectedZoom();
  const z = {
    id: Math.random().toString(36).slice(2, 9),
    start, end,
    scale: prev ? prev.scale : 2,
    x: 0.5, y: 0.5,
    pan: false, x2: null, y2: null,
  };
  state.zooms.push(z);
  selectZoom(z.id);
}

function selectedZoom() { return state.zooms.find((z) => z.id === selectedZoomId) || null; }

function selectZoom(id) {
  selectedZoomId = id;
  renderTimeline();
  renderZoomPanel();
}

function deleteZoom() {
  if (!selectedZoomId) return;
  state.zooms = state.zooms.filter((z) => z.id !== selectedZoomId);
  selectZoom(null);
}

/* ------------------------------------------------------------------ */
/* Zoom panel + focus picker                                           */
/* ------------------------------------------------------------------ */
const focusCanvas = $('focusCanvas');
const fctx = focusCanvas.getContext('2d');
let focusDrag = null; // { which: 'a' | 'b' } while dragging on the big preview

function renderZoomPanel() {
  const z = selectedZoom();
  $('zoomEmpty').hidden = !!z;
  $('zoomEditor').hidden = !z;
  preview.classList.toggle('focus-editable', !!z);
  if (!z) return;
  const aspect = sourceAspect(state);
  focusCanvas.width = 560;
  focusCanvas.height = Math.round(560 / aspect);
  setRange('zoomScale', z.scale, (v) => `${(+v).toFixed(1)}×`);
  $('zoomPan').checked = !!z.pan;
  drawFocusPicker();
}

/** Zoom viewport (for focus a or b) in content-normalized coords. */
function viewportNorm(z, which) {
  const out = outputSize(state, 1080);
  const lay = layout(state, out.w, out.h);
  const fx = which === 'b' ? z.x2 : z.x, fy = which === 'b' ? z.y2 : z.y;
  const r = zoomRect(state, out.w, out.h, lay, z.scale, fx, fy);
  return {
    x: (r.x - lay.content.x) / lay.content.w, y: (r.y - lay.content.y) / lay.content.h,
    w: r.w / lay.content.w, h: r.h / lay.content.h,
  };
}

/** Draw zoom viewports + A/B handles over an area (x0,y0,W,H) that shows the recording. */
function drawFocusOverlay(ctx, z, x0, y0, W, H, scale = 1) {
  const views = [viewportNorm(z, 'a')];
  if (z.pan) views.push(viewportNorm(z, 'b'));
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, W, H);
  // dim everything outside the zoomed-in area(s)
  for (const v of views) ctx.rect(x0 + v.x * W, y0 + v.y * H, v.w * W, v.h * H);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill('evenodd');
  ctx.lineWidth = 2.5 * scale;
  views.forEach((v, i) => {
    ctx.setLineDash(i === 1 ? [8 * scale, 6 * scale] : []);
    ctx.strokeStyle = '#f5a524';
    ctx.strokeRect(x0 + v.x * W, y0 + v.y * H, v.w * W, v.h * H);
  });
  ctx.setLineDash([]);
  const pts = [{ x: z.x, y: z.y, l: 'A' }];
  if (z.pan) pts.push({ x: z.x2, y: z.y2, l: 'B' });
  if (z.pan) {
    ctx.beginPath();
    ctx.moveTo(x0 + z.x * W, y0 + z.y * H);
    ctx.lineTo(x0 + z.x2 * W, y0 + z.y2 * H);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2 * scale;
    ctx.stroke();
  }
  for (const p of pts) {
    const px = x0 + p.x * W, py = y0 + p.y * H, r = 11 * scale;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 3 * scale;
    ctx.strokeStyle = '#f5a524';
    ctx.stroke();
    if (z.pan) {
      ctx.fillStyle = '#111';
      ctx.font = `700 ${11 * scale}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.l, px, py + 0.5 * scale);
    }
  }
  ctx.restore();
}

function drawFocusPicker() {
  const z = selectedZoom();
  if (!z) return;
  const W = focusCanvas.width, H = focusCanvas.height;
  const { sx, sy, sw, sh } = cropRect(state);
  fctx.fillStyle = '#000';
  fctx.fillRect(0, 0, W, H);
  if (video.videoWidth) fctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  drawFocusOverlay(fctx, z, 0, 0, W, H, 2);
}

/** Pick which focus handle (a/b) is nearest to a content-normalized point. */
function nearestHandle(z, x, y, aspect) {
  if (!z.pan) return 'a';
  const d = (px, py) => Math.hypot((px - x) * aspect, py - y);
  return d(z.x, z.y) <= d(z.x2, z.y2) ? 'a' : 'b';
}

function setFocus(z, which, x, y) {
  x = clamp(x, 0, 1); y = clamp(y, 0, 1);
  if (which === 'b') { z.x2 = x; z.y2 = y; } else { z.x = x; z.y = y; }
}

/** Show the result of a focus point: jump to where that point is fully zoomed in. */
function seekToFocus(z, which) {
  const ramp = Math.min(state.zoomRamp, (z.end - z.start) / 2);
  seek(which === 'b' ? z.end - ramp - 0.01 : z.start + ramp + 0.01);
}

focusCanvas.addEventListener('pointerdown', (e) => {
  const z = selectedZoom();
  if (!z) return;
  video.pause();
  const r = focusCanvas.getBoundingClientRect();
  const P = (ev) => ({ x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height });
  const p = P(e);
  const which = nearestHandle(z, p.x, p.y, r.width / r.height);
  setFocus(z, which, p.x, p.y);
  seekToFocus(z, which);
  drag(e, (ev) => { const q = P(ev); setFocus(z, which, q.x, q.y); seekToFocus(z, which); });
});

// Drag the focus directly on the big preview (shows the full, un-zoomed view while dragging).
preview.addEventListener('pointerdown', (e) => {
  const z = selectedZoom();
  if (!z || exportAbort) return;
  video.pause();
  const toContent = (ev) => {
    const r = preview.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * preview.width;
    const py = ((ev.clientY - r.top) / r.height) * preview.height;
    const lay = layout(state, preview.width, preview.height);
    return { x: (px - lay.content.x) / lay.content.w, y: (py - lay.content.y) / lay.content.h };
  };
  const p = toContent(e);
  const which = nearestHandle(z, p.x, p.y, sourceAspect(state));
  focusDrag = { which };
  preview.classList.add('focus-dragging');
  setFocus(z, which, p.x, p.y);
  drag(e, (ev) => { const q = toContent(ev); setFocus(z, which, q.x, q.y); }, () => {
    focusDrag = null;
    preview.classList.remove('focus-dragging');
    seekToFocus(z, which);
  });
});

$('zoomPan').addEventListener('change', (e) => {
  const z = selectedZoom();
  if (!z) return;
  z.pan = e.target.checked;
  if (z.pan && z.x2 == null) {
    z.x2 = clamp(z.x + (z.x < 0.6 ? 0.3 : -0.3), 0, 1);
    z.y2 = z.y;
  }
  if (z.pan && z.end - z.start < 1.5) {
    // give panning some room
    const { nextStart } = neighbors(z);
    z.end = Math.min(nextStart, z.start + 2.5);
  }
  renderTimeline();
  seekToFocus(z, z.pan ? 'b' : 'a');
});

/* ------------------------------------------------------------------ */
/* Sidebar controls                                                    */
/* ------------------------------------------------------------------ */
function setRange(id, value, format) {
  const input = $(id);
  input.value = value;
  const fill = ((value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill', `${fill}%`);
  const out = $(id + 'Out');
  if (out && format) out.textContent = format(value);
}

function bindRange(id, key, format, onChange) {
  const input = $(id);
  const apply = () => {
    const v = parseFloat(input.value);
    if (key) state[key] = v;
    setRange(id, v, format);
    onChange?.(v);
  };
  input.addEventListener('input', apply);
  setRange(id, key ? state[key] : input.value, format);
}

function bindSeg(id, get, set) {
  const seg = $(id);
  const sync = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === String(get())));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.v);
    sync();
  });
  sync();
}

function syncBackgroundUI() {
  document.querySelectorAll('.swatch').forEach((s, i) => s.classList.toggle('active', state.background.type === 'gradient' && state.background.gradient === i));
  $('solidColor').parentElement.classList.toggle('active', state.background.type === 'solid');
  $('bgImage').parentElement.classList.toggle('active', state.background.type === 'image');
}

function initSidebar() {
  const sw = $('gradientSwatches');
  GRADIENTS.forEach((g, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = g.name;
    b.setAttribute('aria-label', `${g.name} background`);
    b.style.background = `linear-gradient(${g.angle}deg, ${g.stops.join(', ')})`;
    b.addEventListener('click', () => { state.background.type = 'gradient'; state.background.gradient = i; syncBackgroundUI(); });
    sw.appendChild(b);
  });
  $('solidColor').addEventListener('input', (e) => { state.background.type = 'solid'; state.background.color = e.target.value; syncBackgroundUI(); });
  $('solidColor').addEventListener('click', () => { state.background.type = 'solid'; syncBackgroundUI(); });
  $('bgImage').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => { state.background.type = 'image'; state.background.image = img; syncBackgroundUI(); };
    img.src = URL.createObjectURL(f);
    e.target.value = '';
  });
  syncBackgroundUI();

  bindRange('padding', 'padding', (v) => `${Math.round(v * 100)}%`);
  bindRange('radius', 'radius', (v) => `${v}px`);
  bindRange('shadow', 'shadow', (v) => `${Math.round(v * 100)}%`);
  bindRange('zoomRamp', 'zoomRamp', (v) => `${(+v).toFixed(2)}s`);
  bindRange('zoomScale', null, (v) => `${(+v).toFixed(1)}×`, (v) => {
    const z = selectedZoom();
    if (z) { z.scale = v; renderTimeline(); }
  });

  bindSeg('chromeSeg', () => state.chrome, (v) => { state.chrome = v; });
  bindSeg('bgModeSeg', () => state.bgMode, (v) => { state.bgMode = v; syncBgMode(); });
  syncBgMode();
  bindSeg('aspectSeg', () => state.aspect, (v) => { state.aspect = v; resizePreview(); updateExportInfo(); if (selectedZoomId) renderZoomPanel(); });
  bindSeg('resSeg', () => state.resolution, (v) => { state.resolution = +v; updateExportInfo(); });
  bindSeg('fpsSeg', () => state.fps, (v) => { state.fps = +v; updateExportInfo(); });
}

function syncBgMode() {
  const none = state.bgMode === 'none';
  $('bgOptions').hidden = none;
  $('bgNoneHint').hidden = !none;
  $('framePanel').hidden = none;
  $('canvasPanel').hidden = none;
  if (loaded) { resizePreview(); if (selectedZoomId) renderZoomPanel(); }
  updateExportInfo();
}

function updateExportInfo() {
  const { w, h } = outputSize(state, state.resolution);
  const len = loaded ? `${(state.trim.end - state.trim.start).toFixed(1)}s` : `≤ ${MAX_SECONDS}s`;
  $('exportInfo').textContent = `${w} × ${h} · ${state.fps} fps · ${len} · H.264 MP4`;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */
async function doExport() {
  if (!loaded || exportAbort) return;
  video.pause();
  const modal = $('exportModal');
  modal.hidden = false;
  $('exporting').hidden = false;
  $('exported').hidden = true;
  $('exportFailed').hidden = true;
  $('progressBar').style.width = '0%';
  $('progressText').textContent = '0%';

  exportAbort = new AbortController();
  const t0 = performance.now();
  try {
    const blob = await exportMp4({
      video,
      state,
      signal: exportAbort.signal,
      onProgress: (p) => {
        $('progressBar').style.width = `${p * 100}%`;
        $('progressText').textContent = `${Math.round(p * 100)}%`;
      },
    });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    $('btnDownload').href = url;
    $('btnDownload').download = `myscreenstudio-${stamp}.mp4`;
    $('resultVideo').src = url;
    $('resultVideo').play().catch(() => {});
    const { w, h } = outputSize(state, state.resolution);
    $('resultInfo').textContent = `${w} × ${h} · ${state.fps} fps · ${(state.trim.end - state.trim.start).toFixed(1)}s · ${(blob.size / 1e6).toFixed(1)} MB · rendered in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    $('exporting').hidden = true;
    $('exported').hidden = false;
  } catch (e) {
    if (e.name === 'AbortError') { modal.hidden = true; }
    else {
      console.error(e);
      $('errorText').textContent = e.message || String(e);
      $('exporting').hidden = true;
      $('exportFailed').hidden = false;
    }
  } finally {
    exportAbort = null;
    video.currentTime = state.trim.start;
  }
}

function closeModal() {
  $('exportModal').hidden = true;
  const v = $('resultVideo');
  v.pause();
}

/* ------------------------------------------------------------------ */
/* File import + drag & drop                                           */
/* ------------------------------------------------------------------ */
function importFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|mkv|m4v)$/i.test(file.name)) {
    toast('Please choose a video file.');
    return;
  }
  loadClip(file);
}

document.querySelectorAll('input.file-input[accept="video/*"]').forEach((inp) => {
  inp.addEventListener('change', (e) => { importFile(e.target.files[0]); e.target.value = ''; });
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('dropOverlay').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  importFile(e.dataTransfer.files[0]);
});

/* ------------------------------------------------------------------ */
/* Wire up                                                             */
/* ------------------------------------------------------------------ */
$('btnRecord').addEventListener('click', startRecording);
$('btnNew').addEventListener('click', startRecording);
$('btnStop').addEventListener('click', stopRecording);
$('btnEditCrop').addEventListener('click', editCrop);
$('btnPlay').addEventListener('click', togglePlay);
$('btnAddZoom').addEventListener('click', () => addZoom());
$('btnDeleteZoom').addEventListener('click', deleteZoom);
$('btnExport').addEventListener('click', doExport);
$('btnCancelExport').addEventListener('click', () => exportAbort?.abort());
$('btnCloseModal').addEventListener('click', closeModal);
$('btnCloseError').addEventListener('click', closeModal);

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') && e.target.type !== 'range') return;
  if (crop) { if (e.key === 'Escape') $('btnCropCancel').click(); else if (e.key === 'Enter') $('btnCropConfirm').click(); return; }
  if (!$('exportModal').hidden) { if (e.key === 'Escape' && !exportAbort) closeModal(); return; }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'z' || e.key === 'Z') addZoom();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedZoomId) { e.preventDefault(); deleteZoom(); }
  else if (e.key === 'Escape') selectZoom(null);
  else if (e.key === 'ArrowLeft') { video.pause(); seek(video.currentTime - 1 / 30); }
  else if (e.key === 'ArrowRight') { video.pause(); seek(video.currentTime + 1 / 30); }
});

new ResizeObserver(() => loaded && resizePreview()).observe($('stage'));

// Compatibility notes
const issues = [];
if (!navigator.mediaDevices?.getDisplayMedia) issues.push('screen recording');
if (!canExportMp4()) issues.push('MP4 export');
if (issues.length) {
  const w = $('compatWarn');
  w.hidden = false;
  w.textContent = `Heads up: this browser doesn't support ${issues.join(' or ')}. Use a recent desktop Chrome, Edge or Safari for the full experience.`;
}

$('sidebar').classList.add('disabled');
initSidebar();
updateExportInfo();
requestAnimationFrame(loop);

// Handy for debugging / automated tests
window.__mss = { state, loadClip, doExport };
