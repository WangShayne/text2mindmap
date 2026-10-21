#!/usr/bin/env node
// ASR acceptance bench for text2mindmap. Mirrors the browser pipeline:
//   decode -> 16 kHz mono -> split at the quietest point near the end of each <= N s window
//   -> 16-bit PCM WAV per segment -> POST {BASE}/audio/transcriptions one by one
//   -> strip <|...|> tags -> join -> report timing, RTF and CER against a reference text.
// Needs Node >= 18 and ffmpeg on PATH (only to decode the input file). No npm packages.
// Talks to the ASR server directly; it does not go through text2mindmap's /api/transcribe.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ASR_SAMPLE_RATE, encodeWav, joinTranscript, planSegments } from './wav.mjs'
import { cer, cleanTranscript } from './lib.mjs'

const HELP = `Usage: node bench.mjs [options] <audio file>
  --base URL        ASR base URL incl. /v1 (env BASE, default http://127.0.0.1:16661/v1)
  --model NAME      model name (env MODEL, default sensevoice-small)
  --key KEY         API key (env ASR_API_KEY; empty = no Authorization header)
  --segment SEC     max segment length in seconds (env SEGMENT, default 28, like the app)
  --language CODE   optional language field (zh, en, ...); default: not sent
  --ref FILE        reference transcript for CER (default: <audio>.ref.txt if it exists)
  --timeout SEC     per-request timeout (default 120)
  --out FILE        also write a JSON report
  --quiet           do not print the transcript`

const args = process.argv.slice(2)
const opt = { base: process.env.BASE || 'http://127.0.0.1:16661/v1', model: process.env.MODEL || 'sensevoice-small', key: process.env.ASR_API_KEY || '', segment: Number(process.env.SEGMENT || 28), language: '', ref: '', timeout: 120, out: '', quiet: false, file: '' }
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i]
  if (a === '--base') opt.base = v(); else if (a === '--model') opt.model = v(); else if (a === '--key') opt.key = v()
  else if (a === '--segment') opt.segment = Number(v()); else if (a === '--language') opt.language = v(); else if (a === '--ref') opt.ref = v()
  else if (a === '--timeout') opt.timeout = Number(v()); else if (a === '--out') opt.out = v(); else if (a === '--quiet') opt.quiet = true
  else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0) } else if (!a.startsWith('--')) opt.file = a
  else { console.error(`Unknown option ${a}\n${HELP}`); process.exit(2) }
}
if (!opt.file) { console.error(HELP); process.exit(2) }
opt.base = opt.base.replace(/\/+$/, '')
if (!opt.ref) { const guess = opt.file.replace(/\.[^.]+$/, '') + '.ref.txt'; if (fs.existsSync(guess)) opt.ref = guess }

function decode(file) {
  const buf = execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(ASR_SAMPLE_RATE), 'pipe:1'], { maxBuffer: 2 ** 31 })
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

async function transcribe(samples, idx) {
  const fd = new FormData()
  fd.set('file', new Blob([encodeWav(samples, ASR_SAMPLE_RATE)], { type: 'audio/wav' }), `segment-${idx}.wav`)
  fd.set('model', opt.model)
  fd.set('response_format', 'json')
  if (opt.language) fd.set('language', opt.language)
  const t0 = performance.now()
  const res = await fetch(`${opt.base}/audio/transcriptions`, { method: 'POST', body: fd, headers: opt.key ? { authorization: `Bearer ${opt.key}` } : {}, signal: AbortSignal.timeout(opt.timeout * 1000) })
  const text = await res.text()
  const ms = performance.now() - t0
  if (!res.ok) throw new Error(`segment ${idx}: HTTP ${res.status} ${text.slice(0, 300)}`)
  let out
  try { const j = JSON.parse(text); out = typeof j === 'string' ? j : j.text ?? j.transcript ?? j.result ?? (Array.isArray(j.segments) ? j.segments.map((s) => s.text ?? '').join('') : undefined) } catch { out = text }
  if (typeof out !== 'string') throw new Error(`segment ${idx}: no "text" in response: ${text.slice(0, 300)}`)
  return { text: cleanTranscript(out), ms }
}

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

{
  console.log(`ASR bench  base=${opt.base}  model=${opt.model}  key=${opt.key ? 'set' : 'none'}  segment<=${opt.segment}s`)
  try {
    const r = await fetch(`${opt.base}/models`, { headers: opt.key ? { authorization: `Bearer ${opt.key}` } : {}, signal: AbortSignal.timeout(10_000) })
    console.log(`GET /models -> HTTP ${r.status} ${(await r.text()).replace(/\s+/g, ' ').slice(0, 200)}`)
  } catch (e) { console.log(`GET /models failed: ${e.cause?.code ?? e.message} (continuing)`) }

  const td = performance.now()
  const samples = decode(opt.file)
  const decodeMs = performance.now() - td
  const duration = samples.length / ASR_SAMPLE_RATE
  const segs = planSegments(samples, ASR_SAMPLE_RATE, opt.segment)
  console.log(`file=${path.basename(opt.file)}  duration=${fmt(duration)} (${duration.toFixed(1)} s)  segments=${segs.length}  decode=${decodeMs.toFixed(0)} ms\n`)
  console.log(' #   start    end     len(s)  bytes     time(ms)  RTF    chars  text')
  let transcript = ''
  const rows = []
  const t0 = performance.now()
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i]
    const len = (b - a) / ASR_SAMPLE_RATE
    try {
      const r = await transcribe(samples.subarray(a, b), i + 1)
      transcript = joinTranscript(transcript, r.text)
      rows.push({ i: i + 1, start: a / ASR_SAMPLE_RATE, end: b / ASR_SAMPLE_RATE, seconds: len, ms: Math.round(r.ms), text: r.text })
      console.log(`${String(i + 1).padStart(2)}  ${fmt(a / ASR_SAMPLE_RATE).padStart(6)}  ${fmt(b / ASR_SAMPLE_RATE).padStart(6)}  ${len.toFixed(2).padStart(6)}  ${String(44 + (b - a) * 2).padStart(8)}  ${String(Math.round(r.ms)).padStart(8)}  ${(r.ms / 1000 / len).toFixed(3)}  ${String(r.text.length).padStart(5)}  ${r.text.slice(0, 40)}${r.text.length > 40 ? '…' : ''}`)
    } catch (e) {
      console.log(`${String(i + 1).padStart(2)}  FAILED: ${e.message}`)
      rows.push({ i: i + 1, seconds: len, error: e.message })
    }
  }
  const wall = (performance.now() - t0) / 1000
  const failed = rows.filter((r) => r.error).length
  const lat = rows.filter((r) => !r.error).map((r) => r.ms).sort((x, y) => x - y)
  console.log(`\n== Summary`)
  console.log(`audio duration     ${duration.toFixed(1)} s`)
  console.log(`segments           ${segs.length} (failed ${failed}), max ${Math.max(...rows.map((r) => r.seconds)).toFixed(2)} s`)
  console.log(`total wall time    ${wall.toFixed(1)} s (sequential, like one browser)`)
  console.log(`real-time factor   ${(wall / duration).toFixed(3)}  (wall / audio; < 1 is faster than real time)`)
  if (lat.length) console.log(`segment latency    min ${lat[0]} ms, median ${lat[Math.floor(lat.length / 2)]} ms, max ${lat.at(-1)} ms`)
  let score
  if (opt.ref) {
    score = cer(fs.readFileSync(opt.ref, 'utf8'), transcript)
    console.log(`CER                ${(score.cer * 100).toFixed(2)} %  (${score.errors} errors = ${score.sub} sub + ${score.del} del + ${score.ins} ins, ${score.refChars} ref chars, ${score.hypChars} hyp chars; punctuation/spaces ignored)`)
  }
  if (!opt.quiet) console.log(`\n== Transcript\n${transcript}`)
  if (opt.out) fs.writeFileSync(opt.out, JSON.stringify({ base: opt.base, model: opt.model, file: opt.file, segmentMax: opt.segment, duration, wall, rtf: wall / duration, segments: rows, cer: score, transcript }, null, 2))
  process.exit(failed ? 1 : 0)
}
