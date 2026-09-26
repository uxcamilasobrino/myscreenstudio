/**
 * Tiny, dependency-free MP4 muxer for a single H.264 video track.
 *
 * Feed it the EncodedVideoChunks produced by a WebCodecs VideoEncoder
 * (configured with the default `avc: { format: 'avc' }`), then call
 * `finalize()` to get a fast-start .mp4 Blob (moov before mdat).
 */

const enc = new TextEncoder();

function u8(n) { return [n & 0xff]; }
function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }
function u32(n) { return [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }
function fourcc(s) { return Array.from(enc.encode(s)); }
function fixed16_16(n) { return u32(Math.round(n * 65536)); }

const MATRIX = [
  ...u32(0x00010000), ...u32(0), ...u32(0),
  ...u32(0), ...u32(0x00010000), ...u32(0),
  ...u32(0), ...u32(0), ...u32(0x40000000),
];

/** Build a box from a type and a list of byte arrays / Uint8Arrays. */
function box(type, ...parts) {
  let size = 8;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  out.set(u32(size), 0);
  out.set(fourcc(type), 4);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function fullBox(type, version, flags, ...parts) {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...parts);
}

export class Mp4Muxer {
  /**
   * @param {{width:number,height:number,timescale?:number}} opts
   */
  constructor({ width, height, timescale = 90000 }) {
    this.width = width;
    this.height = height;
    this.timescale = timescale;
    this.samples = []; // { data: Uint8Array, ts: µs, dur: µs, key: bool }
    this.avcC = null;
  }

  /**
   * @param {EncodedVideoChunk} chunk
   * @param {EncodedVideoChunkMetadata} [meta]
   */
  addVideoChunk(chunk, meta) {
    if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.avcC) {
      const d = meta.decoderConfig.description;
      this.avcC = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0))
        : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.samples.push({ data, ts: chunk.timestamp, dur: chunk.duration || 0, key: chunk.type === 'key' });
  }

  finalize() {
    if (!this.samples.length) throw new Error('No video frames were encoded.');
    if (!this.avcC) throw new Error('Encoder did not provide an AVC decoder configuration.');

    const s = this.samples.sort((a, b) => a.ts - b.ts);
    const ts = this.timescale;
    const t0 = s[0].ts;

    // Sample durations in track timescale (derived from timestamps so rounding never drifts).
    const toTs = (us) => Math.round(((us - t0) * ts) / 1e6);
    const deltas = s.map((x, i) => {
      if (i < s.length - 1) return toTs(s[i + 1].ts) - toTs(x.ts);
      return Math.max(1, Math.round((x.dur * ts) / 1e6) || Math.round(ts / 30));
    });
    const trackDuration = deltas.reduce((a, b) => a + b, 0);
    const movieDuration = Math.round((trackDuration * 1000) / ts);

    // stts (run-length encoded deltas)
    const stts = [];
    for (const d of deltas) {
      const last = stts[stts.length - 1];
      if (last && last[1] === d) last[0]++;
      else stts.push([1, d]);
    }

    const keyIdx = [];
    s.forEach((x, i) => { if (x.key) keyIdx.push(i + 1); });

    const mdatSize = 8 + s.reduce((a, x) => a + x.data.length, 0);

    const build = (chunkOffset) => {
      const avc1 = box('avc1',
        [0, 0, 0, 0, 0, 0], u16(1),            // reserved, data_reference_index
        u16(0), u16(0), u32(0), u32(0), u32(0), // pre_defined / reserved
        u16(this.width), u16(this.height),
        u32(0x00480000), u32(0x00480000),       // 72 dpi
        u32(0), u16(1),                          // reserved, frame_count
        new Uint8Array(32),                      // compressorname
        u16(0x0018), u16(0xffff),                // depth, pre_defined
        box('avcC', this.avcC),
        box('pasp', u32(1), u32(1)),
      );

      const stbl = box('stbl',
        fullBox('stsd', 0, 0, u32(1), avc1),
        fullBox('stts', 0, 0, u32(stts.length), stts.flatMap(([c, d]) => [...u32(c), ...u32(d)])),
        fullBox('stss', 0, 0, u32(keyIdx.length), keyIdx.flatMap((k) => u32(k))),
        fullBox('stsc', 0, 0, u32(1), u32(1), u32(s.length), u32(1)),
        fullBox('stsz', 0, 0, u32(0), u32(s.length), s.flatMap((x) => u32(x.data.length))),
        fullBox('stco', 0, 0, u32(1), u32(chunkOffset)),
      );

      const minf = box('minf',
        fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        stbl,
      );

      const mdia = box('mdia',
        fullBox('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(trackDuration), u16(0x55c4), u16(0)),
        fullBox('hdlr', 0, 0, u32(0), fourcc('vide'), new Uint8Array(12), [...enc.encode('VideoHandler'), 0]),
        minf,
      );

      const tkhd = fullBox('tkhd', 0, 3,
        u32(0), u32(0), u32(1), u32(0), u32(movieDuration),
        new Uint8Array(8), u16(0), u16(0), u16(0), u16(0),
        MATRIX, fixed16_16(this.width), fixed16_16(this.height));

      const mvhd = fullBox('mvhd', 0, 0,
        u32(0), u32(0), u32(1000), u32(movieDuration),
        u32(0x00010000), u16(0x0100), new Uint8Array(10),
        MATRIX, new Uint8Array(24), u32(2));

      return box('moov', mvhd, box('trak', tkhd, mdia));
    };

    const ftyp = box('ftyp', fourcc('isom'), u32(512), fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'));
    const moovSize = build(0).length;
    const moov = build(ftyp.length + moovSize + 8);

    const parts = [ftyp, moov, new Uint8Array([...u32(mdatSize), ...fourcc('mdat')])];
    for (const x of s) parts.push(x.data);
    return new Blob(parts, { type: 'video/mp4' });
  }
}
