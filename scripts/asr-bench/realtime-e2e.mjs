#!/usr/bin/env node
// End-to-end check of text2mindmap's /api/realtime against a real realtime ASR server
// (e.g. sensevoice-server). Logs in, streams a 16 kHz mono 16-bit WAV at real-time pace in 100 ms
// PCM16 frames (what the browser sends), sends "stop", and reports first-caption latency, partial
// cadence, time from stop to "done", segments and CER against a reference text.
//
// Usage: node realtime-e2e.mjs --base http://127.0.0.1:3000 --user admin --pass … --wav a.wav [--ref a.ref.txt]
//        [--speed 1] (2 = twice real time) [--seconds N] (stream only the first N s)
//        [--drop-at S] (kill the TCP connection after S s, no stop) [--silent-after S] (stop sending audio after S s, wait for the close)
//        [--out result.json]
import fs from 'node:fs'
import { WebSocket } from 'ws'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? '1' : all[i + 1]]] : a), []))
const base = args.base ?? 'http://127.0.0.1:3000'
const speed = Number(args.speed ?? 1)

function readWav(p) {
  const b = fs.readFileSync(p)
  let o = 12
  let fmt, data
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), len = b.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }
    if (id === 'data') { data = b.subarray(o + 8, o + 8 + len); break }
    o += 8 + len + (len & 1)
  }
  if (!fmt || fmt.rate !== 16000 || fmt.ch !== 1 || fmt.bits !== 16) throw new Error('need a 16 kHz mono 16-bit WAV')
  return data
}

const norm = (s) => [...s.normalize('NFKC').toLowerCase()].filter((c) => !/[\p{P}\p{S}\p{Z}\s]/u.test(c))
function cer(ref, hyp) {
  const r = norm(ref), h = norm(hyp)
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j)
  for (let i = 1; i <= r.length; i++) {
    const cur = [i]
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j - 1] + (r[i - 1] !== h[j - 1] ? 1 : 0), prev[j] + 1, cur[j - 1] + 1)
    prev = cur
  }
  return { cer: prev[h.length] / Math.max(1, r.length), refChars: r.length, hypChars: h.length }
}

const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: args.user, password: args.pass }) })
if (!login.ok) { console.error('login failed', login.status); process.exit(1) }
const cookie = login.headers.get('set-cookie').split(';')[0]
let pcm = readWav(args.wav)
if (args.seconds) pcm = pcm.subarray(0, Math.round(Number(args.seconds) * 32000))

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/realtime`, { headers: { cookie, origin: base } })
const t0 = Date.now()
const ev = []
let readyAt, stopAt, doneAt, firstPartialAt, close
const finals = []
ws.on('message', (d, bin) => {
  if (bin) return
  const e = JSON.parse(d.toString()); const t = Date.now() - t0
  ev.push({ t, ...e })
  if (e.type === 'ready') readyAt = t
  if (e.type === 'partial' && firstPartialAt === undefined) firstPartialAt = t
  if (e.type === 'final') finals.push(e.text)
  if (e.type === 'done') doneAt = t
})
const closed = new Promise((r) => ws.on('close', (code, reason) => { close = { code, reason: reason.toString(), t: Date.now() - t0 }; r() }))
ws.on('error', (e) => console.error('ws error', e.message))
await new Promise((r, j) => { ws.once('open', r); ws.once('unexpected-response', (_q, res) => j(new Error(`HTTP ${res.statusCode}`))) })
while (readyAt === undefined && ws.readyState === 1) await new Promise((r) => setTimeout(r, 5))

const FRAME = 3200
const start = Date.now()
let sentAudio = 0
for (let o = 0; o < pcm.length && ws.readyState === 1; o += FRAME) {
  const due = start + (o / 32000) * 1000 / speed
  const wait = due - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  if (args['drop-at'] && o / 32000 >= Number(args['drop-at'])) { ws._socket.destroy(); break }
  if (args['silent-after'] && o / 32000 >= Number(args['silent-after'])) break
  ws.send(pcm.subarray(o, Math.min(pcm.length, o + FRAME)))
  sentAudio = Math.min(pcm.length, o + FRAME) / 32000
}
if (!args['drop-at'] && !args['silent-after'] && ws.readyState === 1) { stopAt = Date.now() - t0; ws.send(JSON.stringify({ type: 'stop' })) }
await Promise.race([closed, new Promise((r) => setTimeout(r, args['drop-at'] ? 500 : 120_000))])

const partialTimes = ev.filter((e) => e.type === 'partial').map((e) => e.t)
const gaps = partialTimes.slice(1).map((t, i) => t - partialTimes[i]).sort((a, b) => a - b)
const transcript = finals.join('')
const out = {
  audioSentSeconds: sentAudio, readyMs: readyAt, firstPartialMs: firstPartialAt !== undefined && readyAt !== undefined ? firstPartialAt - readyAt : null,
  partials: partialTimes.length, partialGapMedianMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
  finals: finals.length, chars: [...transcript].length,
  stopToDoneMs: stopAt !== undefined && doneAt !== undefined ? doneAt - stopAt : null,
  close, errors: ev.filter((e) => e.type === 'error'),
  ...(args.ref ? cer(fs.readFileSync(args.ref, 'utf8'), transcript) : {}),
  transcript,
}
if (args.out) fs.writeFileSync(args.out, JSON.stringify({ ...out, events: ev }, null, 1))
console.log(JSON.stringify({ ...out, transcript: transcript.slice(0, 120) + (transcript.length > 120 ? '…' : '') }, null, 1))
process.exit(0)
