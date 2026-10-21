import { CLOSE, REALTIME_PATH, classifyClose, type DegradeReason, type RealtimeErrorCode, type RealtimeServerEvent } from '../../../shared/realtime'

export type { DegradeReason } from '../../../shared/realtime'

export interface RealtimeHandlers {
  onReady?: () => void
  /** Whole current hypothesis of segment `seg` (replaces the previous partial). */
  onPartial: (seg: number, text: string) => void
  onFinal: (seg: number, text: string) => void
  /** The session ended abnormally (called once). The caller falls back to segmented recognition. */
  onDegrade: (reason: DegradeReason) => void
  /** All finals are in after stop(). */
  onDone?: () => void
}

type WsCtor = new (url: string) => WebSocket

/** Same-origin ws(s)://host/api/realtime for the current page. */
export const realtimeUrl = (loc: { protocol: string; host: string } = location) => `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${REALTIME_PATH}`

const reasonOf = (code: RealtimeErrorCode | undefined): DegradeReason | undefined =>
  code === 'idle' ? 'idle' : code === 'busy' ? 'busy' : code === 'too_long' ? 'too_long' : code ? 'unavailable' : undefined

/** Max audio queued in the socket before frames are dropped (about 2 s): live captions are best effort. */
export const MAX_BUFFERED_BYTES = 64 * 1024

/**
 * Browser side of /api/realtime: streams PCM16 frames, reports partial / final captions, and turns
 * any abnormal end (close codes 1001 idle, 1008 busy, 1009 too long, 1006 / 1011 / errors) into a
 * single onDegrade(reason) call.
 */
export class RealtimeClient {
  private ws?: WebSocket
  private queue: Uint8Array<ArrayBuffer>[] = []
  private ended = false
  private byUs = false
  private done = false
  private lastError?: RealtimeErrorCode
  private stopWaiters: (() => void)[] = []
  private readyTimer?: ReturnType<typeof setTimeout>
  /** Frames dropped because the network could not keep up. */
  dropped = 0
  ready = false

  constructor(private url: string, private h: RealtimeHandlers, private opts: { WebSocketImpl?: WsCtor; connectTimeoutMs?: number; stopTimeoutMs?: number } = {}) {}

  get active() { return !this.ended }

  connect() {
    const Ws = this.opts.WebSocketImpl ?? WebSocket
    let ws: WebSocket
    try { ws = new Ws(this.url) } catch { return this.degrade('unavailable') }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.readyTimer = setTimeout(() => { if (!this.ready) this.degrade('unavailable') }, this.opts.connectTimeoutMs ?? 6000)
    ws.onopen = () => { for (const f of this.queue) ws.send(f); this.queue = [] }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      let ev: RealtimeServerEvent
      try { ev = JSON.parse(e.data) } catch { return }
      switch (ev.type) {
        case 'ready': this.ready = true; clearTimeout(this.readyTimer); this.h.onReady?.(); break
        case 'partial': this.h.onPartial(ev.seg, ev.text); break
        case 'final': this.h.onFinal(ev.seg, ev.text); break
        case 'error': this.lastError = ev.code; break
        case 'done': this.done = true; this.h.onDone?.(); this.release(); break
      }
    }
    ws.onclose = (e) => {
      if (this.done || this.byUs) return this.release()
      this.degrade(reasonOf(this.lastError) ?? classifyClose(e.code) ?? 'unavailable')
    }
    // An error is always followed by a close event, which decides.
    ws.onerror = () => {}
  }

  /** Sends one PCM16 frame. Frames are dropped (not queued without bound) when the network is slow. */
  sendPcm(frame: Uint8Array<ArrayBuffer>) {
    if (this.ended) return
    const ws = this.ws
    if (!ws || ws.readyState === 0) { if (this.queue.length < 60) this.queue.push(frame); else this.dropped++; return }
    if (ws.readyState !== 1) return
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { this.dropped++; return }
    ws.send(frame)
  }

  /** End of audio: resolves once the last final arrived, or the session degraded / timed out. */
  stop(): Promise<void> {
    if (this.ended) return Promise.resolve()
    const p = new Promise<void>((r) => this.stopWaiters.push(r))
    const ws = this.ws
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }))
    else if (ws?.readyState === 0) { const prev = ws.onopen; ws.onopen = (e) => { prev?.call(ws, e); ws.send(JSON.stringify({ type: 'stop' })) } }
    const t = setTimeout(() => { if (!this.ended) this.degrade('unavailable') }, this.opts.stopTimeoutMs ?? 20_000)
    return p.finally(() => clearTimeout(t))
  }

  /** Closes without a degrade notice (cancel, or the batch model has the final text anyway). */
  close() {
    if (this.ended) return
    this.byUs = true
    try { this.ws?.close(CLOSE.normal) } catch { /* ignore */ }
    this.release()
  }

  private degrade(reason: DegradeReason) {
    if (this.ended) return
    this.release()
    try { if (this.ws && this.ws.readyState <= 1) this.ws.close(CLOSE.normal) } catch { /* ignore */ }
    this.h.onDegrade(reason)
  }

  private release() {
    if (this.ended) { this.flushWaiters(); return }
    this.ended = true
    clearTimeout(this.readyTimer)
    this.queue = []
    this.flushWaiters()
  }

  private flushWaiters() { const w = this.stopWaiters; this.stopWaiters = []; for (const f of w) f() }
}

/**
 * Captions shown while recording: finals not yet replaced by the batch model's text, plus the
 * current partial. Finals carry the time they arrived; a segment transcribed by the batch model
 * covers all audio up to its cut time, so dropUntil(cutTime) removes the captions it replaces.
 */
export class LiveCaptions {
  finals: { seg: number; text: string; at: number }[] = []
  partial: { seg: number; text: string } | null = null

  setPartial(seg: number, text: string) { this.partial = { seg, text } }
  addFinal(seg: number, text: string, at: number) {
    if (this.partial && this.partial.seg <= seg) this.partial = null
    if (text.trim()) this.finals.push({ seg, text, at })
  }
  /** Removes finals that arrived before `t`. */
  dropUntil(t: number) { this.finals = this.finals.filter((f) => f.at > t) }
  clear() { this.finals = []; this.partial = null }
  view(join: (a: string, b: string) => string): { done: string; partial: string } {
    return { done: this.finals.reduce((acc, f) => join(acc, f.text), ''), partial: this.partial?.text ?? '' }
  }
}

/**
 * Single-pass mode: segments cut by the recorder while realtime finals are the text. Each is kept
 * until a final arrives well after it was cut (then the final covers it); if live captions drop out,
 * the rest goes to the segmented model. `lagMs` is how late a final may arrive for its audio. Errs on
 * the side of repeating a few words rather than losing any.
 */
export class HeldSegments<T> {
  private items: { value: T; at: number }[] = []
  private lastFinalAt = 0
  constructor(private lagMs = 2000) {}
  push(value: T, at: number) { this.items.push({ value, at }) }
  /** A realtime final arrived at `at`. */
  final(at: number) { this.lastFinalAt = at; this.items = this.items.filter((h) => h.at > at - this.lagMs) }
  /** Segments not covered by a final yet (and forget them). */
  take(): T[] { const out = this.items.filter((h) => h.at > this.lastFinalAt - this.lagMs).map((h) => h.value); this.items = []; return out }
  get size() { return this.items.length }
}
