import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODE, makeApp } from './helpers'
import { parseModelList } from '../src/server/llm'

const STORED_KEY = 'sk-stored-key-never-leak-789'
const FORM_KEY = 'sk-form-key-never-leak-012'

// Upstream mock: the path prefix picks the behaviour, e.g. /openai/v1/models.
type Mode = 'openai' | 'array' | 'models' | 'html' | 'missing' | 'slow' | 'echo401' | 'weird' | 'error500'
let server: http.Server
let base = ''
const seen: { path: string; auth?: string }[] = []
beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', auth: req.headers.authorization })
    const mode = (req.url ?? '').split('/')[1] as Mode
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const okKey = req.headers.authorization === `Bearer ${STORED_KEY}` || req.headers.authorization === `Bearer ${FORM_KEY}`
    if (mode === 'echo401' || !okKey) return json(401, { error: { message: `Incorrect API key provided: ${req.headers.authorization}` } })
    switch (mode) {
      case 'openai': return json(200, { object: 'list', data: [{ id: 'gpt-4o-mini' }, { id: 'deepseek-chat' }, { id: 'claude-3-5' }, { id: 'gpt-4o-mini' }, { id: 'qwen-max' }] })
      case 'array': return json(200, ['m-10', 'm-2', { id: 'm-1' }])
      case 'models': return json(200, { models: [{ name: 'gemma' }, { model: 'llama3' }] })
      case 'weird': return json(200, { hello: 'world' })
      case 'html': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><html>login page</html>')
      case 'error500': return json(500, { error: 'boom' })
      case 'slow': return setTimeout(() => json(200, { data: [] }), 20_000).unref()
      default: res.writeHead(404); return res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.closeAllConnections(); server.close() })

async function adminApp(over = {}) {
  const ctx = makeApp({ llmBaseUrl: `${base}/openai/v1`, llmApiKey: '', llmModel: 'x', ...over })
  await ctx.req('POST', '/api/setup', { username: 'admin', password: 'password123', setupCode: CODE })
  await ctx.req('PUT', '/api/settings', { apiKey: STORED_KEY })
  return ctx
}

describe('POST /api/settings/models', () => {
  it('lists sorted, de-duplicated model ids using the stored key and never returns the key', async () => {
    const { req } = await adminApp()
    seen.length = 0
    const r = await req('POST', '/api/settings/models', {})
    const text = await r.text()
    expect(r.status).toBe(200)
    expect(JSON.parse(text)).toEqual({ ok: true, models: ['claude-3-5', 'deepseek-chat', 'gpt-4o-mini', 'qwen-max'] })
    expect(seen[0]).toEqual({ path: '/openai/v1/models', auth: `Bearer ${STORED_KEY}` })
    expect(text).not.toContain(STORED_KEY)
  })

  it('prefers the Base URL and key typed in the form; blank key falls back to the stored one', async () => {
    const { req } = await adminApp()
    seen.length = 0
    expect(await (await req('POST', '/api/settings/models', { baseUrl: `${base}/array/v1/`, apiKey: FORM_KEY })).json()).toEqual({ ok: true, models: ['m-1', 'm-2', 'm-10'] })
    expect(seen[0]).toEqual({ path: '/array/v1/models', auth: `Bearer ${FORM_KEY}` })
    expect(await (await req('POST', '/api/settings/models', { baseUrl: `${base}/models/v1`, apiKey: '  ' })).json()).toEqual({ ok: true, models: ['gemma', 'llama3'] })
    expect(seen[1].auth).toBe(`Bearer ${STORED_KEY}`)
  })

  it('reports clear errors and redacts a key echoed by the upstream', async () => {
    const { req } = await adminApp()
    const t = async (b: object) => { const r = await req('POST', '/api/settings/models', b); const s = await r.text(); expect(s).not.toContain(STORED_KEY); expect(s).not.toContain(FORM_KEY); return JSON.parse(s) }
    expect(await t({ baseUrl: `${base}/echo401/v1` })).toMatchObject({ ok: false, code: 'auth' })
    expect(await t({ baseUrl: `${base}/echo401/v1`, apiKey: FORM_KEY })).toMatchObject({ ok: false, code: 'auth' })
    expect(await t({ baseUrl: `${base}/nothing/v1` })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await t({ baseUrl: `${base}/html/v1` })).toMatchObject({ ok: false, code: 'bad_response', message: expect.stringContaining('not JSON') })
    expect(await t({ baseUrl: `${base}/weird/v1` })).toMatchObject({ ok: false, code: 'bad_response' })
    expect(await t({ baseUrl: `${base}/error500/v1` })).toMatchObject({ ok: false, code: 'upstream' })
    expect(await t({ baseUrl: 'http://127.0.0.1:1/v1' })).toMatchObject({ ok: false, code: 'network' })
  })

  it('times out after 15s', async () => {
    const { req } = await adminApp()
    const t0 = Date.now()
    expect(await (await req('POST', '/api/settings/models', { baseUrl: `${base}/slow/v1` })).json()).toMatchObject({ ok: false, code: 'timeout' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(14_000)
  }, 25_000)

  it('rejects bad URLs, anonymous users and non-admins', async () => {
    const { req, db, setCookie } = await adminApp()
    expect((await req('POST', '/api/settings/models', { baseUrl: 'ftp://x' })).status).toBe(400)
    db.prepare('UPDATE users SET is_admin = 0').run()
    expect((await req('POST', '/api/settings/models', {})).status).toBe(403)
    setCookie('')
    expect((await req('POST', '/api/settings/models', {})).status).toBe(401)
  })
})

describe('parseModelList', () => {
  it('accepts common response shapes', () => {
    expect(parseModelList({ data: [{ id: 'b' }, { id: 'a' }] })).toEqual(['a', 'b'])
    expect(parseModelList(['x', { name: 'y' }, null, 3, { id: '' }])).toEqual(['x', 'y'])
    expect(parseModelList({ models: [{ model: 'z' }] })).toEqual(['z'])
    expect(parseModelList({ data: { models: ['nested'] } })).toEqual(['nested'])
    expect(parseModelList({ data: [] })).toEqual([])
    expect(parseModelList({ foo: 1 })).toBeUndefined()
    expect(parseModelList(null)).toBeUndefined()
  })
})
