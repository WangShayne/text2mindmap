import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODE, makeApp } from './helpers'
import { normalizeRealtimeUrl } from '../src/server/config'
import { createSession } from '../src/server/auth'
import { RealtimeAdapter, attachRealtime, mapUpstreamClose, mergeDelta, type RealtimeConfig, type RealtimeHub } from '../src/server/realtime'
import { CLOSE, classifyClose, type DegradeReason, type RealtimeServerEvent } from '../src/shared/realtime'
import { PcmFramer, StreamResampler, floatToPcm16, resample } from '../src/shared/wav'
import { HeldSegments, LiveCaptions, RealtimeClient } from '../src/web/src/audio/realtime'
// @ts-expect-error plain JS helper
import { startMockRealtime } from '../scripts/mock-realtime-asr.mjs'

type Mock = { url: string; conns: { mode: string; path: string; auth?: string; bytes: number; frames: number; texts: string[]; closed: boolean; closeCode: number; closedAt: number }[]; close: () => Promise<void> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(f: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await sleep(10) }
}

describe('realtime: pure helpers', () => {
  it('normalizes realtime addresses', () => {
    expect(normalizeRealtimeUrl('')).toBe('')
    expect(normalizeRealtimeUrl('ws://sensevoice:8040/v1/realtime?intent=transcription')).toBe('ws://sensevoice:8040/v1/realtime?intent=transcription')
    expect(normalizeRealtimeUrl('http://sensevoice:8040/v1')).toBe('ws://sensevoice:8040/v1/realtime?intent=transcription')
    expect(normalizeRealtimeUrl('https://asr.example.com/v1/')).toBe('wss://asr.example.com/v1/realtime?intent=transcription')
    expect(normalizeRealtimeUrl('ws://sensevoice:8040')).toBe('ws://sensevoice:8040/v1/realtime?intent=transcription')
    expect(normalizeRealtimeUrl('ftp://x/v1')).toBeUndefined()
    expect(normalizeRealtimeUrl('not a url')).toBeUndefined()
    expect(normalizeRealtimeUrl('ws://user:pw@host/v1')).toBeUndefined()
  })

  it('merges sensevoice deltas: suffix appends, a revised resend replaces', () => {
    expect(mergeDelta('', '今天')).toBe('今天')
    expect(mergeDelta('今天', '天气')).toBe('今天天气')
    expect(mergeDelta('今天天气', '今天天气很好')).toBe('今天天气很好')
    expect(mergeDelta('今天天汽很', '今天天气很好')).toBe('今天天气很好')
    expect(mergeDelta('hello wor', 'hello world')).toBe('hello world')
    expect(mergeDelta('hello', ' there')).toBe('hello there')
    // ITN punctuation moves, the first word changes: still a resend
    expect(mergeDelta('哦。', '然后。')).toBe('然后。')
    expect(mergeDelta('然后呃我也喜欢。', '然后呃我喜欢play basketball.')).toBe('然后呃我喜欢play basketball.')
    // a short continuation after a full stop is a suffix
    expect(mergeDelta('然后呃我也喜欢打球。', '对')).toBe('然后呃我也喜欢打球。对')
  })

  it('real sensevoice-server events (recorded): every partial is the server hypothesis, never a pile-up', async () => {
    const { readFileSync } = await import('node:fs')
    const evs = JSON.parse(readFileSync(new URL('./fixtures/sensevoice-realtime-events.json', import.meta.url), 'utf8')) as { type: string; delta?: string; transcript?: string }[]
    const a = new RealtimeAdapter()
    let checked = 0
    for (const e of evs) {
      const out = a.handle(e)
      if (e.delta !== undefined && out[0]?.type === 'partial') { expect(out[0].text).toBe(e.delta.trim()); checked++ }
      if (e.transcript !== undefined) expect(out[0]).toMatchObject({ type: 'final', text: e.transcript.trim() })
    }
    expect(checked).toBeGreaterThan(20)
    expect(a.finals).toBeGreaterThanOrEqual(2)
  })

  it('adapter numbers segments itself (sensevoice reuses item ids) and cleans tags', () => {
    const a = new RealtimeAdapter()
    const out: RealtimeServerEvent[] = []
    const feed = (e: Record<string, unknown>) => out.push(...a.handle(e))
    feed({ type: 'session.created' })
    feed({ type: 'input_audio_buffer.speech_started' })
    expect(a.open).toBe(true)
    feed({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it_0', delta: '<|zh|>今天' })
    feed({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it_0', delta: '天气' })
    feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'it_0', transcript: '<|zh|><|NEUTRAL|><|Speech|><|withitn|>今天天气。' })
    expect(a.open).toBe(false)
    feed({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it_0', delta: 'second' })
    feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'it_0', transcript: 'Second.' })
    feed({ type: 'error', message: 'session audio limit exceeded' })
    feed({ type: 'error', message: 'connection limit exceeded' })
    feed({ type: 'error', error: { message: 'boom' } })
    feed({ type: 'input_audio_buffer.committed' })
    expect(out).toEqual([
      { type: 'ready' },
      { type: 'partial', seg: 0, text: '今天' },
      { type: 'partial', seg: 0, text: '今天天气' },
      { type: 'final', seg: 0, text: '今天天气。' },
      { type: 'partial', seg: 1, text: 'second' },
      { type: 'final', seg: 1, text: 'Second.' },
      { type: 'error', code: 'too_long', message: 'session audio limit exceeded' },
      { type: 'error', code: 'busy', message: 'connection limit exceeded' },
      { type: 'error', code: 'upstream', message: 'boom' },
    ])
  })

  it('maps close codes on both sides', () => {
    expect(mapUpstreamClose(1001)).toEqual({ code: 1001, error: 'idle' })
    expect(mapUpstreamClose(1008)).toEqual({ code: 1008, error: 'busy' })
    expect(mapUpstreamClose(1009)).toEqual({ code: 1009, error: 'too_long' })
    expect(mapUpstreamClose(1006)).toEqual({ code: 1011, error: 'unavailable' })
    expect(mapUpstreamClose(1000)).toEqual({ code: 1011, error: 'unavailable' })
    const r: Record<number, DegradeReason | null> = { 1000: null, 1001: 'idle', 1008: 'busy', 1013: 'busy', 1009: 'too_long', 1006: 'unavailable', 1011: 'unavailable', 4404: 'unavailable', 4409: 'unavailable' }
    for (const [code, reason] of Object.entries(r)) expect(classifyClose(Number(code))).toBe(reason)
  })

  it('stream resampler matches the batch resampler across chunk boundaries', () => {
    for (const rate of [48000, 44100, 22050]) {
      const n = rate * 2 + 123
      const input = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.5 + ((i * 7919) % 13) / 100)
      const rs = new StreamResampler(rate)
      const parts: number[] = []
      let o = 0
      const sizes = [4096, 1, 333, 2048, 4095, 17]
      for (let k = 0; o < n; k++) { const len = Math.min(sizes[k % sizes.length], n - o); parts.push(...rs.push(input.subarray(o, o + len))); o += len }
      const batch = resample(input, rate)
      expect(parts.length).toBe(batch.length)
      let maxErr = 0
      for (let i = 0; i < batch.length; i++) maxErr = Math.max(maxErr, Math.abs(parts[i] - batch[i]))
      expect(maxErr).toBeLessThan(1e-6)
    }
  })

  it('encodes PCM16 LE and frames it in 100 ms pieces', () => {
    const b = floatToPcm16(Float32Array.from([0, 1, -1, 0.5, 2]))
    const v = new DataView(b.buffer)
    expect([v.getInt16(0, true), v.getInt16(2, true), v.getInt16(4, true), v.getInt16(6, true), v.getInt16(8, true)]).toEqual([0, 32767, -32768, 16384, 32767])
    const frames: number[] = []
    const f = new PcmFramer(3200, (x) => frames.push(x.length))
    f.push(new Uint8Array(2000)); f.push(new Uint8Array(2000)); f.push(new Uint8Array(6000))
    expect(frames).toEqual([3200, 3200, 3200])
    f.flush()
    expect(frames).toEqual([3200, 3200, 3200, 400])
  })

  it('live captions: finals replaced by segment text are dropped, the partial stays', () => {
    const c = new LiveCaptions()
    const join = (a: string, b: string) => a + b
    c.setPartial(0, '今天')
    c.addFinal(0, '今天天气。', 1000)
    c.setPartial(1, '明天')
    c.addFinal(1, '明天下雨。', 3000)
    expect(c.view(join)).toEqual({ done: '今天天气。明天下雨。', partial: '' })
    c.setPartial(2, '后天')
    c.dropUntil(2000)
    expect(c.view(join)).toEqual({ done: '明天下雨。', partial: '后天' })
    c.clear()
    expect(c.view(join)).toEqual({ done: '', partial: '' })
  })
})

describe('realtime: single-pass fallback keeps uncovered audio', () => {
  it('segments covered by a later final are dropped; the rest goes to the segmented model on degrade', () => {
    const h = new HeldSegments<string>(2000)
    h.push('s1', 8_000); h.push('s2', 16_000)
    h.final(12_000) // covers s1 (cut 4 s before), not s2
    expect(h.size).toBe(1)
    h.push('s3', 24_000)
    expect(h.take()).toEqual(['s2', 's3'])
    expect(h.size).toBe(0)
    // a segment cut just before the final may not be in it yet: kept (repeat rather than lose)
    h.push('s4', 30_000); h.final(31_000)
    expect(h.take()).toEqual(['s4'])
    // no final at all: everything is kept
    const g = new HeldSegments<string>(); g.push('a', 1); g.push('b', 2)
    expect(g.take()).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------------------------

describe('realtime: /api/realtime proxy against a mock sensevoice-server', () => {
  let mock: Mock
  let server: Server
  let hub: RealtimeHub
  let base = ''
  let cookie = ''
  let ctx: ReturnType<typeof makeApp>
  const over: Partial<RealtimeConfig> = { finishGraceMs: 200, idleMs: 60_000, maxSeconds: 600, maxSessions: 4 }

  beforeAll(async () => {
    mock = await startMockRealtime(0)
    ctx = makeApp({ asrBaseUrl: 'http://127.0.0.1:1/v1', asrModel: 'qwen3-asr', asrRealtimeUrl: normalizeRealtimeUrl(mock.url)! })
    await ctx.req('POST', '/api/setup', { username: 'admin', password: 'password123', setupCode: CODE })
    cookie = ctx.getCookie()
    server = serve({ fetch: ctx.app.fetch, port: 0, hostname: '127.0.0.1' }) as Server
    await new Promise<void>((r) => server.once('listening', () => r()))
    hub = attachRealtime(server, ctx, over)
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/realtime`
  })
  afterAll(async () => { hub.close(); await new Promise((r) => server.close(r)); await mock.close() })

  const setMode = (mode: string) => { over.url = normalizeRealtimeUrl(`${mock.url}?mode=${mode}`) }
  const lastConn = () => mock.conns[mock.conns.length - 1]

  /** Opens a raw client; resolves with the socket and a log of events and the close. */
  function open(headers: Record<string, string> = { cookie }) {
    const ws = new WebSocket(base, { headers: { origin: base.replace('ws:', 'http:').replace('/api/realtime', ''), ...headers } })
    const events: RealtimeServerEvent[] = []
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })))
    ws.on('message', (d, bin) => { if (!bin) events.push(JSON.parse(d.toString())) })
    ws.on('error', () => {})
    const opened = new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('unexpected-response', (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); ws.once('error', rej) })
    return { ws, events, closed, opened }
  }
  const frame = () => Buffer.alloc(3200, 1)

  it('rejects the upgrade without a session cookie or from another origin', async () => {
    await expect(open({ cookie: '' }).opened).rejects.toThrow('HTTP 401')
    await expect(open({ cookie, origin: 'https://evil.example' }).opened).rejects.toThrow('HTTP 403')
  })

  it('streams partial and final captions, flushes on stop, then done + 1000', async () => {
    setMode('script')
    const n0 = mock.conns.length
    const c = open()
    await c.opened
    await until(() => c.events.some((e) => e.type === 'ready'))
    for (let i = 0; i < 3; i++) c.ws.send(frame())
    await until(() => c.events.some((e) => e.type === 'final'))
    c.ws.send(JSON.stringify({ type: 'stop' }))
    const cl = await c.closed
    expect(cl.code).toBe(1000)
    expect(c.events).toEqual([
      { type: 'ready' },
      { type: 'partial', seg: 0, text: '今天' },
      { type: 'partial', seg: 0, text: '今天天气' },
      { type: 'partial', seg: 0, text: '今天天气很好' },
      { type: 'final', seg: 0, text: '今天天气很好。' },
      { type: 'partial', seg: 1, text: '第二段' },
      { type: 'final', seg: 1, text: '第二段。' },
      { type: 'done' },
    ])
    const up = mock.conns[n0]
    expect(up.path).toBe('/v1/realtime')
    expect(up.bytes).toBe(9600) // binary PCM16 forwarded as is
    expect(up.texts.map((t) => JSON.parse(t).type)).toEqual(['input_audio_buffer.commit']) // no session.update: server VAD stays on
    await until(() => up.closed)
    await until(() => hub.sessions.size === 0)
  })

  it('closes the upstream at once when the browser goes away (close and abrupt drop)', async () => {
    for (const how of ['close', 'terminate'] as const) {
      setMode('script')
      const c = open()
      await c.opened
      await until(() => c.events.some((e) => e.type === 'ready'))
      c.ws.send(frame())
      await until(() => lastConn().bytes > 0)
      const up = lastConn()
      const t0 = Date.now()
      if (how === 'close') c.ws.close(1000); else c.ws.terminate()
      await until(() => up.closed, 2500)
      expect(Date.now() - t0).toBeLessThan(1500)
      await until(() => hub.sessions.size === 0)
    }
  })

  it.each([
    ['close1001', 1001, 'idle'],
    ['close1008', 1008, 'busy'],
    ['close1009', 1009, 'too_long'],
    ['kill', 1011, 'unavailable'],
  ])('upstream %s -> browser gets close %i and error %s', async (mode, code, error) => {
    setMode(mode)
    const c = open()
    await c.opened
    await until(() => c.events.some((e) => e.type === 'ready'))
    c.ws.send(frame())
    const cl = await c.closed
    expect(cl.code).toBe(code)
    expect(c.events.find((e) => e.type === 'error')).toMatchObject({ type: 'error', code: error })
    await until(() => hub.sessions.size === 0)
  })

  it('upstream over its connection limit -> 1008; unreachable upstream -> 1011', async () => {
    setMode('limit')
    let c = open(); await c.opened
    expect((await c.closed).code).toBe(1008)
    expect(c.events.filter((e) => e.type === 'error').map((e) => (e as { code: string }).code)).toEqual(['busy', 'busy'])
    over.url = 'ws://127.0.0.1:1/v1/realtime?intent=transcription'
    c = open(); await c.opened
    expect((await c.closed).code).toBe(1011)
    expect(c.events.find((e) => e.type === 'error')).toMatchObject({ code: 'unavailable', message: 'upstream unavailable' })
    expect(JSON.stringify(c.events)).not.toContain('127.0.0.1') // internal addresses stay in the server log
    await until(() => hub.sessions.size === 0)
  })

  it('own guards: idle -> 1001, too long -> 1009, both close the upstream', async () => {
    setMode('script')
    over.idleMs = 300
    let c = open(); await c.opened
    await until(() => c.events.some((e) => e.type === 'ready'))
    c.ws.send(frame())
    await until(() => lastConn().bytes > 0)
    let up = lastConn()
    expect((await c.closed).code).toBe(1001)
    await until(() => up.closed)
    over.idleMs = 60_000

    over.maxSeconds = 0.15 // 1.5 frames
    c = open(); await c.opened
    await until(() => c.events.some((e) => e.type === 'ready'))
    c.ws.send(frame()); c.ws.send(frame())
    expect((await c.closed).code).toBe(1009)
    expect(c.events.find((e) => e.type === 'error')).toMatchObject({ code: 'too_long' })
    up = lastConn()
    await until(() => up.closed)
    over.maxSeconds = 600
    await until(() => hub.sessions.size === 0)
  })

  it('own limits: global session cap -> 1008, a second session of the same user replaces the first (4409)', async () => {
    setMode('script')
    over.maxSessions = 1
    const r = ctx.db.prepare('INSERT INTO users(username, password_hash, is_admin, created_at) VALUES(?, ?, 0, ?)').run('bob', 'x', Date.now())
    const bob = `t2m_session=${createSession(ctx.db, Number(r.lastInsertRowid), 1).token}`
    const a = open(); await a.opened
    await until(() => a.events.some((e) => e.type === 'ready'))
    const b = open({ cookie: bob }); await b.opened
    expect((await b.closed).code).toBe(1008)
    const a2 = open(); await a2.opened
    expect((await a.closed).code).toBe(CLOSE.replaced)
    await until(() => a2.events.some((e) => e.type === 'ready'))
    a2.ws.close()
    over.maxSessions = 4
    await until(() => hub.sessions.size === 0)
  })

  it('not configured -> 4404', async () => {
    const saved = over.url
    over.url = ''
    const c = open(); await c.opened
    expect((await c.closed).code).toBe(4404)
    over.url = saved
  })

  // The browser client (RealtimeClient) driven through ws with the session cookie.
  const CookieWs = (h: Record<string, string>) => class extends WebSocket { constructor(url: string) { super(url, { headers: h }) } } as unknown as new (url: string) => globalThis.WebSocket

  function client() {
    const log: string[] = []
    let degraded: DegradeReason | undefined
    const done = new Promise<void>((resolve) => {
      const rc = new RealtimeClient(base, {
        onReady: () => log.push('ready'),
        onPartial: (s, t) => log.push(`p${s}:${t}`),
        onFinal: (s, t) => log.push(`f${s}:${t}`),
        onDegrade: (r) => { degraded = r; resolve() },
        onDone: () => { log.push('done'); resolve() },
      }, { WebSocketImpl: CookieWs({ cookie, origin: base.replace('ws:', 'http:').replace('/api/realtime', '') }), connectTimeoutMs: 2000 })
      ;(client as unknown as { last: RealtimeClient }).last = rc
      rc.connect()
    })
    return { log, done, get degraded() { return degraded }, rc: (client as unknown as { last: RealtimeClient }).last }
  }

  it('browser client: partial / final flow and stop()', async () => {
    setMode('script')
    const c = client()
    await until(() => c.log.includes('ready'))
    for (let i = 0; i < 3; i++) c.rc.sendPcm(new Uint8Array(3200))
    await until(() => c.log.some((l) => l.startsWith('f0')))
    await c.rc.stop()
    await c.done
    expect(c.degraded).toBeUndefined()
    expect(c.log).toEqual(['ready', 'p0:今天', 'p0:今天天气', 'p0:今天天气很好', 'f0:今天天气很好。', 'p1:第二段', 'f1:第二段。', 'done'])
  })

  it.each([
    ['close1001', 'idle'],
    ['close1008', 'busy'],
    ['limit', 'busy'],
    ['close1009', 'too_long'],
    ['kill', 'unavailable'],
  ])('browser client degrades on upstream %s -> %s', async (mode, reason) => {
    setMode(mode)
    const c = client()
    await until(() => c.log.includes('ready') || c.degraded !== undefined)
    c.rc.sendPcm(new Uint8Array(3200))
    await c.done
    expect(c.degraded).toBe(reason)
    expect(c.rc.active).toBe(false)
  })

  it('browser client degrades when the backend refuses (no session -> 1006) or times out', async () => {
    const rc1 = await new Promise<DegradeReason>((resolve) => {
      new RealtimeClient(base, { onPartial() {}, onFinal() {}, onDegrade: resolve }, { WebSocketImpl: CookieWs({}) }).connect()
    })
    expect(rc1).toBe('unavailable')
    setMode('silent') // upstream never says session.created
    const t0 = Date.now()
    const rc2 = await new Promise<DegradeReason>((resolve) => {
      new RealtimeClient(base, { onPartial() {}, onFinal() {}, onDegrade: resolve }, { WebSocketImpl: CookieWs({ cookie }), connectTimeoutMs: 400 }).connect()
    })
    expect(rc2).toBe('unavailable')
    expect(Date.now() - t0).toBeLessThan(2000)
    await until(() => lastConn().closed) // the browser closing also closed the upstream
  })

  it('close() by the user does not report a degrade', async () => {
    setMode('script')
    let deg = false
    const rc = new RealtimeClient(base, { onPartial() {}, onFinal() {}, onDegrade: () => { deg = true } }, { WebSocketImpl: CookieWs({ cookie }) })
    let ready = false
    ;(rc as unknown as { h: { onReady: () => void } }).h.onReady = () => { ready = true }
    rc.connect()
    await until(() => ready)
    const up = lastConn()
    rc.close()
    await until(() => up.closed)
    await sleep(100)
    expect(deg).toBe(false)
  })
})

describe('realtime: settings', () => {
  let mock: Mock
  beforeAll(async () => { mock = await startMockRealtime(0) })
  afterAll(async () => { await mock.close() })

  it('stores, normalizes and reports the realtime address; public view only says on/off', async () => {
    const { req, setCookie } = makeApp({ asrBaseUrl: 'http://qwen3-asr:8080/v1', asrModel: 'qwen3-asr-0.6b' })
    await req('POST', '/api/setup', { username: 'admin', password: 'password123', setupCode: CODE })
    let pub = await (await req('GET', '/api/settings/public')).json()
    expect(pub.asr).toMatchObject({ realtime: false, realtimeTwoPass: true })
    expect((await req('PUT', '/api/settings', { asrRealtimeUrl: 'ftp://nope' })).status).toBe(400)
    const v = await (await req('PUT', '/api/settings', { asrRealtimeUrl: 'http://sensevoice:8040/v1', asrRealtimeTwoPass: false })).json()
    expect(v.realtime).toMatchObject({ url: 'ws://sensevoice:8040/v1/realtime?intent=transcription', twoPass: false })
    pub = await (await req('GET', '/api/settings/public')).json()
    expect(pub.asr).toMatchObject({ realtime: true, realtimeTwoPass: false })
    expect(JSON.stringify(pub)).not.toContain('sensevoice')
    const t = await (await req('POST', '/api/settings/asr/realtime/test', { url: mock.url })).json()
    expect(t).toMatchObject({ ok: true, message: 'session.created' })
    const bad = await (await req('POST', '/api/settings/asr/realtime/test', { url: 'ws://127.0.0.1:1/v1' })).json()
    expect(bad.ok).toBe(false)
    const empty = await (await req('PUT', '/api/settings', { asrRealtimeUrl: '' })).json()
    expect(empty.realtime.url).toBe('')
    setCookie('')
    expect((await req('POST', '/api/settings/asr/realtime/test', { url: mock.url })).status).toBe(401)
  })

  it('env default can be turned off in Settings, and realtime needs the segmented model too', async () => {
    const { req } = makeApp({ asrRealtimeUrl: 'ws://sensevoice:8040/v1/realtime?intent=transcription' })
    await req('POST', '/api/setup', { username: 'admin', password: 'password123', setupCode: CODE })
    expect((await (await req('GET', '/api/settings/public')).json()).asr.realtime).toBe(false) // no ASR_BASE_URL / model
    await req('PUT', '/api/settings', { asrBaseUrl: 'http://qwen3-asr:8080/v1', asrModel: 'q' })
    expect((await (await req('GET', '/api/settings/public')).json()).asr.realtime).toBe(true)
    const v = await (await req('PUT', '/api/settings', { asrRealtimeUrl: '' })).json()
    expect(v.realtime).toMatchObject({ url: '', env: { url: 'ws://sensevoice:8040/v1/realtime?intent=transcription' } })
    expect((await (await req('GET', '/api/settings/public')).json()).asr.realtime).toBe(false)
    const back = await (await req('PUT', '/api/settings', { asrRealtimeUrl: 'ws://sensevoice:8040/v1/realtime?intent=transcription' })).json()
    expect(back.realtime.overrides.url).toBe(false)
  })
})
