import { CLOSE, REALTIME_PATH, classifyClose, type DegradeReason, type RealtimeErrorCode, type RealtimeServerEvent } from '../../../shared/realtime'

export type { DegradeReason } from '../../../shared/realtime'

export interface RealtimeHandlers {
  onReady?: () => void
  /**
   * Whole current hypothesis of segment `seg` (replaces the previous partial). `audioEnd`: seconds on
   * the local audio timeline (from the first frame offered to sendPcm) the text covers at most.
   */
  onPartial: (seg: number, text: string, audioEnd: number) => void
  onFinal: (seg: number, text: string, audioEnd: number) => void
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
        case 'partial': this.h.onPartial(ev.seg, ev.text, this.localTime(ev.audioEnd)); break
        case 'final': this.h.onFinal(ev.seg, ev.text, this.localTime(ev.audioEnd)); break
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

  /** Seconds of audio offered to sendPcm so far (the local timeline), and the part of it actually sent. */
  offeredSeconds = 0
  private sentSeconds = 0
  /** Dropped stretches, by the sent-audio time they were dropped at, to map server times back. */
  private drops: { sentAt: number; len: number }[] = []

  /** Server audio time (counts only frames that reached it) -> local audio time. */
  localTime(serverSeconds: number | undefined): number {
    if (typeof serverSeconds !== 'number' || !Number.isFinite(serverSeconds)) return this.offeredSeconds
    let t = serverSeconds
    for (const d of this.drops) if (d.sentAt <= serverSeconds + 1e-6) t += d.len
    return t
  }

  private drop(len: number) {
    this.dropped++
    const last = this.drops[this.drops.length - 1]
    if (last && last.sentAt === this.sentSeconds) last.len += len
    else this.drops.push({ sentAt: this.sentSeconds, len })
  }

  /** Sends one PCM16 frame. Frames are dropped (not queued without bound) when the network is slow. */
  sendPcm(frame: Uint8Array<ArrayBuffer>) {
    if (this.ended) return
    const len = frame.length / 2 / 16000
    this.offeredSeconds += len
    const ws = this.ws
    if (!ws || ws.readyState === 0) { if (this.queue.length < 300) { this.queue.push(frame); this.sentSeconds += len } else this.drop(len); return }
    if (ws.readyState !== 1) return
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { this.drop(len); return }
    ws.send(frame)
    this.sentSeconds += len
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

const isContent = (c: string) => /[\p{L}\p{N}]/u.test(c)
const LATIN = /[A-Za-z0-9']/

/**
 * Trims the start of a caption that the committed (segment model) text already covers.
 * The caption covers audio [start, end]; the committed text covers audio up to `boundary`.
 * First estimate: cut at the time-proportional character position. Then refine: look for the last few
 * letters of the committed text inside the caption near that estimate (both models usually agree on
 * a couple of words at the boundary) and cut right after them. Without a match, the estimate is moved
 * to the end of a Latin word so English is not cut in half. Leading punctuation is dropped.
 */
export function trimCaption(text: string, start: number, end: number, boundary: number, committedTail: string): string {
  if (boundary <= start) return text
  if (boundary >= end) return ''
  const chars = [...text]
  let k = Math.round(chars.length * Math.min(1, Math.max(0, (boundary - start) / Math.max(1e-3, end - start))))
  const pos: number[] = [], low: string[] = []
  chars.forEach((c, i) => { if (isContent(c)) { pos.push(i); low.push(c.toLowerCase()) } })
  const tail = [...committedTail].filter(isContent).map((c) => c.toLowerCase())
  const win = Math.max(6, Math.round(chars.length * 0.35))
  let found = false
  for (const n of [4, 3, 2]) {
    if (tail.length < n) continue
    const key = tail.slice(-n).join('')
    let best = -1
    for (let j = 0; j + n <= low.length; j++) {
      if (low.slice(j, j + n).join('') !== key) continue
      const after = pos[j + n - 1] + 1
      if (Math.abs(after - k) <= win && (best < 0 || Math.abs(after - k) < Math.abs(best - k))) best = after
    }
    if (best >= 0) { k = best; found = true; break }
  }
  if (!found) { let m = 0; while (k > 0 && k < chars.length && LATIN.test(chars[k - 1]) && LATIN.test(chars[k]) && m++ < 16) k++ }
  return chars.slice(k).join('').replace(/^[\s\p{P}]+/u, '')
}

export interface CaptionSeg { seg: number; text: string; start: number; end: number; final: boolean }

/**
 * Captions shown while recording, on the local audio timeline (seconds since recording started).
 * Each realtime segment spans [end of the previous final, its latest audioEnd]. The segment model's
 * text commits audio in order up to a boundary (the cut time of the last transcribed segment); a
 * caption ending before the boundary is hidden, one that straddles it is trimmed (trimCaption), so a
 * caption never repeats text that is already in the document.
 */
export class LiveCaptions {
  segs: CaptionSeg[] = []
  /** Audio (seconds) whose text is committed. */
  committedUntil = 0
  /** End of the committed text, for aligning the trim. */
  committedTail = ''
  private lastFinalEnd = 0
  /** A caption ending this close after the boundary counts as covered (VAD end vs. quiet-point cut). */
  constructor(private margin = 0.25) {}

  private entry(seg: number): CaptionSeg {
    let e = this.segs.find((x) => x.seg === seg)
    if (!e) { e = { seg, text: '', start: this.lastFinalEnd, end: this.lastFinalEnd, final: false }; this.segs.push(e) }
    return e
  }
  setPartial(seg: number, text: string, end: number) {
    const e = this.entry(seg)
    if (e.final) return
    e.text = text; e.end = Math.max(e.end, end)
  }
  addFinal(seg: number, text: string, end: number) {
    const e = this.entry(seg)
    e.text = text; e.end = Math.max(e.end, end); e.final = true
    this.lastFinalEnd = Math.max(this.lastFinalEnd, e.end)
    // Drop empty finals and partials of segments that are finished now.
    this.segs = this.segs.filter((x) => x.text.trim() && (x.final || x.seg > seg))
    this.prune()
  }
  /** Text for audio up to `until` (seconds) is now in the document. */
  commit(until: number, text: string) {
    this.committedUntil = Math.max(this.committedUntil, until)
    if (text) this.committedTail = (this.committedTail + text).slice(-80)
    this.prune()
  }
  private prune() { this.segs = this.segs.filter((x) => !(x.final && x.end <= this.committedUntil + this.margin)) }
  clear() { this.segs = []; this.committedUntil = 0; this.committedTail = ''; this.lastFinalEnd = 0 }

  private visible(x: CaptionSeg): string {
    if (x.end <= this.committedUntil + this.margin) return ''
    return trimCaption(x.text, x.start, x.end, this.committedUntil, this.committedTail)
  }
  view(join: (a: string, b: string) => string): { done: string; partial: string } {
    const finals = this.segs.filter((x) => x.final).sort((a, b) => a.seg - b.seg)
    const partial = this.segs.filter((x) => !x.final).sort((a, b) => b.seg - a.seg)[0]
    return { done: finals.reduce((acc, x) => join(acc, this.visible(x)), ''), partial: partial ? this.visible(partial) : '' }
  }
}

/**
 * Single-pass mode: segments cut by the recorder while realtime finals are the text, keyed by the time
 * their audio ends. Each is kept until a final whose audio extends `lag` past it arrives (then the final
 * covers it); if live captions drop out, the rest goes to the segmented model. Errs on the side of
 * repeating a few words rather than losing any. Any time unit works (the app uses audio seconds).
 */
export class HeldSegments<T> {
  private items: { value: T; at: number }[] = []
  private lastFinalAt = 0
  constructor(private lag = 2) {}
  push(value: T, at: number) { this.items.push({ value, at }) }
  /** A realtime final arrived at `at`. */
  final(at: number) { this.lastFinalAt = at; this.items = this.items.filter((h) => h.at > at - this.lag) }
  /** Segments not covered by a final yet (and forget them). */
  take(): T[] { const out = this.items.filter((h) => h.at > this.lastFinalAt - this.lag).map((h) => h.value); this.items = []; return out }
  get size() { return this.items.length }
}
