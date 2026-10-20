import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeApp } from './helpers'
import { getSetting } from '../src/server/db'
// @ts-expect-error plain JS helper
import { MOCK_KEY, MOCK_MODEL, startMockLlm } from '../scripts/mock-llm.mjs'

let mock: { url: string; close: () => Promise<void> }
beforeAll(async () => { mock = await startMockLlm(0) })
afterAll(async () => { await mock.close() })

const ENV_KEY = 'sk-env-key-should-never-leak-123'
const DB_KEY = 'sk-db-key-should-never-leak-456'

async function allResponses(req: ReturnType<typeof makeApp>['req'], docId: string) {
  const out: string[] = []
  for (const [m, p, b] of [
    ['GET', '/api/health'], ['GET', '/api/setup'], ['GET', '/api/auth/me'], ['GET', '/api/docs'], ['GET', `/api/docs/${docId}`],
    ['GET', '/api/settings'], ['GET', '/api/settings/public'], ['PUT', '/api/settings', {}], ['POST', '/api/settings/test', {}],
    ['GET', `/api/docs/${docId}/export?format=json`], ['POST', '/api/generate', { text: 'Hello world. This is a test.' }],
  ] as [string, string, unknown?][]) {
    const r = await req(m, p, b)
    out.push(`${m} ${p} ${r.status} ${JSON.stringify([...r.headers])} ${await r.text()}`)
  }
  return out
}

describe('settings and secret handling', () => {
  it('never returns the API key from any endpoint (env key and stored key)', async () => {
    const { req, db } = makeApp({ llmBaseUrl: 'http://127.0.0.1:1/v1', llmApiKey: ENV_KEY })
    await req('POST', '/api/setup', { username: 'admin', password: 'password123' })
    const doc = (await (await req('POST', '/api/docs', { title: 't' })).json()).doc
    for (const line of await allResponses(req, doc.id)) expect(line).not.toContain(ENV_KEY)

    const put = await req('PUT', '/api/settings', { apiKey: DB_KEY, baseUrl: 'http://127.0.0.1:1/v1/', model: 'm' })
    const view = await put.json()
    expect(view.llm).toMatchObject({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', hasApiKey: true, keySource: 'settings' })
    // encrypted at rest
    const stored = getSetting(db, 'llm_api_key_enc')!
    expect(stored.startsWith('v1:')).toBe(true)
    expect(stored).not.toContain(DB_KEY)
    const dump = JSON.stringify(db.prepare('SELECT * FROM settings').all())
    expect(dump).not.toContain(DB_KEY)
    for (const line of await allResponses(req, doc.id)) {
      expect(line).not.toContain(DB_KEY)
      expect(line).not.toContain(ENV_KEY)
    }
    // clearing falls back to the env key
    const cleared = await (await req('PUT', '/api/settings', { clearApiKey: true })).json()
    expect(cleared.llm.keySource).toBe('env')
  })

  it('does not leak a key echoed back by the upstream error', async () => {
    const { req } = makeApp({ llmBaseUrl: mock.url, llmApiKey: 'sk-wrong-key-zzz', llmModel: MOCK_MODEL })
    await req('POST', '/api/setup', { username: 'admin', password: 'password123' })
    const r = await (await req('POST', '/api/settings/test', {})).json()
    expect(r).toMatchObject({ ok: false, code: 'auth' })
    expect(JSON.stringify(r)).not.toContain('sk-wrong-key-zzz')
  })

  it('test connection reports specific errors', async () => {
    const { req } = makeApp({ llmBaseUrl: mock.url, llmApiKey: MOCK_KEY, llmModel: MOCK_MODEL })
    await req('POST', '/api/setup', { username: 'admin', password: 'password123' })
    const t = async (b: object) => (await req('POST', '/api/settings/test', b)).json()
    expect(await t({})).toMatchObject({ ok: true, models: 2 })
    expect(await t({ apiKey: 'sk-bad' })).toMatchObject({ ok: false, code: 'auth' })
    expect(await t({ model: 'nope-model' })).toMatchObject({ ok: false, code: 'model' })
    expect(await t({ baseUrl: mock.url.replace('/v1', '/wrong') })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await t({ baseUrl: 'http://127.0.0.1:1/v1' })).toMatchObject({ ok: false, code: 'network' })
  })

  it('system prompt can be edited and reset; settings are admin-only', async () => {
    const { req, db } = makeApp()
    await req('POST', '/api/setup', { username: 'admin', password: 'password123' })
    let v = await (await req('PUT', '/api/settings', { systemPrompt: 'Custom prompt' })).json()
    expect(v).toMatchObject({ systemPrompt: 'Custom prompt', systemPromptIsDefault: false })
    v = await (await req('PUT', '/api/settings', { resetSystemPrompt: true })).json()
    expect(v.systemPromptIsDefault).toBe(true)
    expect(v.systemPrompt).toBe(v.defaultSystemPrompt)
    expect((await req('PUT', '/api/settings', { baseUrl: 'ftp://x' })).status).toBe(400)
    db.prepare('UPDATE users SET is_admin = 0').run()
    expect((await req('GET', '/api/settings')).status).toBe(403)
    expect((await req('GET', '/api/settings/public')).status).toBe(200)
  })
})
