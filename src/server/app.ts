import crypto from 'node:crypto'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { clampSegmentSeconds, type AppConfig } from './config'
import { testAsr, transcribe, type AsrConfig } from './asr'
import { getSetting, setSetting, type DB } from './db'
import { SecretBox } from './secrets'
import { SetupCode } from './setupCode'
import { RateLimiter, SESSION_COOKIE, createFirstUser, createSession, deleteSession, sessionUser, userCount, type User } from './auth'
import { hashPassword, validateCredentials, verifyPassword } from './passwords'
import { LlmError, listModels, testConnection, type LlmConfig } from './llm'
import { DEFAULT_SYSTEM_PROMPT } from './prompts'
import { expandNode, generateOutline, type GenEvent } from './generate'
import { parseMarkdown, type OutlineNode } from '../shared/outline'
import { APP_NAME } from '../shared/brand'

type Env = { Variables: { user: User } }

export interface AppDeps { db: DB; config: AppConfig; secretBox: SecretBox; setupCode: SetupCode; version?: string }

const K = {
  baseUrl: 'llm_base_url', model: 'llm_model', apiKey: 'llm_api_key_enc', prompt: 'system_prompt',
  asrBaseUrl: 'asr_base_url', asrModel: 'asr_model', asrApiKey: 'asr_api_key_enc', asrSegment: 'asr_segment_seconds',
} as const

const TRANSCRIBE_PATH = '/api/transcribe'
const AUDIO_TYPES = /^(audio\/[\w.+-]+|application\/octet-stream)$/i

export function effectiveLlm(deps: AppDeps): LlmConfig & { keySource: 'settings' | 'env' | 'none' } {
  const { db, config, secretBox } = deps
  const enc = getSetting(db, K.apiKey)
  let apiKey = config.llmApiKey
  let keySource: 'settings' | 'env' | 'none' = apiKey ? 'env' : 'none'
  if (enc) {
    try { apiKey = secretBox.decrypt(enc); keySource = 'settings' } catch { console.error('[error] Stored API key cannot be decrypted (APP_SECRET changed?). Falling back to LLM_API_KEY.') }
  }
  return {
    baseUrl: (getSetting(db, K.baseUrl) || config.llmBaseUrl).replace(/\/+$/, ''),
    model: getSetting(db, K.model) || config.llmModel,
    apiKey,
    temperature: config.llmTemperature,
    timeoutMs: config.llmTimeoutMs,
    keySource,
  }
}

export function effectiveAsr(deps: AppDeps): AsrConfig & { keySource: 'settings' | 'env' | 'none'; segmentSeconds: number } {
  const { db, config, secretBox } = deps
  const enc = getSetting(db, K.asrApiKey)
  let apiKey = config.asrApiKey
  let keySource: 'settings' | 'env' | 'none' = apiKey ? 'env' : 'none'
  if (enc) {
    try { apiKey = secretBox.decrypt(enc); keySource = 'settings' } catch { console.error('[error] Stored ASR API key cannot be decrypted (APP_SECRET changed?). Falling back to ASR_API_KEY.') }
  }
  const seg = Number(getSetting(db, K.asrSegment))
  return {
    baseUrl: (getSetting(db, K.asrBaseUrl) || config.asrBaseUrl).replace(/\/+$/, ''),
    model: getSetting(db, K.asrModel) || config.asrModel,
    apiKey,
    timeoutMs: config.asrTimeoutMs,
    keySource,
    segmentSeconds: seg > 0 ? clampSegmentSeconds(seg) : config.asrSegmentSeconds,
  }
}

/**
 * Client IP for rate limiting. Without TRUST_PROXY the socket address is used and
 * X-Forwarded-For is ignored (it could be forged). With TRUST_PROXY=N the address is taken
 * from X-Forwarded-For counting N entries from the right: each trusted proxy appends the
 * address it received the request from, so entries further left are client-controlled.
 */
export function clientIp(c: Context, trustProxy: number): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  const socketIp = incoming?.socket?.remoteAddress ?? 'unknown'
  if (trustProxy > 0) {
    const chain = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (chain.length) return chain[Math.max(0, chain.length - trustProxy)]
    const xr = c.req.header('x-real-ip')?.trim()
    if (xr) return xr
  }
  return socketIp
}

/** First value of a comma-separated forwarded header (the one set by the outermost proxy). */
function forwarded(c: Context, name: string): string | undefined {
  return c.req.header(name)?.split(',')[0]?.trim().toLowerCase() || undefined
}

/** Whether the browser talks HTTPS to us (directly, or to a trusted proxy). Drives the Secure cookie flag. */
export function isHttps(c: Context, cfg: AppConfig): boolean {
  if (cfg.cookieSecure !== 'auto') return cfg.cookieSecure
  if (new URL(c.req.url).protocol === 'https:') return true
  return cfg.trustProxy > 0 && forwarded(c, 'x-forwarded-proto') === 'https'
}

/** Host the browser used, for the same-origin check. */
function requestHost(c: Context, cfg: AppConfig): string | undefined {
  if (cfg.trustProxy > 0) { const h = forwarded(c, 'x-forwarded-host'); if (h) return h }
  return c.req.header('host')?.toLowerCase()
}

function sanitizeTitle(t: unknown, fallback = 'Untitled'): string {
  const s = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  return s || fallback
}

function toOpml(root: OutlineNode): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const walk = (n: OutlineNode, ind: string): string =>
    n.children.length
      ? `${ind}<outline text="${esc(n.text)}">\n${n.children.map((c) => walk(c, ind + '  ')).join('')}${ind}</outline>\n`
      : `${ind}<outline text="${esc(n.text)}"/>\n`
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${esc(root.text)}</title></head>\n  <body>\n${walk(root, '    ')}  </body>\n</opml>\n`
}

export function createApp(deps: AppDeps) {
  const { db, config } = deps
  const app = new Hono<Env>()
  const loginLimiter = new RateLimiter(10, 15 * 60_000)
  const setupLimiter = new RateLimiter(10, 15 * 60_000)

  app.onError((err, c) => {
    console.error('[error]', err)
    return c.json({ error: 'Internal server error' }, 500)
  })

  // Security headers + CSRF guard: state-changing API calls must be JSON (forces a CORS preflight cross-site)
  // and, when the browser sends Origin, it must match the Host.
  app.use('*', async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'same-origin')
    c.header('X-Frame-Options', 'DENY')
  })
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const ct = c.req.header('content-type') ?? ''
      // Raw audio uploads use an audio/* type; like JSON it is not a CORS-simple type, so it also forces a preflight.
      const audioOk = c.req.path === TRANSCRIBE_PATH && AUDIO_TYPES.test(ct.split(';')[0].trim())
      if (!ct.includes('application/json') && !audioOk) return c.json({ error: c.req.path === TRANSCRIBE_PATH ? 'Send the audio as the request body with Content-Type audio/wav (or another audio/* type)' : 'Content-Type must be application/json' }, 415)
      const origin = c.req.header('origin')
      if (origin) {
        const host = requestHost(c, config)
        try { if (new URL(origin).host.toLowerCase() !== host) return c.json({ error: 'Cross-origin request rejected' }, 403) } catch { return c.json({ error: 'Bad Origin' }, 403) }
      }
    }
    await next()
  })
  const jsonLimit = bodyLimit({ maxSize: Math.max(config.maxInputChars * 4 + 65_536, 4 * 1024 * 1024), onError: (c) => c.json({ error: 'Request body too large' }, 413) })
  // /api/transcribe enforces its own (larger) limit while streaming.
  app.use('/api/*', (c, next) => (c.req.path === TRANSCRIBE_PATH ? next() : jsonLimit(c, next)))

  // ---------- public ----------
  app.get('/api/health', (c) => c.json({ ok: true, name: APP_NAME, version: deps.version ?? 'dev' }))

  app.get('/api/setup', (c) => c.json({ needsSetup: userCount(db) === 0, requiresCode: true }))

  // First-run admin creation. Requires the one-time setup code printed to the server log.
  app.post('/api/setup', async (c) => {
    if (userCount(db) > 0) return c.json({ error: 'Setup is already complete' }, 403)
    const ip = clientIp(c, config.trustProxy)
    const wait = setupLimiter.blocked(ip)
    if (wait) { c.header('Retry-After', String(wait)); return c.json({ error: `Too many wrong setup codes. Try again in ${Math.ceil(wait / 60)} min.` }, 429) }
    const body = await c.req.json().catch(() => ({}))
    if (!deps.setupCode.matches(body.setupCode)) {
      setupLimiter.fail(ip)
      return c.json({ error: deps.setupCode.active ? 'Wrong setup code. Find it in the server log (docker compose logs).' : 'Setup is not available. Restart the server to get a setup code, or set ADMIN_USERNAME and ADMIN_PASSWORD.' }, 403)
    }
    const err = validateCredentials(body.username, body.password)
    if (err) return c.json({ error: err }, 400)
    const user = await createFirstUser(db, body.username, body.password)
    if (!user) return c.json({ error: 'Setup is already complete' }, 403)
    deps.setupCode.consume()
    setupLimiter.clear(ip)
    const s = createSession(db, user.id, config.sessionDays)
    setSessionCookie(c, s.token, s.expires)
    return c.json({ user: publicUser(user) })
  })

  app.post('/api/auth/login', async (c) => {
    const ip = clientIp(c, config.trustProxy)
    const wait = loginLimiter.blocked(ip)
    if (wait) { c.header('Retry-After', String(wait)); return c.json({ error: `Too many failed logins. Try again in ${Math.ceil(wait / 60)} min.` }, 429) }
    const body = await c.req.json().catch(() => ({}))
    const row = typeof body.username === 'string'
      ? (db.prepare('SELECT id, username, is_admin, password_hash FROM users WHERE username = ?').get(body.username) as (User & { password_hash: string }) | undefined)
      : undefined
    // Always run one scrypt so timing does not reveal whether the user exists.
    const ok = await verifyPassword(typeof body.password === 'string' ? body.password : '', row?.password_hash ?? (await getDummyHash()))
    if (!row || !ok) { loginLimiter.fail(ip); return c.json({ error: 'Wrong username or password' }, 401) }
    loginLimiter.clear(ip)
    const s = createSession(db, row.id, config.sessionDays)
    setSessionCookie(c, s.token, s.expires)
    return c.json({ user: publicUser(row) })
  })

  app.post('/api/auth/logout', (c) => {
    deleteSession(db, getCookie(c, SESSION_COOKIE))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  function setSessionCookie(c: Context, token: string, expires: number) {
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: isHttps(c, config), path: '/', expires: new Date(expires) })
  }

  // ---------- authenticated ----------
  app.use('/api/*', async (c, next) => {
    const user = sessionUser(db, getCookie(c, SESSION_COOKIE))
    if (!user) return c.json({ error: 'Not logged in' }, 401)
    c.set('user', user)
    await next()
  })
  const adminOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    if (!c.get('user').is_admin) return c.json({ error: 'Admin only' }, 403)
    await next()
  }

  app.get('/api/auth/me', (c) => c.json({ user: publicUser(c.get('user')) }))

  app.post('/api/auth/password', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const u = c.get('user')
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id) as { password_hash: string }
    if (!(await verifyPassword(String(body.current ?? ''), row.password_hash))) return c.json({ error: 'Current password is wrong' }, 400)
    const err = validateCredentials(u.username, body.next)
    if (err) return c.json({ error: err }, 400)
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.next), u.id)
    // Sign out other sessions
    const current = getCookie(c, SESSION_COOKIE)
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id)
    if (current) { const s = createSession(db, u.id, config.sessionDays); setSessionCookie(c, s.token, s.expires) }
    return c.json({ ok: true })
  })

  // Documents (always scoped to the logged-in user)
  app.get('/api/docs', (c) => {
    const rows = db.prepare('SELECT id, title, created_at, updated_at, length(markdown) AS size FROM documents WHERE user_id = ? ORDER BY updated_at DESC').all(c.get('user').id)
    return c.json({ docs: rows })
  })

  app.post('/api/docs', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const id = crypto.randomUUID()
    const now = Date.now()
    const title = sanitizeTitle(body.title)
    const markdown = typeof body.markdown === 'string' ? body.markdown : `# ${title}\n`
    if (markdown.length > 2_000_000) return c.json({ error: 'Document too large' }, 413)
    db.prepare('INSERT INTO documents(id, user_id, title, markdown, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)').run(id, c.get('user').id, title, markdown, now, now)
    return c.json({ doc: { id, title, markdown, created_at: now, updated_at: now } }, 201)
  })

  const getDoc = (c: Context<Env>) =>
    db.prepare('SELECT id, title, markdown, created_at, updated_at FROM documents WHERE id = ? AND user_id = ?').get(c.req.param('id') ?? '', c.get('user').id) as
      | { id: string; title: string; markdown: string; created_at: number; updated_at: number }
      | undefined

  app.get('/api/docs/:id', (c) => {
    const doc = getDoc(c)
    return doc ? c.json({ doc }) : c.json({ error: 'Not found' }, 404)
  })

  app.put('/api/docs/:id', async (c) => {
    const doc = getDoc(c)
    if (!doc) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const title = body.title !== undefined ? sanitizeTitle(body.title, doc.title) : doc.title
    const markdown = typeof body.markdown === 'string' ? body.markdown : doc.markdown
    if (markdown.length > 2_000_000) return c.json({ error: 'Document too large' }, 413)
    const now = Date.now()
    db.prepare('UPDATE documents SET title = ?, markdown = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(title, markdown, now, doc.id, c.get('user').id)
    return c.json({ doc: { ...doc, title, markdown, updated_at: now } })
  })

  app.delete('/api/docs/:id', (c) => {
    const r = db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(c.req.param('id'), c.get('user').id)
    return r.changes ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
  })

  app.get('/api/docs/:id/export', (c) => {
    const doc = getDoc(c)
    if (!doc) return c.json({ error: 'Not found' }, 404)
    const format = c.req.query('format') ?? 'md'
    const name = encodeURIComponent(doc.title.replace(/[\\/:*?"<>|]/g, '_'))
    const send = (body: string, type: string, ext: string) =>
      c.body(body, 200, { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="export.${ext}"; filename*=UTF-8''${name}.${ext}` })
    if (format === 'md') return send(doc.markdown, 'text/markdown', 'md')
    const tree = parseMarkdown(doc.markdown, doc.title)
    if (format === 'opml') return send(toOpml(tree), 'text/x-opml', 'opml')
    if (format === 'json') return send(JSON.stringify(tree, null, 2), 'application/json', 'json')
    return c.json({ error: 'Unknown format. Server-side formats: md, opml, json. PNG/SVG/PDF/XMind are exported in the browser.' }, 400)
  })

  // Generation (SSE)
  app.post('/api/generate', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const mode = body.mode === 'expand' ? 'expand' : 'full'
    const llm = effectiveLlm(deps)
    if (mode === 'full') {
      if (typeof body.text !== 'string' || !body.text.trim()) return c.json({ error: 'Text is required' }, 400)
      if (body.text.length > config.maxInputChars) return c.json({ error: `Text is too long (max ${config.maxInputChars} characters)` }, 413)
    } else if (!Array.isArray(body.path) || !body.path.length || typeof body.markdown !== 'string') {
      return c.json({ error: 'path and markdown are required for expand' }, 400)
    }
    const ac = new AbortController()
    c.req.raw.signal?.addEventListener('abort', () => ac.abort(), { once: true })
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => ac.abort())
      let queue: Promise<unknown> = Promise.resolve()
      const emit = (e: GenEvent) => {
        if (ac.signal.aborted) return
        queue = queue.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => ac.abort())
      }
      const ctx = { cfg: llm, systemPrompt: getSetting(db, K.prompt), chunkChars: config.llmChunkChars, signal: ac.signal, emit }
      try {
        if (mode === 'full') await generateOutline(ctx, body.text, sanitizeTitle(body.title))
        else await expandNode(ctx, body.markdown, body.path.map(String), Array.isArray(body.existing) ? body.existing.map(String) : [], typeof body.instructions === 'string' ? body.instructions.slice(0, 1000) : undefined)
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError('upstream', 'Generation failed')
        if (!(e instanceof LlmError)) console.error('[generate]', e)
        emit({ type: 'error', code: err.code, message: err.message.split(llm.apiKey || '\u0000').join('***') })
      }
      await queue
    })
  })

  // Settings (admin). The API key is write-only: responses only say whether one is set.
  const settingsView = () => {
    const llm = effectiveLlm(deps)
    const prompt = getSetting(db, K.prompt)
    return {
      llm: { baseUrl: llm.baseUrl, model: llm.model, hasApiKey: !!llm.apiKey, keySource: llm.keySource },
      env: { baseUrl: config.llmBaseUrl, model: config.llmModel, hasApiKey: !!config.llmApiKey },
      overrides: { baseUrl: !!getSetting(db, K.baseUrl), model: !!getSetting(db, K.model), apiKey: !!getSetting(db, K.apiKey) },
      systemPrompt: prompt || DEFAULT_SYSTEM_PROMPT,
      systemPromptIsDefault: !prompt,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
      chunkChars: config.llmChunkChars,
      maxInputChars: config.maxInputChars,
      asr: (() => {
        const a = effectiveAsr(deps)
        return {
          baseUrl: a.baseUrl, model: a.model, hasApiKey: !!a.apiKey, keySource: a.keySource, segmentSeconds: a.segmentSeconds,
          env: { baseUrl: config.asrBaseUrl, model: config.asrModel, hasApiKey: !!config.asrApiKey, segmentSeconds: config.asrSegmentSeconds },
          maxUploadMb: Math.round(config.asrMaxBytes / 1024 / 1024),
        }
      })(),
    }
  }
  app.get('/api/settings', adminOnly, (c) => c.json(settingsView()))
  // Non-admin users only learn which model is in use.
  app.get('/api/settings/public', (c) => {
    const l = effectiveLlm(deps)
    const a = effectiveAsr(deps)
    return c.json({
      model: l.model, configured: !!l.baseUrl && !!l.model, maxInputChars: config.maxInputChars, chunkChars: config.llmChunkChars,
      asr: { configured: !!a.baseUrl && !!a.model, segmentSeconds: a.segmentSeconds, maxUploadBytes: config.asrMaxBytes },
    })
  })

  app.put('/api/settings', adminOnly, async (c) => {
    const b = await c.req.json().catch(() => ({}))
    if (b.baseUrl !== undefined) {
      const v = String(b.baseUrl).trim()
      if (v && !/^https?:\/\/[^\s]+$/i.test(v)) return c.json({ error: 'Base URL must start with http:// or https://' }, 400)
      const norm = v.replace(/\/+$/, '')
      // Values equal to the env default are not stored, so later env changes still apply.
      setSetting(db, K.baseUrl, norm && norm !== config.llmBaseUrl ? norm : null)
    }
    if (b.model !== undefined) { const m = String(b.model).trim(); setSetting(db, K.model, m && m !== config.llmModel ? m : null) }
    if (b.clearApiKey === true) setSetting(db, K.apiKey, null)
    else if (typeof b.apiKey === 'string' && b.apiKey.trim()) setSetting(db, K.apiKey, deps.secretBox.encrypt(b.apiKey.trim()))
    if (b.asrBaseUrl !== undefined) {
      const v = String(b.asrBaseUrl).trim()
      if (v && !/^https?:\/\/[^\s]+$/i.test(v)) return c.json({ error: 'ASR Base URL must start with http:// or https://' }, 400)
      const norm = v.replace(/\/+$/, '')
      setSetting(db, K.asrBaseUrl, norm && norm !== config.asrBaseUrl ? norm : null)
    }
    if (b.asrModel !== undefined) { const m = String(b.asrModel).trim(); setSetting(db, K.asrModel, m && m !== config.asrModel ? m : null) }
    if (b.clearAsrApiKey === true) setSetting(db, K.asrApiKey, null)
    else if (typeof b.asrApiKey === 'string' && b.asrApiKey.trim()) setSetting(db, K.asrApiKey, deps.secretBox.encrypt(b.asrApiKey.trim()))
    if (b.asrSegmentSeconds !== undefined) {
      const n = Number(b.asrSegmentSeconds)
      if (b.asrSegmentSeconds === null || b.asrSegmentSeconds === '') setSetting(db, K.asrSegment, null)
      else if (!Number.isFinite(n) || n <= 0) return c.json({ error: 'Max segment length must be a number of seconds' }, 400)
      else { const v = clampSegmentSeconds(n); setSetting(db, K.asrSegment, v !== config.asrSegmentSeconds ? String(v) : null) }
    }
    if (b.resetSystemPrompt === true) setSetting(db, K.prompt, null)
    else if (typeof b.systemPrompt === 'string') {
      const p = b.systemPrompt.trim()
      setSetting(db, K.prompt, p && p !== DEFAULT_SYSTEM_PROMPT ? p.slice(0, 20_000) : null)
    }
    return c.json(settingsView())
  })

  app.post('/api/settings/test', adminOnly, async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const cur = effectiveLlm(deps)
    const cfg: LlmConfig = {
      ...cur,
      baseUrl: typeof b.baseUrl === 'string' && b.baseUrl.trim() ? b.baseUrl.trim().replace(/\/+$/, '') : cur.baseUrl,
      model: typeof b.model === 'string' && b.model.trim() ? b.model.trim() : cur.model,
      apiKey: typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : cur.apiKey,
    }
    const r = await testConnection(cfg)
    return c.json({ ...r, message: r.message.split(cfg.apiKey || '\u0000').join('***') })
  })

  // ASR settings helpers: same pattern as the LLM ones (typed values first, saved values as fallback).
  const asrFromForm = (b: Record<string, unknown>): AsrConfig | Response => {
    const cur = effectiveAsr(deps)
    const typedUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim() : ''
    if (typedUrl && !/^https?:\/\/[^\s]+$/i.test(typedUrl)) return Response.json({ error: 'ASR Base URL must start with http:// or https://' }, { status: 400 })
    return {
      ...cur,
      baseUrl: typedUrl ? typedUrl.replace(/\/+$/, '') : cur.baseUrl,
      model: typeof b.model === 'string' && b.model.trim() ? b.model.trim() : cur.model,
      apiKey: typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : cur.apiKey,
    }
  }
  app.post('/api/settings/asr/test', adminOnly, async (c) => {
    const cfg = asrFromForm(await c.req.json().catch(() => ({})))
    if (cfg instanceof Response) return cfg
    return c.json(await testAsr(cfg))
  })
  app.post('/api/settings/asr/models', adminOnly, async (c) => {
    const cfg = asrFromForm(await c.req.json().catch(() => ({})))
    if (cfg instanceof Response) return cfg
    return c.json(await listModels(cfg.baseUrl, cfg.apiKey, 15_000))
  })

  // Speech to text for any logged-in user. Body: raw audio (audio/wav recommended), Content-Length required.
  // Query: name, language, prompt. The audio is streamed to {ASR base}/audio/transcriptions.
  app.post(TRANSCRIBE_PATH, async (c) => {
    const asr = effectiveAsr(deps)
    if (!asr.baseUrl || !asr.model) return c.json({ ok: false, code: 'not_configured', message: 'Speech recognition is not configured. Ask the admin to set the ASR Base URL and model in Settings.' }, 503)
    const len = Number(c.req.header('content-length'))
    if (!Number.isFinite(len) || len <= 0 || !Number.isInteger(len)) return c.json({ ok: false, code: 'length_required', message: 'Content-Length is required.' }, 411)
    if (len > config.asrMaxBytes) return c.json({ ok: false, code: 'too_large', message: `Audio segment too large (${(len / 1048576).toFixed(1)} MB, max ${(config.asrMaxBytes / 1048576).toFixed(0)} MB per request). Lower "Max segment length" in Settings.` }, 413)
    const raw = c.req.raw.body
    if (!raw) return c.json({ ok: false, code: 'bad_request', message: 'Empty body.' }, 400)
    // Count bytes as they pass so a client cannot send more than it declared.
    let seen = 0
    const counted = raw.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) { seen += chunk.byteLength; if (seen > len) ctl.error(new Error('Body longer than Content-Length')); else ctl.enqueue(chunk) },
    }))
    const q = (k: string, max: number) => (c.req.query(k) ?? '').trim().slice(0, max)
    const language = q('language', 16)
    const ct = (c.req.header('content-type') ?? 'audio/wav').split(';')[0].trim().toLowerCase()
    const ext = ({ 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/flac': 'flac' } as Record<string, string>)[ct] ?? 'wav'
    const ac = new AbortController()
    c.req.raw.signal?.addEventListener('abort', () => ac.abort(), { once: true })
    const r = await transcribe(asr, {
      audio: counted, size: len, filename: `${(q('name', 60) || 'segment').replace(/\.[^.]*$/, '')}.${ext}`, contentType: ct,
      language: /^[a-zA-Z-]{2,16}$/.test(language) && language !== 'auto' ? language : undefined,
      prompt: q('prompt', 1000) || undefined,
      signal: ac.signal,
    })
    if (r.ok) return c.json(r)
    const status = r.code === 'not_configured' ? 503 : r.code === 'timeout' ? 504 : r.code === 'too_large' ? 413 : r.code === 'aborted' ? 499 : 502
    return c.json(r, status as 502)
  })

  // Lists the provider's models for the settings form. Uses the Base URL / key typed in the form when
  // given, otherwise the saved ones. The key itself is never sent back.
  app.post('/api/settings/models', adminOnly, async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const cur = effectiveLlm(deps)
    const typedUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim() : ''
    if (typedUrl && !/^https?:\/\/[^\s]+$/i.test(typedUrl)) return c.json({ error: 'Base URL must start with http:// or https://' }, 400)
    const baseUrl = typedUrl ? typedUrl.replace(/\/+$/, '') : cur.baseUrl
    const apiKey = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : cur.apiKey
    const r = await listModels(baseUrl, apiKey, 15_000)
    return c.json(r)
  })

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))
  return app
}

let dummyHash: Promise<string> | undefined
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')))

function publicUser(u: User) {
  return { id: u.id, username: u.username, isAdmin: !!u.is_admin }
}
