export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
  timeoutMs: number
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export type LlmErrorCode = 'auth' | 'network' | 'not_found' | 'model' | 'rate_limit' | 'timeout' | 'bad_response' | 'upstream' | 'not_configured' | 'aborted'

export class LlmError extends Error {
  constructor(public code: LlmErrorCode, message: string, public status?: number) {
    super(message)
  }
}

export function redact(s: string, key: string): string {
  if (!key || key.length < 4) return s
  return s.split(key).join('***')
}

function classify(status: number, body: string): LlmError {
  const short = body.slice(0, 300)
  const mentionsModel = /model/i.test(body) && /(not[ _-]?found|does not exist|invalid|unknown|no such|not exist|不存在|无效)/i.test(body)
  if (status === 401 || status === 403) return new LlmError('auth', `The API key was rejected (HTTP ${status}). ${short}`, status)
  if (mentionsModel) return new LlmError('model', `The model was not found (HTTP ${status}). ${short}`, status)
  if (status === 404) return new LlmError('not_found', `Endpoint not found (HTTP 404). Check the Base URL; it usually ends with /v1. ${short}`, status)
  if (status === 429) return new LlmError('rate_limit', `Rate limited or out of quota (HTTP 429). ${short}`, status)
  return new LlmError('upstream', `The LLM server returned HTTP ${status}. ${short}`, status)
}

function linkSignals(outer: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const ctrl = new AbortController()
  let timed = false
  const t = setTimeout(() => { timed = true; ctrl.abort() }, timeoutMs)
  const onAbort = () => ctrl.abort()
  if (outer) { if (outer.aborted) ctrl.abort(); else outer.addEventListener('abort', onAbort, { once: true }) }
  return { signal: ctrl.signal, timedOut: () => timed, dispose: () => { clearTimeout(t); outer?.removeEventListener('abort', onAbort) } }
}

async function post(cfg: LlmConfig, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  if (!cfg.baseUrl || !cfg.model) throw new LlmError('not_configured', 'The LLM is not configured. Ask the admin to set the Base URL and model.')
  let res: Response
  try {
    res = await fetch(cfg.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (signal.aborted) throw e
    const cause = (e as { cause?: { code?: string; message?: string } }).cause
    throw new LlmError('network', `Could not reach ${cfg.baseUrl} (${cause?.code ?? cause?.message ?? (e as Error).message}). Check the Base URL and network.`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw classify(res.status, redact(text, cfg.apiKey))
  }
  return res
}

/** Removes <think>...</think> blocks from a token stream. */
export class ThinkFilter {
  private inThink = false
  private buf = ''
  push(chunk: string): string {
    this.buf += chunk
    let out = ''
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>')
        if (end === -1) { this.buf = this.buf.slice(-8); return out }
        this.buf = this.buf.slice(end + 8)
        this.inThink = false
      } else {
        const start = this.buf.indexOf('<think>')
        if (start === -1) {
          let hold = 0
          for (let k = Math.min(6, this.buf.length); k > 0; k--) {
            if ('<think>'.startsWith(this.buf.slice(-k))) { hold = k; break }
          }
          out += this.buf.slice(0, this.buf.length - hold)
          this.buf = this.buf.slice(this.buf.length - hold)
          return out
        }
        out += this.buf.slice(0, start)
        this.buf = this.buf.slice(start + 7)
        this.inThink = true
      }
    }
  }
  flush(): string {
    const r = this.inThink ? '' : this.buf
    this.buf = ''
    return r
  }
}

/** Streams a chat completion; calls onDelta for each content piece; returns the full text. */
export async function streamChat(cfg: LlmConfig, messages: ChatMessage[], onDelta: (t: string) => void, outer?: AbortSignal, maxTokens?: number): Promise<string> {
  const { signal, timedOut, dispose } = linkSignals(outer, cfg.timeoutMs)
  const filter = new ThinkFilter()
  let full = ''
  const emit = (t: string) => { const f = filter.push(t); if (f) { full += f; onDelta(f) } }
  try {
    const body: Record<string, unknown> = { model: cfg.model, messages, stream: true }
    if (cfg.temperature !== undefined) body.temperature = cfg.temperature
    if (maxTokens) body.max_tokens = maxTokens
    const res = await post(cfg, '/chat/completions', body, signal)
    const ctype = res.headers.get('content-type') ?? ''
    if (!ctype.includes('text/event-stream')) {
      // Some servers ignore stream:true and answer with plain JSON.
      const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null
      const content = json?.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new LlmError('bad_response', 'The LLM server returned an unexpected response (not an OpenAI-compatible chat completion).')
      emit(content)
    } else {
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let done = false
      while (!done) {
        const r = await reader.read()
        if (r.done) break
        buf += dec.decode(r.value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') { done = true; break }
          try {
            const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; error?: { message?: string } }
            if (j.error) throw new LlmError('upstream', `LLM error: ${redact(String(j.error.message ?? 'unknown'), cfg.apiKey)}`)
            const c = j.choices?.[0]?.delta?.content
            if (c) emit(c)
          } catch (e) {
            if (e instanceof LlmError) throw e
          }
        }
      }
      reader.cancel().catch(() => {})
    }
    const rest = filter.flush()
    if (rest) { full += rest; onDelta(rest) }
    return full
  } catch (e) {
    if (timedOut()) throw new LlmError('timeout', `The LLM did not finish within ${Math.round(cfg.timeoutMs / 1000)}s.`)
    if (outer?.aborted) throw new LlmError('aborted', 'Generation was stopped.')
    if (e instanceof LlmError) throw e
    throw new LlmError('network', `Connection to the LLM failed: ${redact((e as Error).message, cfg.apiKey)}`)
  } finally {
    dispose()
  }
}

export interface TestResult { ok: boolean; code?: LlmErrorCode; message: string; models?: number; latencyMs?: number }

/** Checks base URL, key and model with GET /models and a 1-token chat completion. */
export async function testConnection(cfg: LlmConfig): Promise<TestResult> {
  const t0 = Date.now()
  let modelList: string[] | undefined
  try {
    const res = await fetch(cfg.baseUrl + '/models', { headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}, signal: AbortSignal.timeout(15_000) })
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'auth', message: `The API key was rejected (HTTP ${res.status}).` }
    if (res.ok) {
      modelList = parseModelList(await res.json().catch(() => null))
    }
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause
    return { ok: false, code: 'network', message: `Could not reach ${cfg.baseUrl} (${cause?.code ?? (e as Error).name}). Check the Base URL and that the server is reachable from this machine.` }
  }
  try {
    const text = await streamChat({ ...cfg, timeoutMs: 30_000 }, [{ role: 'user', content: 'Reply with: ok' }], () => {}, undefined, 5)
    return { ok: true, message: `Connected. Model "${cfg.model}" replied${text ? `: ${text.slice(0, 40)}` : ''}.`, models: modelList?.length, latencyMs: Date.now() - t0 }
  } catch (e) {
    const err = e as LlmError
    if (err.code === 'not_found' && modelList) {
      return { ok: false, code: 'model', message: `The server answered, but chat failed with 404. Model "${cfg.model}" is probably unknown. Available: ${modelList.slice(0, 10).join(', ')}` }
    }
    if (err.code === 'model' && modelList) return { ok: false, code: 'model', message: `${err.message} Available: ${modelList.slice(0, 10).join(', ')}` }
    return { ok: false, code: err.code ?? 'upstream', message: err.message }
  }
}

/**
 * Pulls model ids out of a /models response. Accepts the OpenAI shape ({ data: [{ id }] }) and the
 * variants some providers use: a bare array, { models: [...] }, items that are strings or carry
 * `name`/`model` instead of `id`. Returns undefined when nothing recognisable is found.
 */
export function parseModelList(json: unknown): string[] | undefined {
  const pickArray = (v: unknown): unknown[] | undefined => {
    if (Array.isArray(v)) return v
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const k of ['data', 'models', 'items', 'result']) {
        const inner = o[k]
        if (Array.isArray(inner)) return inner
        if (inner && typeof inner === 'object') { const deep = pickArray(inner); if (deep) return deep }
      }
    }
    return undefined
  }
  const arr = pickArray(json)
  if (!arr) return undefined
  const ids = arr
    .map((m) => {
      if (typeof m === 'string') return m
      if (m && typeof m === 'object') {
        const o = m as Record<string, unknown>
        const v = o.id ?? o.name ?? o.model
        return typeof v === 'string' ? v : undefined
      }
      return undefined
    })
    .filter((s): s is string => !!s && !!s.trim())
    .map((s) => s.trim())
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }))
}

export type ModelListResult = { ok: true; models: string[] } | { ok: false; code: LlmErrorCode; message: string }

/** GET {baseUrl}/models with the given key. Never throws; error messages are redacted. */
export async function listModels(baseUrl: string, apiKey: string, timeoutMs = 15_000): Promise<ModelListResult> {
  const fail = (code: LlmErrorCode, message: string): ModelListResult => ({ ok: false, code, message: redact(message, apiKey) })
  if (!baseUrl) return fail('not_configured', 'Base URL is empty.')
  let res: Response
  try {
    res = await fetch(baseUrl + '/models', {
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } }
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return fail('timeout', `${baseUrl}/models did not answer within ${Math.round(timeoutMs / 1000)}s.`)
    return fail('network', `Could not reach ${baseUrl} (${err.cause?.code ?? err.cause?.message ?? err.message}). Check the Base URL and that the server is reachable from this machine.`)
  }
  const text = await res.text().catch(() => '')
  const short = text.replace(/\s+/g, ' ').slice(0, 200)
  if (res.status === 401 || res.status === 403) return fail('auth', `The API key was rejected (HTTP ${res.status}). ${short}`)
  if (res.status === 404 || res.status === 405) return fail('not_found', `This provider does not offer a model list (HTTP ${res.status} on ${baseUrl}/models). Check the Base URL (it usually ends with /v1), or type the model name by hand.`)
  if (res.status === 429) return fail('rate_limit', `Rate limited (HTTP 429). ${short}`)
  if (!res.ok) return fail('upstream', `The server returned HTTP ${res.status}. ${short}`)
  let json: unknown
  try { json = JSON.parse(text) } catch { return fail('bad_response', `The response is not JSON, so it is probably not an OpenAI-compatible API. Check the Base URL. Response starts with: ${short || '(empty)'}`) }
  const models = parseModelList(json)
  if (!models) return fail('bad_response', 'The response has no model list in a known format. Type the model name by hand.')
  return { ok: true, models }
}
