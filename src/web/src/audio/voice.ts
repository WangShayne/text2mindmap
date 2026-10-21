import { ASR_SAMPLE_RATE, downmix, encodeWav, quietestPoint, resample } from '../../../shared/wav'

export const MAX_AUDIO_FILE_BYTES = 300 * 1024 * 1024

export class TranscribeError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message) }
}

/** Decodes any format the browser can play into 16 kHz mono samples (the browser resamples). */
export async function decodeToMono16k(file: Blob): Promise<Float32Array> {
  const data = await file.arrayBuffer()
  const Ctx = (window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext)
  const ctx = new Ctx(1, 1, ASR_SAMPLE_RATE)
  const buf = await ctx.decodeAudioData(data)
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i))
  const mono = downmix(chans)
  return buf.sampleRate === ASR_SAMPLE_RATE ? mono : resample(mono, buf.sampleRate, ASR_SAMPLE_RATE)
}

/** Sends one 16 kHz mono segment as WAV to /api/transcribe. */
export async function transcribeSamples(samples: Float32Array, opts: { language?: string; name?: string; signal?: AbortSignal }): Promise<string> {
  const q = new URLSearchParams()
  if (opts.language && opts.language !== 'auto') q.set('language', opts.language)
  if (opts.name) q.set('name', opts.name)
  const res = await fetch(`/api/transcribe${q.toString() ? `?${q}` : ''}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'audio/wav' },
    body: new Blob([encodeWav(samples, ASR_SAMPLE_RATE)], { type: 'audio/wav' }),
    signal: opts.signal,
  })
  const data = (await res.json().catch(() => null)) as { ok?: boolean; text?: string; code?: string; message?: string; error?: string } | null
  if (res.ok && data?.ok) return data.text ?? ''
  throw new TranscribeError(data?.message ?? data?.error ?? `HTTP ${res.status}`, data?.code ?? 'http', res.status)
}

/** Transcribes with one retry for transient failures (network, timeout, 5xx). */
export async function transcribeWithRetry(samples: Float32Array, opts: { language?: string; name?: string; signal?: AbortSignal }): Promise<string> {
  try { return await transcribeSamples(samples, opts) } catch (e) {
    if (opts.signal?.aborted) throw e
    const code = e instanceof TranscribeError ? e.code : 'network'
    if (!['network', 'timeout', 'upstream', 'rate_limit'].includes(code)) throw e
    await new Promise((r) => setTimeout(r, 1500))
    return transcribeSamples(samples, opts)
  }
}

export const micSupport = (): 'ok' | 'insecure' | 'unsupported' =>
  !window.isSecureContext ? 'insecure' : typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'ok' : 'unsupported'

/**
 * Captures the microphone as PCM and hands over self-contained 16 kHz segments of about
 * `segmentSeconds`, cut at the quietest point of the last 1.5 s so words stay whole.
 */
export class MicRecorder {
  private ctx?: AudioContext
  private stream?: MediaStream
  private node?: ScriptProcessorNode
  private chunks: Float32Array[] = []
  private length = 0
  private rate = 48000

  constructor(private segmentSeconds: number, private onSegment: (samples16k: Float32Array) => void, private onLevel?: (rms: number) => void) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    this.ctx = new AudioContext()
    this.rate = this.ctx.sampleRate
    const src = this.ctx.createMediaStreamSource(this.stream)
    // ScriptProcessorNode is deprecated but works everywhere without a separate worklet file.
    this.node = this.ctx.createScriptProcessor(4096, 1, 1)
    this.node.onaudioprocess = (e) => {
      const d = new Float32Array(e.inputBuffer.getChannelData(0))
      this.chunks.push(d); this.length += d.length
      if (this.onLevel) { let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * d[i]; this.onLevel(Math.sqrt(s / (d.length / 4))) }
      if (this.length >= this.segmentSeconds * this.rate) this.cut(false)
    }
    const mute = this.ctx.createGain(); mute.gain.value = 0
    src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination)
  }

  private cut(final: boolean) {
    if (!this.length) return
    const all = new Float32Array(this.length)
    let o = 0
    for (const c of this.chunks) { all.set(c, o); o += c.length }
    const end = final ? all.length : quietestPoint(all, this.rate, all.length - Math.round(1.5 * this.rate), all.length)
    const rest = all.subarray(end)
    this.chunks = rest.length ? [rest.slice()] : []
    this.length = rest.length
    const seg = all.subarray(0, end)
    // Skip segments that are (almost) silent: nothing to transcribe.
    let peak = 0
    for (let i = 0; i < seg.length; i += 8) peak = Math.max(peak, Math.abs(seg[i]))
    if (seg.length > this.rate * 0.3 && peak > 0.01) this.onSegment(resample(seg, this.rate, ASR_SAMPLE_RATE))
  }

  async stop() {
    if (this.node) this.node.onaudioprocess = null
    this.cut(true)
    this.stream?.getTracks().forEach((t) => t.stop())
    await this.ctx?.close().catch(() => {})
    this.node = undefined; this.ctx = undefined; this.stream = undefined
  }
}
