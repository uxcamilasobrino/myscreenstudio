/**
 * Scene renderer — draws one frame of the composition (background,
 * framed + shadowed recording, optional window chrome, animated zoom).
 * The same function powers the live preview and the MP4 export.
 */

export const GRADIENTS = [
  { name: 'Aurora',   angle: 135, stops: ['#7F5AF0', '#2CB1BC'] },
  { name: 'Sunset',   angle: 135, stops: ['#FF7E5F', '#FEB47B'] },
  { name: 'Ocean',    angle: 160, stops: ['#1A2980', '#26D0CE'] },
  { name: 'Peach',    angle: 120, stops: ['#FFDEE9', '#B5FFFC'] },
  { name: 'Grape',    angle: 145, stops: ['#41295A', '#2F0743'] },
  { name: 'Lime',     angle: 135, stops: ['#D4FC79', '#96E6A1'] },
  { name: 'Candy',    angle: 135, stops: ['#F857A6', '#FF5858'] },
  { name: 'Midnight', angle: 160, stops: ['#0F2027', '#203A43', '#2C5364'] },
  { name: 'Dusk',     angle: 135, stops: ['#355C7D', '#6C5B7B', '#C06C84'] },
  { name: 'Mint',     angle: 135, stops: ['#43E97B', '#38F9D7'] },
  { name: 'Sky',      angle: 180, stops: ['#A1C4FD', '#C2E9FB'] },
  { name: 'Graphite', angle: 160, stops: ['#232526', '#414345'] },
];

export const ASPECTS = {
  auto: null,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3,
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Output size for a given aspect + target height (always even numbers). */
export function outputSize(state, targetShort = 1080) {
  const srcAspect = state.srcW && state.srcH ? state.srcW / state.srcH : 16 / 9;
  const a = ASPECTS[state.aspect] ?? srcAspect;
  let w, h;
  if (a >= 1) { h = targetShort; w = h * a; } else { w = targetShort; h = w / a; }
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { w: even(w), h: even(h) };
}

/** Where the recording sits inside a W×H scene (before zoom). */
export function layout(state, W, H) {
  const unit = Math.min(W, H) / 1080;
  const pad = state.padding * Math.min(W, H);
  const chromeH = state.chrome !== 'none' ? Math.round(34 * unit) : 0;
  const availW = W - pad * 2;
  const availH = H - pad * 2 - chromeH;
  const srcAspect = state.srcW / state.srcH || 16 / 9;
  let cw = availW, ch = availW / srcAspect;
  if (ch > availH) { ch = availH; cw = ch * srcAspect; }
  const fx = (W - cw) / 2;
  const fy = (H - (ch + chromeH)) / 2;
  return {
    unit,
    chromeH,
    frame: { x: fx, y: fy, w: cw, h: ch + chromeH },         // whole window (chrome + video)
    content: { x: fx, y: fy + chromeH, w: cw, h: ch },        // the video itself
  };
}

/** Zoom amount (0..1) and the active zoom segment at time t (seconds, source time). */
export function zoomAt(state, t) {
  let best = null, bestP = 0;
  for (const z of state.zooms) {
    if (t < z.start || t > z.end) continue;
    const len = z.end - z.start;
    const ramp = Math.min(state.zoomRamp, len / 2);
    let p = 1;
    if (t < z.start + ramp) p = (t - z.start) / ramp;
    else if (t > z.end - ramp) p = (z.end - t) / ramp;
    p = easeInOutCubic(clamp(p, 0, 1));
    if (p > bestP) { bestP = p; best = z; }
  }
  return { zoom: best, p: bestP };
}

/** Camera view rect in scene space for time t. */
export function cameraAt(state, W, H, t, lay = layout(state, W, H)) {
  const { zoom, p } = zoomAt(state, t);
  const full = { x: 0, y: 0, w: W, h: H };
  if (!zoom || p <= 0) return full;
  const vw = W / zoom.scale, vh = H / zoom.scale;
  const cx = lay.content.x + zoom.x * lay.content.w;
  const cy = lay.content.y + zoom.y * lay.content.h;
  const target = {
    x: clamp(cx - vw / 2, 0, W - vw),
    y: clamp(cy - vh / 2, 0, H - vh),
    w: vw, h: vh,
  };
  return {
    x: lerp(full.x, target.x, p), y: lerp(full.y, target.y, p),
    w: lerp(full.w, target.w, p), h: lerp(full.h, target.h, p),
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBackground(ctx, state, W, H) {
  const bg = state.background;
  if (bg.type === 'solid') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  if (bg.type === 'image' && bg.image && bg.image.complete && bg.image.naturalWidth) {
    const img = bg.image;
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
    ctx.drawImage(img, (W - iw) / 2, (H - ih) / 2, iw, ih);
    return;
  }
  const g = GRADIENTS[bg.gradient] || GRADIENTS[0];
  const rad = ((g.angle - 90) * Math.PI) / 180;
  const len = Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad));
  const dx = (Math.cos(rad) * len) / 2, dy = (Math.sin(rad) * len) / 2;
  const grad = ctx.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy);
  g.stops.forEach((c, i) => grad.addColorStop(i / (g.stops.length - 1), c));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function drawChrome(ctx, state, lay) {
  const { frame, chromeH, unit } = lay;
  const dark = state.chrome === 'dark';
  ctx.fillStyle = dark ? '#2a2a2e' : '#ececef';
  ctx.fillRect(frame.x, frame.y, frame.w, chromeH);
  ctx.fillStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
  ctx.fillRect(frame.x, frame.y + chromeH - Math.max(1, unit), frame.w, Math.max(1, unit));
  const colors = ['#FF5F57', '#FEBC2E', '#28C840'];
  const r = 6.5 * unit;
  colors.forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(frame.x + 20 * unit + i * 21 * unit, frame.y + chromeH / 2, r, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
}

/**
 * Draw one frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} state  editor state
 * @param {number} W,H    canvas size in px
 * @param {number} t      source time (s) — used for zoom animation
 * @param {CanvasImageSource} source  the video element / frame
 */
export function renderScene(ctx, state, W, H, t, source) {
  const lay = layout(state, W, H);
  const cam = cameraAt(state, W, H, t, lay);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, W, H);

  // Camera (zoom) transform
  ctx.scale(W / cam.w, H / cam.h);
  ctx.translate(-cam.x, -cam.y);

  drawBackground(ctx, state, W, H);

  const { frame, content, unit } = lay;
  const radius = state.radius * unit;

  // Shadow
  if (state.shadow > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.25 + state.shadow * 0.45})`;
    ctx.shadowBlur = (20 + state.shadow * 80) * unit;
    ctx.shadowOffsetY = (6 + state.shadow * 24) * unit;
    roundRectPath(ctx, frame.x, frame.y, frame.w, frame.h, radius);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }

  // Window (clip to rounded frame)
  ctx.save();
  roundRectPath(ctx, frame.x, frame.y, frame.w, frame.h, radius);
  ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
  if (state.chrome !== 'none') drawChrome(ctx, state, lay);
  if (source && (source.videoWidth || source.width)) {
    ctx.drawImage(source, content.x, content.y, content.w, content.h);
  }
  ctx.restore();

  // Subtle inner border for crispness
  if (state.radius > 0 || state.chrome !== 'none') {
    ctx.save();
    roundRectPath(ctx, frame.x + 0.5, frame.y + 0.5, frame.w - 1, frame.h - 1, radius);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = Math.max(1, unit);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}
