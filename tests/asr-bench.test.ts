import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS helper
import { compileWav } from '../scripts/asr-bench/build-wav.mjs'
// @ts-expect-error plain JS helper
import { cer, cleanTranscript, normalizeForCer } from '../scripts/asr-bench/lib.mjs'
// @ts-expect-error plain JS helper
import * as wavJs from '../scripts/asr-bench/wav.mjs'
import * as wavTs from '../src/shared/wav'

describe('asr-bench', () => {
  it('wav.mjs is an up-to-date copy of src/shared/wav.ts (run: node scripts/asr-bench/build-wav.mjs)', () => {
    expect(fs.readFileSync(new URL('../scripts/asr-bench/wav.mjs', import.meta.url), 'utf8')).toBe(compileWav())
    const a = new Float32Array(16000 * 60).map((_, i) => Math.sin(i / 7) * (i % 48000 < 4000 ? 0 : 0.4))
    expect(wavJs.planSegments(a, 16000, 28)).toEqual(wavTs.planSegments(a, 16000, 28))
  })

  it('strips SenseVoice tags like the server does', () => {
    expect(cleanTranscript('<|zh|><|NEUTRAL|><|Speech|><|withitn|>你好。')).toBe('你好。')
    expect(cleanTranscript('language Chinese<asr_text>你好。')).toBe('你好。')
    expect(cleanTranscript('language English is hard')).toBe('language English is hard')
  })

  it('computes CER on normalized text with S/D/I counts', () => {
    expect(normalizeForCer('你好，World！ A b')).toBe('你好worldab')
    expect(cer('今天天气不错。', '今天天气不错')).toMatchObject({ cer: 0, errors: 0 })
    expect(cer('今天天气不错', '今天天汽不错啊')).toMatchObject({ errors: 2, sub: 1, ins: 1, del: 0, refChars: 6 })
    expect(cer('abc', '')).toMatchObject({ cer: 1, del: 3 })
    expect(cer('', '')).toMatchObject({ cer: 0 })
  })

  it('ships references that match the audio metadata', () => {
    for (const n of ['zh-5min', 'mix-50s']) {
      const ref = fs.readFileSync(new URL(`../scripts/asr-bench/audio/${n}.ref.txt`, import.meta.url), 'utf8').trim().split('\n')
      const src = JSON.parse(fs.readFileSync(new URL(`../scripts/asr-bench/audio/${n}.sources.json`, import.meta.url), 'utf8'))
      expect(ref).toEqual(src.map((s: { text: string }) => s.text))
    }
  })
})
