/**
 * MP4 exporter — plays the trimmed clip once, renders every output frame
 * through the scene renderer and encodes it with WebCodecs (H.264).
 */
import { Mp4Muxer } from './mp4-muxer.js';
import { renderScene, outputSize } from './renderer.js';

const CODECS = [
  'avc1.640034', // High @ 5.2
  'avc1.640033', // High @ 5.1
  'avc1.64002A', // High @ 4.2
  'avc1.640028', // High @ 4.0
  'avc1.4D0033', // Main @ 5.1
  'avc1.4D0028', // Main @ 4.0
  'avc1.42E033', // Baseline @ 5.1
  'avc1.42E01F', // Baseline @ 3.1
];

export function canExportMp4() {
  return typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';
}

async function pickConfig(width, height, fps) {
  const bitrate = Math.round(width * height * fps * 0.12); // ~15 Mbps for 1080p60
  for (const codec of CODECS) {
    for (const hardwareAcceleration of ['no-preference', 'prefer-software']) {
      const cfg = { codec, width, height, bitrate, framerate: fps, hardwareAcceleration, latencyMode: 'quality', avc: { format: 'avc' } };
      try {
        const res = await VideoEncoder.isConfigSupported(cfg);
        if (res.supported) return res.config || cfg;
      } catch { /* try next */ }
    }
  }
  throw new Error('This browser cannot encode H.264 video. Try the latest Chrome, Edge or Safari.');
}

const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));

/**
 * @param {object} opts
 * @param {HTMLVideoElement} opts.video
 * @param {object} opts.state
 * @param {(p:number)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Blob>}
 */
export async function exportMp4({ video, state, onProgress = () => {}, signal }) {
  if (!canExportMp4()) throw new Error('WebCodecs is not available in this browser. Use a recent Chrome, Edge or Safari.');

  const fps = state.fps;
  const { w: W, h: H } = outputSize(state, state.resolution);
  const config = await pickConfig(W, H, fps);

  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d', { alpha: false });

  const muxer = new Mp4Muxer({ width: W, height: H });
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  encoder.configure(config);

  const { start, end } = state.trim;
  const total = Math.max(1, Math.round((end - start) * fps));
  const frameDur = 1e6 / fps;
  let frameIndex = 0;

  const wasMuted = video.muted, wasRate = video.playbackRate;
  video.pause();
  video.muted = true;
  video.playbackRate = 1;
  video.currentTime = start;
  await once(video, 'seeked');

  const emit = (upTo) => {
    while (frameIndex < total && frameIndex <= upTo) {
      const t = start + frameIndex / fps;
      renderScene(ctx, state, W, H, t, video);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(frameIndex * frameDur), duration: Math.round(frameDur) });
      encoder.encode(frame, { keyFrame: frameIndex % (fps * 2) === 0 });
      frame.close();
      frameIndex++;
    }
    onProgress(frameIndex / total);
  };

  await new Promise((resolve, reject) => {
    let raf = 0, done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      video.pause();
      err ? reject(err) : resolve();
    };
    const onVis = () => {
      // rAF stops in hidden tabs — pause playback so no frames are skipped.
      if (document.hidden) video.pause();
      else { video.play().catch(() => {}); lastTick = 0; tick(); }
    };
    let lastTick = 0, rate = 1;
    const tick = () => {
      if (done) return;
      if (signal?.aborted) return finish(new DOMException('Export cancelled', 'AbortError'));
      if (encodeError) return finish(encodeError);

      const t = video.currentTime;
      const reachedEnd = video.ended || t >= end - 1e-3;
      // Emit every output frame whose time has been reached by playback.
      emit(reachedEnd ? total : Math.floor((t - start) * fps));
      if (frameIndex >= total) return finish();

      // Adaptive speed: slow playback down on slower machines so the video never
      // runs ahead of the renderer (keeps every output frame in sync with its source).
      const now = performance.now();
      if (lastTick) {
        const dt = now - lastTick;
        const target = Math.min(1, Math.max(0.1, ((1000 / fps) / dt) * 0.85));
        rate = rate * 0.6 + target * 0.4;
        if (Math.abs(video.playbackRate - rate) > 0.04) video.playbackRate = rate;
      }
      lastTick = now;

      // Back-pressure: let the encoder catch up on slower machines.
      if (encoder.encodeQueueSize > 6) { if (!video.paused) video.pause(); }
      else if (video.paused && !reachedEnd && !document.hidden) video.play().catch(() => {});

      raf = requestAnimationFrame(tick);
    };
    document.addEventListener('visibilitychange', onVis);
    video.play().then(() => { raf = requestAnimationFrame(tick); }).catch(finish);
  });

  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;

  video.muted = wasMuted;
  video.playbackRate = wasRate;
  onProgress(1);
  return muxer.finalize();
}
