import { GRADIENTS, renderScene, outputSize, layout } from './renderer.js';
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
async function loadClip(blob, knownDuration) {
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
  state.zooms = [];
  selectedZoomId = null;
  loaded = true;

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

async function startRecording() {
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
    if (e.name !== 'NotAllowedError') toast('Could not start recording: ' + e.message);
    return;
  }

  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const mimeType = types.find((t) => window.MediaRecorder?.isTypeSupported(t)) || '';
  const chunks = [];
  recorder = new MediaRecorder(recStream, { mimeType, videoBitsPerSecond: 25_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const t0 = performance.now();
  let elapsed = 0;
  recorder.onstop = async () => {
    clearInterval(recTimer);
    recStream.getTracks().forEach((t) => t.stop());
    $('recPill').hidden = true;
    document.title = 'MyScreenStudio';
    $('emptyState').style.opacity = '';
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    recorder = null;
    if (blob.size) await loadClip(blob, elapsed);
  };
  recStream.getVideoTracks()[0].addEventListener('ended', stopRecording);

  recorder.start(250);
  $('recPill').hidden = false;
  $('emptyState').style.opacity = loaded ? '' : '0.25';
  recTimer = setInterval(() => {
    elapsed = (performance.now() - t0) / 1000;
    $('recTime').textContent = `${Math.min(elapsed, MAX_SECONDS).toFixed(1)}s`;
    $('recBar').style.width = `${Math.min(100, (elapsed / MAX_SECONDS) * 100)}%`;
    document.title = `● ${Math.ceil(MAX_SECONDS - elapsed)}s left — MyScreenStudio`;
    if (elapsed >= MAX_SECONDS) stopRecording();
  }, 50);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
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
    renderScene(pctx, state, preview.width, preview.height, video.currentTime, video);
    updatePlayhead();
    if (selectedZoomId) drawFocusPicker();
  }
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

function renderZoomPanel() {
  const z = selectedZoom();
  $('zoomEmpty').hidden = !!z;
  $('zoomEditor').hidden = !z;
  if (!z) return;
  const aspect = state.srcW / state.srcH || 16 / 9;
  focusCanvas.width = 560;
  focusCanvas.height = Math.round(560 / aspect);
  setRange('zoomScale', z.scale, (v) => `${(+v).toFixed(1)}×`);
  drawFocusPicker();
}

function drawFocusPicker() {
  const z = selectedZoom();
  if (!z) return;
  const W = focusCanvas.width, H = focusCanvas.height;
  fctx.drawImage(video, 0, 0, W, H);

  // Visible region at full zoom, expressed in video (content) coordinates
  const out = outputSize(state, 1080);
  const lay = layout(state, out.w, out.h);
  const vw = out.w / z.scale, vh = out.h / z.scale;
  const cx = lay.content.x + z.x * lay.content.w, cy = lay.content.y + z.y * lay.content.h;
  const rx = clamp(cx - vw / 2, 0, out.w - vw), ry = clamp(cy - vh / 2, 0, out.h - vh);
  const x0 = ((rx - lay.content.x) / lay.content.w) * W;
  const y0 = ((ry - lay.content.y) / lay.content.h) * H;
  const w0 = (vw / lay.content.w) * W, h0 = (vh / lay.content.h) * H;

  fctx.save();
  fctx.fillStyle = 'rgba(0,0,0,0.55)';
  fctx.beginPath();
  fctx.rect(0, 0, W, H);
  fctx.rect(x0, y0, w0, h0);
  fctx.fill('evenodd');
  fctx.strokeStyle = '#f5a524';
  fctx.lineWidth = 3;
  fctx.strokeRect(x0, y0, w0, h0);
  fctx.beginPath();
  fctx.arc(z.x * W, z.y * H, 9, 0, Math.PI * 2);
  fctx.fillStyle = '#fff';
  fctx.fill();
  fctx.lineWidth = 3;
  fctx.stroke();
  fctx.restore();
}

focusCanvas.addEventListener('pointerdown', (e) => {
  const set = (ev) => {
    const z = selectedZoom();
    if (!z) return;
    const r = focusCanvas.getBoundingClientRect();
    z.x = clamp((ev.clientX - r.left) / r.width, 0, 1);
    z.y = clamp((ev.clientY - r.top) / r.height, 0, 1);
    // jump the playhead inside the zoom so you can see the result
    if (video.currentTime < z.start || video.currentTime > z.end) seek((z.start + z.end) / 2);
  };
  set(e);
  drag(e, set);
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
  bindSeg('aspectSeg', () => state.aspect, (v) => { state.aspect = v; resizePreview(); updateExportInfo(); if (selectedZoomId) renderZoomPanel(); });
  bindSeg('resSeg', () => state.resolution, (v) => { state.resolution = +v; updateExportInfo(); });
  bindSeg('fpsSeg', () => state.fps, (v) => { state.fps = +v; updateExportInfo(); });
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
$('btnPlay').addEventListener('click', togglePlay);
$('btnAddZoom').addEventListener('click', () => addZoom());
$('btnDeleteZoom').addEventListener('click', deleteZoom);
$('btnExport').addEventListener('click', doExport);
$('btnCancelExport').addEventListener('click', () => exportAbort?.abort());
$('btnCloseModal').addEventListener('click', closeModal);
$('btnCloseError').addEventListener('click', closeModal);

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') && e.target.type !== 'range') return;
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
