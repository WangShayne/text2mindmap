#!/usr/bin/env node
// Tiny OpenAI-compatible ASR mock for trying bench.mjs without a real server.
// Answers each segment with the matching slice of a reference text (proportional to time),
// wrapped in SenseVoice-style tags, and rejects audio longer than 30 s like strict providers.
// Usage: node mock-asr.mjs <port> [reference.txt] [delayMsPerSecondOfAudio]
import http from 'node:http'
import fs from 'node:fs'
const port = Number(process.argv[2] ?? 18040)
const ref = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8').replace(/\s+/g, '') : ''
const delayPerSec = Number(process.argv[4] ?? 20)
let cursor = 0
http.createServer(async (req, res) => {
  const json = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
  if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: [{ id: 'sensevoice-small' }] })
  if (req.method !== 'POST' || req.url !== '/v1/audio/transcriptions') return json(404, { error: 'not found' })
  const chunks = []; for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const riff = body.indexOf('RIFF')
  if (riff < 0) return json(400, { error: 'expected a WAV file' })
  const rate = body.readUInt32LE(riff + 24), ch = body.readUInt16LE(riff + 22), bits = body.readUInt16LE(riff + 34)
  const seconds = body.readUInt32LE(riff + 40) / (bits / 8) / ch / rate
  const fmt = /name="response_format"\r\n\r\n([^\r]*)/.exec(body.toString('latin1'))?.[1]
  console.log(`[mock] ${seconds.toFixed(2)} s ${rate} Hz ${ch} ch ${bits} bit format=${fmt}`)
  if (rate !== 16000 || ch !== 1 || bits !== 16) return json(400, { error: 'want 16 kHz mono 16-bit' })
  if (seconds > 30) return json(400, { error: { message: 'audio duration exceeds 30 seconds' } })
  await new Promise((r) => setTimeout(r, seconds * delayPerSec))
  const n = Math.round(seconds * Number(process.env.CHARS_PER_SEC ?? 3.4))
  const text = ref ? ref.slice(cursor, cursor + n) : `(${seconds.toFixed(1)} 秒)`
  cursor += n
  json(200, { text: `<|zh|><|NEUTRAL|><|Speech|><|withitn|>${text}` })
}).listen(port, '0.0.0.0', () => console.log(`mock ASR on http://127.0.0.1:${port}/v1`))
