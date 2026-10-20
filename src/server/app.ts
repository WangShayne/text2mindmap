import crypto from 'node:crypto'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import type { AppConfig } from './config'
import { getSetting, setSetting, type DB } from './db'
import { SecretBox } from './secrets'
import { RateLimiter, SESSION_COOKIE, createFirstUser, createSession, deleteSession, sessionUser, userCount, type User } from './auth'
import { hashPassword, validateCredentials, verifyPassword } from './passwords'
import { LlmError, testConnection, type LlmConfig } from './llm'
import { DEFAULT_SYSTEM_PROMPT } from './prompts'
import { expandNode, generateOutline, type GenEvent } from './generate'
import { parseMarkdown, type OutlineNode } from '../shared/outline'
import { APP_NAME } from '../shared/brand'

type Env = { Variables: { user: User } }

export interface AppDeps { db: DB; config: AppConfig; secretBox: SecretBox; version?: string }

const K = { baseUrl: 'llm_base_url', model: 'llm_model', apiKey: 'llm_api_key_enc', prompt: 'system_prompt' } as const

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

function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xf = c.req.header('x-forwarded-for')
    if (xf) return xf.split(',')[0].trim()
    const xr = c.req.header('x-real-ip')
    if (xr) return xr
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return incoming?.socket?.remoteAddress ?? 'unknown'
}

function isHttps(c: Context, cfg: AppConfig): boolean {
  if (cfg.cookieSecure !== 'auto') return cfg.cookieSecure
  if (new URL(c.req.url).protocol === 'https:') return true
  return cfg.trustProxy && c.req.header('x-forwarded-proto') === 'https'
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
      if (!ct.includes('application/json')) return c.json({ error: 'Content-Type must be application/json' }, 415)
      const origin = c.req.header('origin')
      if (origin) {
        const host = c.req.header('x-forwarded-host') && config.trustProxy ? c.req.header('x-forwarded-host') : c.req.header('host')
        try { if (new URL(origin).host !== host) return c.json({ error: 'Cross-origin request rejected' }, 403) } catch { return c.json({ error: 'Bad Origin' }, 403) }
      }
    }
    await next()
  })
  app.use('/api/*', bodyLimit({ maxSize: Math.max(config.maxInputChars * 4 + 65_536, 4 * 1024 * 1024), onError: (c) => c.json({ error: 'Request body too large' }, 413) }))

  // ---------- public ----------
  app.get('/api/health', (c) => c.json({ ok: true, name: APP_NAME, version: deps.version ?? 'dev' }))

  app.get('/api/setup', (c) => c.json({ needsSetup: userCount(db) === 0 }))

  app.post('/api/setup', async (c) => {
    if (userCount(db) > 0) return c.json({ error: 'Setup is already complete' }, 403)
    const body = await c.req.json().catch(() => ({}))
    const err = validateCredentials(body.username, body.password)
    if (err) return c.json({ error: err }, 400)
    const user = await createFirstUser(db, body.username, body.password)
    if (!user) return c.json({ error: 'Setup is already complete' }, 403)
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
    }
  }
  app.get('/api/settings', adminOnly, (c) => c.json(settingsView()))
  // Non-admin users only learn which model is in use.
  app.get('/api/settings/public', (c) => { const l = effectiveLlm(deps); return c.json({ model: l.model, configured: !!l.baseUrl && !!l.model, maxInputChars: config.maxInputChars, chunkChars: config.llmChunkChars }) })

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

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))
  return app
}

let dummyHash: Promise<string> | undefined
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')))

function publicUser(u: User) {
  return { id: u.id, username: u.username, isAdmin: !!u.is_admin }
}
