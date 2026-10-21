// Mock realtime ASR server speaking sensevoice-server's /v1/realtime dialect (OpenAI realtime
// transcription events). Used by tests/realtime.test.ts; also handy for trying live captions locally:
//   node scripts/mock-realtime-asr.mjs 8041   ->  ASR_REALTIME_URL=ws://127.0.0.1:8041/v1/realtime
//
// Behaviour per connection is chosen with ?mode=… on the URL (default "script"):
//   script     : after 3 binary frames: speech_started, delta "今天", delta "天气", revised full text
//                "今天天气很好" (a resend, not a suffix), completed "<|zh|>今天天气很好。" (item it_0);
//                on commit: delta "第二段", completed "第二段。" (again item it_0, like sensevoice).
//   close1001 / close1008 / close1009 : close with that code after the first binary frame
//   limit      : close 1008 right away (over --max-connections; sensevoice sends an error first)
//   kill       : destroy the TCP socket after the first binary frame (no close frame)
//   silent     : never answer (no session.created)
import { WebSocketServer } from 'ws'

export function startMockRealtime(port = 0) {
  const conns = []
  const wss = new WebSocketServer({ port, host: '127.0.0.1' })
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const mode = url.searchParams.get('mode') ?? 'script'
    const c = { mode, path: url.pathname, auth: req.headers.authorization, bytes: 0, frames: 0, texts: [], closed: false, closeCode: 0, closedAt: 0 }
    conns.push(c)
    const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)) }
    ws.on('close', (code) => { c.closed = true; c.closeCode = code; c.closedAt = Date.now() })
    ws.on('error', () => {})
    if (mode === 'limit') { send({ type: 'error', message: 'connection limit exceeded' }); ws.close(1008, 'connection limit exceeded'); return }
    if (mode !== 'silent') send({ type: 'session.created', session: { id: 'sess_1', object: 'realtime.session', model: 'sensevoice' } })
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        c.bytes += data.length; c.frames++
        if (c.frames === 1) {
          if (mode === 'close1001') return ws.close(1001, 'idle timeout')
          if (mode === 'close1008') return ws.close(1008, 'connection limit exceeded')
          if (mode === 'close1009') { send({ type: 'error', message: 'session audio limit exceeded' }); return ws.close(1009, 'session audio limit exceeded') }
          if (mode === 'kill') return ws._socket.destroy()
        }
        if (mode === 'script' && c.frames === 3) {
          send({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 })
          send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it_0', delta: '今天' })
          send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it_0', delta: '天气' })
          send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it_0', delta: '今天天气很好' })
          send({ type: 'input_audio_buffer.committed' })
          send({ type: 'conversation.item.created', item: { id: 'it_0', object: 'realtime.item', type: 'input_audio' } })
          send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'it_0', transcript: '<|zh|><|NEUTRAL|><|Speech|><|withitn|>今天天气很好。', language: 'zh' })
          send({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 })
        }
        return
      }
      const msg = data.toString()
      c.texts.push(msg)
      let m; try { m = JSON.parse(msg) } catch { return }
      if (m.type === 'input_audio_buffer.commit' && mode === 'script') {
        setTimeout(() => {
          send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it_0', delta: '第二段' })
          send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'it_0', transcript: '第二段。' })
        }, 50)
      }
    })
  })
  return new Promise((resolve) => wss.on('listening', () => {
    const { port: p } = wss.address()
    resolve({ url: `ws://127.0.0.1:${p}/v1/realtime`, conns, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()) }) })
  }))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMockRealtime(Number(process.argv[2] ?? 8041))
  console.log(`mock realtime ASR on ${m.url}`)
}
