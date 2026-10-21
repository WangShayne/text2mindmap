import { describe, expect, it } from 'vitest'
import { downmix, encodeWav, joinTranscript, planSegments, quietestPoint, resample, wavBytes } from '../src/shared/wav'

describe('encodeWav', () => {
  it('writes a valid 16 kHz mono 16-bit PCM header and clamps samples', () => {
    const buf = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000)
    const v = new DataView(buf)
    const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n))
    expect(str(0, 4)).toBe('RIFF'); expect(str(8, 4)).toBe('WAVE'); expect(str(12, 4)).toBe('fmt '); expect(str(36, 4)).toBe('data')
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8)
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000)
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getUint32(40, true)).toBe(12)
    expect([0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768, 16384])
    expect(buf.byteLength).toBe(wavBytes(6 / 16000))
  })
  it('28 s fits the 10 MB / 30 s limit of strict providers', () => {
    expect(wavBytes(28)).toBeLessThan(1_000_000)
    expect(wavBytes(600)).toBeLessThan(25 * 1024 * 1024)
  })
})

describe('downmix / resample', () => {
  it('averages channels', () => {
    expect([...downmix([new Float32Array([1, 0]), new Float32Array([0, 0.5])])]).toEqual([0.5, 0.25])
  })
  it('downsamples 48k to 16k by averaging and keeps duration', () => {
    const x = new Float32Array(48000).fill(0.25)
    const y = resample(x, 48000, 16000)
    expect(y.length).toBe(16000)
    expect(y[100]).toBeCloseTo(0.25)
    // non-integer ratio
    expect(resample(new Float32Array(44100), 44100, 16000).length).toBe(16000)
  })
  it('upsamples by interpolation', () => {
    const y = resample(new Float32Array([0, 1, 0, 1]), 8000, 16000)
    expect(y.length).toBe(8)
    expect(y[1]).toBeCloseTo(0.5)
  })
})

describe('planSegments', () => {
  const rate = 1000
  // "speech" everywhere except silent gaps
  const audio = (seconds: number, gaps: number[]) => {
    const a = new Float32Array(seconds * rate).map((_, i) => Math.sin(i) * 0.5)
    for (const g of gaps) a.fill(0, g * rate, g * rate + 200)
    return a
  }
  it('keeps short audio in one piece', () => {
    expect(planSegments(audio(10, []), rate, 28)).toEqual([[0, 10000]])
  })
  it('never exceeds the max length and covers every sample once', () => {
    const a = audio(100, [])
    const segs = planSegments(a, rate, 28)
    expect(segs[0][0]).toBe(0)
    expect(segs.at(-1)![1]).toBe(a.length)
    for (let i = 0; i < segs.length; i++) {
      expect(segs[i][1] - segs[i][0]).toBeLessThanOrEqual(28 * rate)
      expect(segs[i][1]).toBeGreaterThan(segs[i][0])
      if (i) expect(segs[i][0]).toBe(segs[i - 1][1])
    }
  })
  it('cuts inside silence near the limit', () => {
    const segs = planSegments(audio(60, [26, 52]), rate, 28)
    expect(segs[0][1]).toBeGreaterThanOrEqual(26 * rate)
    expect(segs[0][1]).toBeLessThan(26 * rate + 200)
    expect(segs[1][1] - segs[1][0]).toBeLessThanOrEqual(28 * rate)
  })
  it('quietestPoint finds the gap', () => {
    const a = audio(10, [5])
    const p = quietestPoint(a, rate, 3000, 8000)
    expect(p).toBeGreaterThanOrEqual(5000); expect(p).toBeLessThan(5200)
  })
})

describe('joinTranscript', () => {
  it('joins CJK without spaces and Latin text with one space', () => {
    expect(joinTranscript('你好。', '今天')).toBe('你好。今天')
    expect(joinTranscript('Hello', ' world ')).toBe('Hello world')
    expect(joinTranscript('', 'x')).toBe('x')
    expect(joinTranscript('a', '  ')).toBe('a')
    expect(joinTranscript('结束', 'OK')).toBe('结束OK')
  })
})
