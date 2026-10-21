// Pure audio helpers shared by the browser (recording / file splitting) and the server (test clip).
// No DOM or Node APIs here so they can be unit-tested.

export const ASR_SAMPLE_RATE = 16_000

/** 16-bit PCM mono WAV. Samples are floats in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate = ASR_SAMPLE_RATE): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return buf
}

/** Bytes of a WAV produced by encodeWav for this many seconds. */
export const wavBytes = (seconds: number, sampleRate = ASR_SAMPLE_RATE) => 44 + Math.ceil(seconds * sampleRate) * 2

/** Averages channels into one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const n = Math.min(...channels.map((c) => c.length))
  const out = new Float32Array(n)
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length
  return out
}

/**
 * Resamples by averaging the input samples that fall into each output sample (a box low-pass
 * filter, good enough for speech when downsampling). Upsampling uses linear interpolation.
 */
export function resample(input: Float32Array, fromRate: number, toRate = ASR_SAMPLE_RATE): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  if (ratio > 1) {
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio), b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)))
      let s = 0
      for (let k = a; k < b; k++) s += input[k]
      out[i] = s / (b - a)
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio, a = Math.floor(x), f = x - a
      out[i] = input[a] * (1 - f) + (input[Math.min(a + 1, input.length - 1)] ?? 0) * f
    }
  }
  return out
}

/** Index in [from, to) at the start of the quietest 20 ms window, a good place to cut between words. */
export function quietestPoint(samples: Float32Array, sampleRate: number, from: number, to: number): number {
  const win = Math.max(1, Math.round(sampleRate * 0.02))
  from = Math.max(0, from); to = Math.min(samples.length, to)
  let best = to, bestE = Infinity
  for (let s = from; s + win <= to; s += win) {
    let e = 0
    for (let k = s; k < s + win; k++) e += samples[k] * samples[k]
    if (e < bestE) { bestE = e; best = s + Math.floor(win / 2) }
  }
  return best
}

/**
 * Splits audio into [start, end) sample ranges of at most maxSeconds. Each cut is moved back to
 * the quietest point in the last `searchSeconds` before the limit so words are not cut in half.
 */
export function planSegments(samples: Float32Array, sampleRate: number, maxSeconds: number, searchSeconds = 3): [number, number][] {
  const max = Math.max(1, Math.floor(maxSeconds * sampleRate))
  const search = Math.min(Math.floor(searchSeconds * sampleRate), Math.floor(max / 2))
  const out: [number, number][] = []
  let start = 0
  while (samples.length - start > max) {
    const limit = start + max
    const cut = search > 0 ? quietestPoint(samples, sampleRate, limit - search, limit) : limit
    const end = cut > start && cut <= limit ? cut : limit
    out.push([start, end])
    start = end
  }
  if (start < samples.length) out.push([start, samples.length])
  return out
}

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** Joins transcript pieces: no space between CJK text, one space otherwise. */
export function joinTranscript(a: string, b: string): string {
  const x = a.replace(/\s+$/, ''), y = b.trim()
  if (!y) return a
  if (!x) return y
  return CJK.test(x.slice(-1)) || CJK.test(y[0]) ? x + y : `${x} ${y}`
}

/**
 * Streaming version of resample() for live audio arriving in chunks. Down-sampling produces exactly
 * the samples resample() would give for the concatenated input (same box filter, no seams between
 * chunks). Up-sampling (rare: a mic below 16 kHz) uses linear interpolation per chunk.
 */
export class StreamResampler {
  private buf = new Float32Array(0)
  /** Absolute input index of buf[0]. */
  private base = 0
  /** Next output index. */
  private j = 0
  private readonly ratio: number
  constructor(private fromRate: number, private toRate = ASR_SAMPLE_RATE) { this.ratio = fromRate / toRate }

  push(input: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return input
    if (this.ratio < 1) return resample(input, this.fromRate, this.toRate)
    const all = new Float32Array(this.buf.length + input.length)
    all.set(this.buf); all.set(input, this.buf.length)
    const end = this.base + all.length
    const out: number[] = []
    for (;;) {
      const a = Math.floor(this.j * this.ratio), b = Math.max(a + 1, Math.floor((this.j + 1) * this.ratio))
      if (b > end) break
      let s = 0
      for (let k = a; k < b; k++) s += all[k - this.base]
      out.push(s / (b - a))
      this.j++
    }
    const keep = Math.floor(this.j * this.ratio)
    this.buf = all.slice(keep - this.base)
    this.base = keep
    return Float32Array.from(out)
  }
}

/** Float samples in [-1, 1] to 16-bit little-endian PCM bytes. */
export function floatToPcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2)
  const v = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return out
}

/** Collects PCM16 bytes and hands out fixed-size frames (100 ms at 16 kHz = 3200 bytes by default). */
export class PcmFramer {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  constructor(private frameBytes = 3200, private onFrame: (frame: Uint8Array<ArrayBuffer>) => void) {}
  push(pcm: Uint8Array) {
    const all = new Uint8Array(this.buf.length + pcm.length)
    all.set(this.buf); all.set(pcm, this.buf.length)
    let o = 0
    for (; o + this.frameBytes <= all.length; o += this.frameBytes) this.onFrame(all.slice(o, o + this.frameBytes))
    this.buf = all.slice(o)
  }
  /** Sends what is left (shorter than a frame). */
  flush() { if (this.buf.length) { this.onFrame(this.buf); this.buf = new Uint8Array(0) } }
}
