// /api/realtime: WebSocket proxy from the browser to a realtime (streaming) ASR server such as
// sensevoice-server's /v1/realtime?intent=transcription (OpenAI realtime transcription dialect).
//
// Why a proxy: a browser WebSocket cannot send an Authorization header, and the ASR server has no auth
// of its own and must stay on the internal network. The browser speaks the small protocol in
// shared/realtime.ts; provider differences stay here.
//
// Resources: the upstream has very few connection slots (sensevoice-server --max-connections, 2 on our
// host), so every way a session can end (client close / error / stop, idle, too long, upstream failure)
// closes the upstream connection right away and frees our own counter.
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { cleanTranscript } from './asr'
import { SESSION_COOKIE, sessionUser, type User } from './auth'
import { getSetting, type DB } from './db'
import { normalizeRealtimeUrl, type AppConfig } from './config'
import type { SecretBox } from './secrets'
import { CLOSE, REALTIME_MAX_FRAME_BYTES, REALTIME_PATH, REALTIME_SAMPLE_RATE, type RealtimeErrorCode, type RealtimeServerEvent } from '../shared/realtime'

export const RK = { url: 'asr_realtime_url', twoPass: 'asr_realtime_two_pass' } as const

export interface RealtimeConfig {
  url: string
  apiKey: string
  twoPass: boolean
  maxSeconds: number
  idleMs: number
  maxSessions: number
  /** Upstream WebSocket handshake timeout. */
  connectTimeoutMs: number
  /** After "stop": how long to wait for the last final at most. */
  finishTimeoutMs: number
  /** After "stop" with no open segment: quiet time before "done". */
  finishGraceMs: number
  /** Browser keep-alive ping interval (Cloudflare drops idle WebSockets after about 100 s). */
  pingMs: number
}

export function effectiveRealtime(deps: { db: DB; config: AppConfig }, over: Partial<RealtimeConfig> = {}): RealtimeConfig {
  const { db, config } = deps
  const stored = getSetting(db, RK.url)
  const tp = getSetting(db, RK.twoPass)
  return {
    url: stored ? (stored === 'off' ? '' : normalizeRealtimeUrl(stored) || '') : config.asrRealtimeUrl,
    apiKey: config.asrRealtimeApiKey,
    twoPass: tp === undefined ? config.asrRealtimeTwoPass : tp === 'true',
    maxSeconds: config.asrRealtimeMaxSeconds,
    idleMs: config.asrRealtimeIdleSeconds * 1000,
    maxSessions: config.asrRealtimeMaxSessions,
    connectTimeoutMs: 5000,
    finishTimeoutMs: 15_000,
    finishGraceMs: 800,
    pingMs: 20_000,
    ...over,
  }
}

/** Hides the userinfo / query of an upstream URL in messages. */
const showUrl = (u: string) => { try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname}` } catch { return '(invalid URL)' } }

// ---------------------------------------------------------------------------------------------
// Provider adapter (pure, unit-tested)
// ---------------------------------------------------------------------------------------------

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

const ENDS_WITH_PUNCT = /[。！？!?.，,、；;：:…]\s*$/

/**
 * Applies one transcription delta to the current hypothesis.
 * sensevoice-server sends only the new suffix when its new hypothesis starts with the previous one,
 * and the whole text otherwise (a revision). With ITN on, SenseVoice ends almost every hypothesis
 * with punctuation that moves as the sentence grows ("然后。" -> "然后呃。"), so in practice nearly
 * every delta is a full resend, often with a different first word. Treated as a resend: a delta that
 * starts like the current text, or one at least about as long as it when the current text ends in
 * punctuation (a real suffix after "。" is short). Everything else is appended.
 */
export function mergeDelta(cur: string, delta: string): string {
  if (!cur) return delta
  if (!delta) return cur
  if (commonPrefix(cur, delta) >= Math.min(3, Math.ceil(cur.length / 2))) return delta
  if (ENDS_WITH_PUNCT.test(cur) && delta.length >= cur.length * 0.6) return delta
  return cur + delta
}

/**
 * Turns upstream OpenAI-realtime-transcription events (sensevoice-server dialect) into our events.
 * Segments are numbered here: sensevoice's item_id is "it_<start ms>" relative to a trimmed buffer, so
 * two segments can share an id. Every "completed" ends the current segment.
 */
export class RealtimeAdapter {
  seg = 0
  hyp = ''
  /** Speech started (or a partial arrived) and the segment has not been finalized yet. */
  open = false
  finals = 0

  handle(ev: { type?: unknown; [k: string]: unknown }): RealtimeServerEvent[] {
    switch (ev.type) {
      case 'session.created': return [{ type: 'ready' }]
      case 'input_audio_buffer.speech_started': this.open = true; return []
      case 'conversation.item.input_audio_transcription.delta': {
        const d = typeof ev.delta === 'string' ? ev.delta : ''
        if (!d) return []
        this.open = true
        this.hyp = mergeDelta(this.hyp, d)
        const text = cleanTranscript(this.hyp)
        return text ? [{ type: 'partial', seg: this.seg, text }] : []
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = cleanTranscript(typeof ev.transcript === 'string' ? ev.transcript : '')
        const seg = this.seg++
        this.hyp = ''
        this.open = false
        this.finals++
        return [{ type: 'final', seg, text }]
      }
      case 'error': {
        const e = ev.error as { message?: unknown } | undefined
        const m = String(typeof ev.message === 'string' ? ev.message : e?.message ?? 'upstream error').slice(0, 200)
        // sensevoice-server: "connection limit exceeded" (then 1008), "session audio limit exceeded" (then 1009).
        const code: RealtimeErrorCode = /connection|too many|busy/i.test(m) ? 'busy' : /audio limit|too long|duration/i.test(m) ? 'too_long' : 'upstream'
        return [{ type: 'error', code, message: m }]
      }
      default: return []
    }
  }
}

/** Maps an upstream close code to the one we send to the browser. */
export function mapUpstreamClose(code: number): { code: number; error: RealtimeErrorCode } {
  if (code === CLOSE.idle) return { code: CLOSE.idle, error: 'idle' }
  if (code === CLOSE.busy || code === 1013) return { code: CLOSE.busy, error: 'busy' }
  if (code === CLOSE.tooLong) return { code: CLOSE.tooLong, error: 'too_long' }
  return { code: CLOSE.upstream, error: 'unavailable' }
}

// ---------------------------------------------------------------------------------------------
// Upstream check for the settings form
// ---------------------------------------------------------------------------------------------

/** Opens a session on the upstream, waits for session.created, closes it. */
export function testRealtime(url: string, apiKey: string, timeoutMs = 5000): Promise<{ ok: boolean; latencyMs?: number; code?: string; message: string }> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    let done = false
    const finish = (r: { ok: boolean; latencyMs?: number; code?: string; message: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { if (ws.readyState === WebSocket.OPEN) ws.close(1000); else ws.terminate() } catch { /* ignore */ }
      resolve(r)
    }
    const ws = new WebSocket(url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, handshakeTimeout: timeoutMs })
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout', message: `No session.created from ${showUrl(url)} within ${timeoutMs} ms.` }), timeoutMs + 500)
    ws.on('message', (d, bin) => {
      if (bin) return
      try { if (JSON.parse(d.toString()).type === 'session.created') finish({ ok: true, latencyMs: Date.now() - t0, message: 'session.created' }) } catch { /* ignore */ }
    })
    ws.on('unexpected-response', (_req, res) => finish({ ok: false, code: res.statusCode === 401 || res.statusCode === 403 ? 'auth' : 'http', message: `${showUrl(url)} answered HTTP ${res.statusCode} instead of a WebSocket upgrade.` }))
    ws.on('close', (code, reason) => finish({ ok: false, code: code === CLOSE.busy ? 'busy' : 'closed', message: `${showUrl(url)} closed the connection (${code}${reason.length ? ` ${reason.toString().slice(0, 100)}` : ''}).` }))
    ws.on('error', (e) => finish({ ok: false, code: 'network', message: `Cannot connect to ${showUrl(url)}: ${(e as Error).message.split(apiKey || '\u0000').join('***')}` }))
  })
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

const UPSTREAM_HIGH_WATER = 1024 * 1024
const MAX_PENDING_BYTES = 10 * 3200 * 20 // ~20 s of audio while the upstream handshake runs

type EndInfo = { code: number; reason: string; audioSeconds: number; finals: number; ms: number }

export class RealtimeSession {
  readonly adapter = new RealtimeAdapter()
  private upstream?: WebSocket
  private pending: Buffer[] = []
  private pendingBytes = 0
  private audioBytes = 0
  private lastAudio = Date.now()
  private readonly started = Date.now()
  private stopping = false
  private ended = false
  private ready = false
  private timers: NodeJS.Timeout[] = []
  private finishTimer?: NodeJS.Timeout
  private paused = false

  constructor(private client: WebSocket, private cfg: RealtimeConfig, private onEnd: (s: RealtimeSession, info: EndInfo) => void) {}

  start() {
    const c = this.client
    c.on('message', (d, bin) => this.onClient(d, bin))
    c.on('close', () => this.end(CLOSE.normal, 'client closed', false))
    c.on('error', () => this.end(CLOSE.upstream, 'client error', false))
    this.timers.push(setInterval(() => this.tick(), 1000))
    this.timers.push(setInterval(() => { if (c.readyState === WebSocket.OPEN) c.ping() }, this.cfg.pingMs))

    const up = new WebSocket(this.cfg.url, {
      headers: this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {},
      handshakeTimeout: this.cfg.connectTimeoutMs,
      maxPayload: 4 * 1024 * 1024,
    })
    this.upstream = up
    up.on('open', () => {
      for (const b of this.pending) up.send(b)
      this.pending = []; this.pendingBytes = 0
      if (this.stopping) up.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    })
    up.on('message', (d, bin) => { if (!bin) this.onUpstream(d) })
    up.on('unexpected-response', (_req, res) => {
      const st = res.statusCode ?? 0
      this.fail(st === 429 || st === 503 ? CLOSE.busy : CLOSE.upstream, st === 429 || st === 503 ? 'busy' : 'unavailable', `upstream HTTP ${st}`)
    })
    // The detail (it may name internal hosts) goes to the server log only.
    up.on('error', (e) => this.fail(CLOSE.upstream, 'unavailable', 'upstream unavailable', (e as Error).message.slice(0, 120)))
    up.on('close', (code, reason) => {
      if (this.ended) return
      // The upstream ending the session after our "stop" with nothing left to say is a normal end.
      if (this.stopping && code === CLOSE.normal) return this.finish()
      const m = mapUpstreamClose(code)
      this.fail(m.code, m.error, `upstream closed ${code}${reason.length ? ` ${reason.toString().slice(0, 80)}` : ''}`)
    })
  }

  /** Audio seconds received from the browser so far. */
  get audioSeconds() { return this.audioBytes / 2 / REALTIME_SAMPLE_RATE }

  private send(ev: RealtimeServerEvent) {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(ev))
  }

  private onClient(d: RawData, bin: boolean) {
    if (this.ended) return
    const buf = Array.isArray(d) ? Buffer.concat(d) : Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer)
    if (bin) {
      if (this.stopping) return
      if (buf.length % 2 !== 0 || buf.length > REALTIME_MAX_FRAME_BYTES) return this.fail(CLOSE.tooLong, 'bad_request', 'bad audio frame')
      this.audioBytes += buf.length
      this.lastAudio = Date.now()
      if (this.audioSeconds > this.cfg.maxSeconds) return this.fail(CLOSE.tooLong, 'too_long', `session longer than ${this.cfg.maxSeconds} s`)
      const up = this.upstream
      if (up?.readyState === WebSocket.OPEN) {
        up.send(buf)
        this.backpressure()
      } else {
        this.pending.push(buf); this.pendingBytes += buf.length
        if (this.pendingBytes > MAX_PENDING_BYTES) this.fail(CLOSE.upstream, 'unavailable', 'upstream not ready')
      }
      return
    }
    let msg: { type?: unknown }
    try { msg = JSON.parse(buf.toString('utf8')) } catch { return }
    if (msg.type === 'ping') this.send({ type: 'pong' })
    else if (msg.type === 'stop') this.stop()
  }

  /** Pauses reading from the browser while the upstream socket has too much queued. */
  private backpressure() {
    const up = this.upstream
    if (!up || this.paused || up.bufferedAmount < UPSTREAM_HIGH_WATER) return
    this.paused = true
    this.client.pause()
    const t = setInterval(() => {
      if (this.ended || up.bufferedAmount < UPSTREAM_HIGH_WATER / 2) { clearInterval(t); this.paused = false; if (!this.ended) this.client.resume() }
    }, 50)
    this.timers.push(t)
  }

  private onUpstream(d: RawData) {
    let ev: { type?: unknown }
    try { ev = JSON.parse(d.toString()) } catch { return }
    const audioEnd = Math.round(this.audioSeconds * 1000) / 1000
    for (const out of this.adapter.handle(ev)) {
      if (out.type === 'ready') { if (this.ready) continue; this.ready = true }
      this.send(out.type === 'partial' || out.type === 'final' ? { ...out, audioEnd } : out)
    }
    if (this.stopping) this.scheduleFinish()
  }

  /** End of audio: flush the last segment upstream, then "done" once it is in. */
  stop() {
    if (this.stopping || this.ended) return
    this.stopping = true
    const up = this.upstream
    if (up?.readyState === WebSocket.OPEN) up.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    this.timers.push(setTimeout(() => this.finish(), this.cfg.finishTimeoutMs))
    this.scheduleFinish()
  }

  private scheduleFinish() {
    if (this.finishTimer) clearTimeout(this.finishTimer)
    // An open segment still owes us its final; otherwise wait a short quiet period for stragglers.
    if (this.adapter.open) return
    this.finishTimer = setTimeout(() => this.finish(), this.adapter.finals ? Math.min(300, this.cfg.finishGraceMs) : this.cfg.finishGraceMs)
  }

  private finish() {
    if (this.ended) return
    this.send({ type: 'done' })
    this.end(CLOSE.normal, 'done')
  }

  private tick() {
    if (this.ended || this.stopping) return
    const now = Date.now()
    if (now - this.lastAudio >= this.cfg.idleMs) this.fail(CLOSE.idle, 'idle', 'idle timeout')
    else if (now - this.started > (this.cfg.maxSeconds + 60) * 1000) this.fail(CLOSE.tooLong, 'too_long', 'session too long')
  }

  /** Ends the session with an error event and close code. `detail` is logged, never sent to the browser. */
  fail(code: number, error: RealtimeErrorCode, reason: string, detail?: string) {
    if (this.ended) return
    this.send({ type: 'error', code: error, message: reason })
    this.end(code, reason, true, detail)
  }

  /** Closes both sides. Safe to call more than once. */
  end(code: number, reason: string, closeClient = true, detail?: string) {
    if (this.ended) return
    this.ended = true
    for (const t of this.timers) { clearInterval(t); clearTimeout(t) }
    if (this.finishTimer) clearTimeout(this.finishTimer)
    this.pending = []
    const up = this.upstream
    if (up) {
      // A close frame makes sensevoice-server drop queued audio and free the slot at once; terminate
      // if it does not answer (or the handshake is still running).
      if (up.readyState === WebSocket.OPEN) {
        up.close(1000)
        setTimeout(() => { if (up.readyState !== WebSocket.CLOSED) up.terminate() }, 2000).unref()
      } else if (up.readyState === WebSocket.CONNECTING) up.terminate()
    }
    const c = this.client
    if (closeClient && c.readyState === WebSocket.OPEN) {
      c.close(code, reason.slice(0, 120))
      setTimeout(() => { if (c.readyState !== WebSocket.CLOSED) c.terminate() }, 3000).unref()
    }
    this.onEnd(this, { code, reason: detail ? `${reason}: ${detail}` : reason, audioSeconds: Math.round(this.audioSeconds * 10) / 10, finals: this.adapter.finals, ms: Date.now() - this.started })
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP upgrade handling
// ---------------------------------------------------------------------------------------------

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return undefined } }
  }
  return undefined
}

function first(h: string | string[] | undefined): string | undefined {
  const v = Array.isArray(h) ? h[0] : h
  return v?.split(',')[0]?.trim().toLowerCase() || undefined
}

function reject(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`)
  socket.destroy()
}

export interface RealtimeHub {
  /** Open sessions. */
  readonly sessions: Set<RealtimeSession>
  close(): void
}

/**
 * Serves /api/realtime on the HTTP server. Authentication: the session cookie; the Origin header
 * (when sent, which browsers always do) must match the Host, against cross-site WebSocket hijacking.
 */
export function attachRealtime(server: Server, deps: { db: DB; config: AppConfig; secretBox?: SecretBox }, over: Partial<RealtimeConfig> = {}): RealtimeHub {
  const wss = new WebSocketServer({ noServer: true, maxPayload: REALTIME_MAX_FRAME_BYTES })
  const sessions = new Set<RealtimeSession>()
  const byUser = new Map<number, RealtimeSession>()
  const { db, config } = deps

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname !== REALTIME_PATH) return reject(socket, 404, 'Not Found')
    const user: User | null = sessionUser(db, cookieValue(req.headers.cookie, SESSION_COOKIE))
    if (!user) return reject(socket, 401, 'Unauthorized')
    const origin = req.headers.origin
    if (origin) {
      const host = (config.trustProxy > 0 && first(req.headers['x-forwarded-host'])) || first(req.headers.host)
      let oh = ''
      try { oh = new URL(origin).host.toLowerCase() } catch { /* bad origin */ }
      if (!oh || oh !== host) return reject(socket, 403, 'Forbidden')
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const cfg = effectiveRealtime(deps, over)
      if (!cfg.url) {
        ws.send(JSON.stringify({ type: 'error', code: 'not_configured', message: 'Realtime speech recognition is not configured.' } satisfies RealtimeServerEvent))
        return ws.close(CLOSE.notConfigured, 'not configured')
      }
      // One session per user: a newer one (another tab, a reload) replaces the old one.
      const old = byUser.get(user.id)
      if (old) old.fail(CLOSE.replaced, 'busy', 'replaced by a newer session')
      if (sessions.size >= cfg.maxSessions) {
        ws.send(JSON.stringify({ type: 'error', code: 'busy', message: 'Too many realtime sessions.' } satisfies RealtimeServerEvent))
        return ws.close(CLOSE.busy, 'too many realtime sessions')
      }
      const s = new RealtimeSession(ws, cfg, (sess, info) => {
        sessions.delete(sess)
        if (byUser.get(user.id) === sess) byUser.delete(user.id)
        // Durations and codes only: never audio or text.
        console.log(`[realtime] session end user=${user.id} code=${info.code} reason="${info.reason}" audio=${info.audioSeconds}s finals=${info.finals} wall=${(info.ms / 1000).toFixed(1)}s`)
      })
      sessions.add(s)
      byUser.set(user.id, s)
      s.start()
    })
  }
  server.on('upgrade', onUpgrade)
  return {
    sessions,
    close() {
      server.off('upgrade', onUpgrade)
      for (const s of [...sessions]) s.end(CLOSE.idle, 'server shutting down')
      wss.close()
    },
  }
}
