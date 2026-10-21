// GENERATED from src/shared/wav.ts by scripts/asr-bench/build-wav.mjs. Do not edit.
const ASR_SAMPLE_RATE = 16e3;
function encodeWav(samples, sampleRate = ASR_SAMPLE_RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return buf;
}
const wavBytes = (seconds, sampleRate = ASR_SAMPLE_RATE) => 44 + Math.ceil(seconds * sampleRate) * 2;
function downmix(channels) {
  if (channels.length === 1) return channels[0];
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}
function resample(input, fromRate, toRate = ASR_SAMPLE_RATE) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  if (ratio > 1) {
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio), b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let s = 0;
      for (let k = a; k < b; k++) s += input[k];
      out[i] = s / (b - a);
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio, a = Math.floor(x), f = x - a;
      out[i] = input[a] * (1 - f) + (input[Math.min(a + 1, input.length - 1)] ?? 0) * f;
    }
  }
  return out;
}
function quietestPoint(samples, sampleRate, from, to) {
  const win = Math.max(1, Math.round(sampleRate * 0.02));
  from = Math.max(0, from);
  to = Math.min(samples.length, to);
  let best = to, bestE = Infinity;
  for (let s = from; s + win <= to; s += win) {
    let e = 0;
    for (let k = s; k < s + win; k++) e += samples[k] * samples[k];
    if (e < bestE) {
      bestE = e;
      best = s + Math.floor(win / 2);
    }
  }
  return best;
}
function planSegments(samples, sampleRate, maxSeconds, searchSeconds = 3) {
  const max = Math.max(1, Math.floor(maxSeconds * sampleRate));
  const search = Math.min(Math.floor(searchSeconds * sampleRate), Math.floor(max / 2));
  const out = [];
  let start = 0;
  while (samples.length - start > max) {
    const limit = start + max;
    const cut = search > 0 ? quietestPoint(samples, sampleRate, limit - search, limit) : limit;
    const end = cut > start && cut <= limit ? cut : limit;
    out.push([start, end]);
    start = end;
  }
  if (start < samples.length) out.push([start, samples.length]);
  return out;
}
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
function joinTranscript(a, b) {
  const x = a.replace(/\s+$/, ""), y = b.trim();
  if (!y) return a;
  if (!x) return y;
  return CJK.test(x.slice(-1)) || CJK.test(y[0]) ? x + y : `${x} ${y}`;
}
class StreamResampler {
  constructor(fromRate, toRate = ASR_SAMPLE_RATE) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.ratio = fromRate / toRate;
  }
  fromRate;
  toRate;
  buf = new Float32Array(0);
  /** Absolute input index of buf[0]. */
  base = 0;
  /** Next output index. */
  j = 0;
  ratio;
  push(input) {
    if (this.fromRate === this.toRate) return input;
    if (this.ratio < 1) return resample(input, this.fromRate, this.toRate);
    const all = new Float32Array(this.buf.length + input.length);
    all.set(this.buf);
    all.set(input, this.buf.length);
    const end = this.base + all.length;
    const out = [];
    for (; ; ) {
      const a = Math.floor(this.j * this.ratio), b = Math.max(a + 1, Math.floor((this.j + 1) * this.ratio));
      if (b > end) break;
      let s = 0;
      for (let k = a; k < b; k++) s += all[k - this.base];
      out.push(s / (b - a));
      this.j++;
    }
    const keep = Math.floor(this.j * this.ratio);
    this.buf = all.slice(keep - this.base);
    this.base = keep;
    return Float32Array.from(out);
  }
}
function floatToPcm16(samples) {
  const out = new Uint8Array(samples.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return out;
}
class PcmFramer {
  constructor(frameBytes = 3200, onFrame) {
    this.frameBytes = frameBytes;
    this.onFrame = onFrame;
  }
  frameBytes;
  onFrame;
  buf = new Uint8Array(0);
  push(pcm) {
    const all = new Uint8Array(this.buf.length + pcm.length);
    all.set(this.buf);
    all.set(pcm, this.buf.length);
    let o = 0;
    for (; o + this.frameBytes <= all.length; o += this.frameBytes) this.onFrame(all.slice(o, o + this.frameBytes));
    this.buf = all.slice(o);
  }
  /** Sends what is left (shorter than a frame). */
  flush() {
    if (this.buf.length) {
      this.onFrame(this.buf);
      this.buf = new Uint8Array(0);
    }
  }
}
export {
  ASR_SAMPLE_RATE,
  PcmFramer,
  StreamResampler,
  downmix,
  encodeWav,
  floatToPcm16,
  joinTranscript,
  planSegments,
  quietestPoint,
  resample,
  wavBytes
};
