import crypto from 'node:crypto'
import { redact } from './llm'
import { encodeWav } from '../shared/wav'

export interface AsrConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number }

export type AsrErrorCode = 'not_configured' | 'auth' | 'not_found' | 'too_large' | 'unsupported' | 'rate_limit' | 'timeout' | 'network' | 'bad_response' | 'upstream' | 'aborted'
export type AsrResult = { ok: true; text: string } | { ok: false; code: AsrErrorCode; message: string; status?: number }

/**
 * Removes model control markup from a transcript:
 * - SenseVoice tags such as <|zh|><|NEUTRAL|><|Speech|><|withitn|>;
 * - Qwen3-ASR's "language Chinese<asr_text>" prefix (llama.cpp llama-server returns it verbatim;
 *   "language None<asr_text>" means no speech), plus any stray <asr_text> / </asr_text> tag.
 * Requires the literal <asr_text> tag, so ordinary text such as "language English is hard" is kept.
 */
export function cleanTranscript(s: string): string {
  return s
    .replace(/<\|[^|<>]{0,40}\|>/g, '')
    .replace(/language[ \t]+[A-Za-z][A-Za-z _-]{0,30}?[ \t]*<asr_text>/g, '')
    .replace(/<\/?asr_text>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** Pulls the transcript out of a json / verbose_json / text response. Undefined when the shape is unknown. */
export function parseTranscription(body: string, contentType: string): string | undefined {
  const trimmed = body.trim()
  const looksJson = /json/i.test(contentType) || trimmed.startsWith('{') || trimmed.startsWith('[')
  if (looksJson) {
    let j: unknown
    try { j = JSON.parse(trimmed) } catch { return /json/i.test(contentType) ? undefined : cleanTranscript(trimmed) }
    if (typeof j === 'string') return cleanTranscript(j)
    const pick = (o: unknown): string | undefined => {
      if (!o || typeof o !== 'object') return undefined
      const r = o as Record<string, unknown>
      for (const k of ['text', 'transcript', 'transcription', 'result']) {
        const v = r[k]
        if (typeof v === 'string') return v
        if (v && typeof v === 'object') { const d = pick(v); if (d !== undefined) return d }
      }
      if (Array.isArray(r.segments)) return (r.segments as { text?: unknown }[]).map((x) => (typeof x?.text === 'string' ? x.text : '')).join('')
      if (Array.isArray(r.results)) return (r.results as unknown[]).map((x) => pick(x) ?? '').join('')
      return undefined
    }
    const t = Array.isArray(j) ? j.map((x) => pick(x) ?? (typeof x === 'string' ? x : '')).join('') : pick(j)
    return t === undefined ? undefined : cleanTranscript(t)
  }
  if (/^\s*</.test(trimmed)) return undefined // HTML login page etc.
  return cleanTranscript(trimmed)
}

function classify(status: number, body: string, baseUrl: string): AsrResult {
  const short = body.replace(/\s+/g, ' ').slice(0, 300)
  if (status === 401 || status === 403) return { ok: false, code: 'auth', status, message: `The ASR API key was rejected (HTTP ${status}). ${short}` }
  if (status === 404 || status === 405) return { ok: false, code: 'not_found', status, message: `${baseUrl}/audio/transcriptions was not found (HTTP ${status}). Check the ASR Base URL; it usually ends with /v1. ${short}` }
  if (status === 413) return { ok: false, code: 'too_large', status, message: `The ASR server says the audio is too large (HTTP 413). Lower "Max segment length" in Settings. ${short}` }
  if (status === 415) return { ok: false, code: 'unsupported', status, message: `The ASR server does not accept this audio format (HTTP 415). ${short}` }
  if (status === 429) return { ok: false, code: 'rate_limit', status, message: `ASR rate limited or out of quota (HTTP 429). ${short}` }
  if (status === 400 && /(duration|too long|seconds|length)/i.test(body)) return { ok: false, code: 'too_large', status, message: `The ASR server rejected the segment length (HTTP 400). Lower "Max segment length" in Settings. ${short}` }
  return { ok: false, code: 'upstream', status, message: `The ASR server returned HTTP ${status}. ${short}` }
}

export interface TranscribeInput {
  /** Audio bytes; streamed to the upstream unchanged. */
  audio: ReadableStream<Uint8Array> | Uint8Array
  /** Exact number of audio bytes (required for a streamed upload with Content-Length). */
  size: number
  filename: string
  contentType: string
  language?: string
  prompt?: string
  signal?: AbortSignal
}

const safeName = (s: string) => s.replace(/[^\w.\-]/g, '_').slice(0, 80) || 'audio.wav'

/**
 * POST {baseUrl}/audio/transcriptions as multipart/form-data. The audio is streamed through
 * (not buffered) between a precomputed multipart head and tail, with an exact Content-Length.
 * Never throws; error messages are redacted.
 */
export async function transcribe(cfg: AsrConfig, input: TranscribeInput): Promise<AsrResult> {
  const fail = (r: AsrResult): AsrResult => (r.ok ? r : { ...r, message: redact(r.message, cfg.apiKey) })
  if (!cfg.baseUrl || !cfg.model) return { ok: false, code: 'not_configured', message: 'Speech recognition is not configured. Ask the admin to set the ASR Base URL and model in Settings.' }
  const boundary = `----t2m${crypto.randomBytes(12).toString('hex')}`
  const enc = new TextEncoder()
  const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  let headText = field('model', cfg.model) + field('response_format', 'json')
  if (input.language) headText += field('language', input.language)
  if (input.prompt) headText += field('prompt', input.prompt)
  headText += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName(input.filename)}"\r\nContent-Type: ${input.contentType}\r\n\r\n`
  const head = enc.encode(headText)
  const tail = enc.encode(`\r\n--${boundary}--\r\n`)
  const audio = input.audio
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(head)
      if (audio instanceof Uint8Array) c.enqueue(audio)
      else {
        const reader = audio.getReader()
        for (;;) { const r = await reader.read(); if (r.done) break; c.enqueue(r.value) }
      }
      c.enqueue(tail)
      c.close()
    },
  })
  const timeout = AbortSignal.timeout(cfg.timeoutMs)
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout
  let res: Response
  try {
    res = await fetch(cfg.baseUrl + '/audio/transcriptions', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(head.length + input.size + tail.length),
        accept: 'application/json, text/plain',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body,
      duplex: 'half',
      signal,
    } as RequestInit)
  } catch (e) {
    if (input.signal?.aborted) return { ok: false, code: 'aborted', message: 'The upload was cancelled.' }
    if (timeout.aborted) return fail({ ok: false, code: 'timeout', message: `The ASR server did not answer within ${Math.round(cfg.timeoutMs / 1000)}s.` })
    const err = e as Error & { cause?: { code?: string; message?: string } }
    return fail({ ok: false, code: 'network', message: `Could not reach ${cfg.baseUrl} (${err.cause?.code ?? err.cause?.message ?? err.message}). Check the ASR Base URL and that the server is reachable from this machine.` })
  }
  let text: string
  try { text = await res.text() } catch {
    return fail({ ok: false, code: timeout.aborted ? 'timeout' : 'network', message: timeout.aborted ? `The ASR server did not answer within ${Math.round(cfg.timeoutMs / 1000)}s.` : 'The connection to the ASR server broke while reading the answer.' })
  }
  if (!res.ok) return fail(classify(res.status, text, cfg.baseUrl))
  const parsed = parseTranscription(text, res.headers.get('content-type') ?? '')
  if (parsed === undefined) return fail({ ok: false, code: 'bad_response', message: `The ASR server answered, but not with a transcription (expected JSON with a "text" field). Check the Base URL. Response starts with: ${text.replace(/\s+/g, ' ').slice(0, 200) || '(empty)'}` })
  return { ok: true, text: parsed }
}

/** Sends one second of silence to check URL, key and model. */
export async function testAsr(cfg: AsrConfig): Promise<AsrResult & { latencyMs?: number }> {
  const wav = new Uint8Array(encodeWav(new Float32Array(16_000), 16_000))
  const t0 = Date.now()
  const r = await transcribe({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 30_000) }, { audio: wav, size: wav.length, filename: 'test.wav', contentType: 'audio/wav' })
  return r.ok ? { ...r, latencyMs: Date.now() - t0 } : r
}
