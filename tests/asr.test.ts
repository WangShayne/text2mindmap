import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODE, makeApp } from './helpers'
import { getSetting } from '../src/server/db'
import { cleanTranscript, parseTranscription } from '../src/server/asr'
import { encodeWav } from '../src/shared/wav'

const STORED = 'sk-asr-stored-never-leak-111'
const FORM = 'sk-asr-form-never-leak-222'
const ENV = 'sk-asr-env-never-leak-333'

interface Seen { path: string; auth?: string; ctype?: string; length?: string; body: Buffer }
let server: http.Server
let base = ''
const seen: Seen[] = []

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    try { for await (const ch of req) chunks.push(ch as Buffer) } catch { seen.push({ path: req.url ?? '', body: Buffer.concat(chunks) }); return } // client aborted mid-upload
    const body = Buffer.concat(chunks)
    seen.push({ path: req.url ?? '', auth: req.headers.authorization, ctype: req.headers['content-type'], length: req.headers['content-length'], body })
    const mode = (req.url ?? '').split('/')[1]
    if (mode === 'noauth') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ text: req.headers.authorization === undefined ? '无鉴权' : 'HAS_AUTH' })) }
    const ok = [STORED, FORM, ENV].some((k) => req.headers.authorization === `Bearer ${k}`)
    const json = (st: number, b: unknown) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
    if (!ok || mode === 'echo401') return json(401, { error: { message: `Invalid key ${req.headers.authorization}` } })
    if (req.url?.endsWith('/models')) return json(200, { data: [{ id: 'whisper-1' }, { id: 'SenseVoiceSmall' }] })
    switch (mode) {
      case 'json': return json(200, { text: '你好世界' })
      case 'verbose': return json(200, { task: 'transcribe', language: 'zh', text: 'hello there', segments: [{ text: 'hello there' }] })
      case 'plain': res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('plain transcript\n')
      case 'sensevoice': return json(200, { text: '<|zh|><|NEUTRAL|><|Speech|><|withitn|>今天天气不错。' })
      case 'html': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>login</html>')
      case 'odd': return json(200, { foo: 1 })
      case 'big': return json(413, { error: 'Request Entity Too Large' })
      case 'dur': return json(400, { error: { message: 'audio duration exceeds 30 seconds' } })
      case 'e500': return json(500, { error: 'boom' })
      case 'slow': return setTimeout(() => json(200, { text: 'late' }), 5_000).unref()
      default: res.writeHead(404); return res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.closeAllConnections(); server.close() })

async function adminApp(over = {}) {
  const ctx = makeApp({ asrBaseUrl: `${base}/json/v1`, asrModel: 'whisper-1', asrApiKey: '', asrTimeoutMs: 2_000, ...over })
  await ctx.req('POST', '/api/setup', { username: 'admin', password: 'password123', setupCode: CODE })
  await ctx.req('PUT', '/api/settings', { asrApiKey: STORED })
  return ctx
}

const wav = new Uint8Array(encodeWav(new Float32Array(1600).map((_, i) => Math.sin(i / 5) * 0.3)))

async function upload(app: ReturnType<typeof makeApp>['app'], cookie: string, body: Uint8Array<ArrayBuffer>, opts: { query?: string; ctype?: string; length?: number } = {}) {
  const res = await app.request(`/api/transcribe${opts.query ?? ''}`, {
    method: 'POST',
    headers: { cookie, 'content-type': opts.ctype ?? 'audio/wav', 'content-length': String(opts.length ?? body.length) },
    body,
  }, { incoming: { socket: { remoteAddress: '10.0.0.1' } } })
  return { status: res.status, text: await res.text() }
}

describe('POST /api/transcribe', () => {
  it('streams the audio as multipart to {base}/audio/transcriptions with the stored key', async () => {
    const { app, getCookie } = await adminApp()
    seen.length = 0
    const r = await upload(app, getCookie(), wav, { query: '?language=zh&prompt=%E4%BC%9A%E8%AE%AE&name=rec-1' })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.text)).toEqual({ ok: true, text: '你好世界' })
    expect(r.text).not.toContain(STORED)
    const s = seen[0]
    expect(s.path).toBe('/json/v1/audio/transcriptions')
    expect(s.auth).toBe(`Bearer ${STORED}`)
    expect(s.ctype).toMatch(/^multipart\/form-data; boundary=/)
    expect(Number(s.length)).toBe(s.body.length)
    const text = s.body.toString('latin1')
    expect(text).toContain('name="model"\r\n\r\nwhisper-1\r\n')
    expect(text).toContain('name="response_format"\r\n\r\njson\r\n')
    expect(text).toContain('name="language"\r\n\r\nzh\r\n')
    expect(s.body.toString('utf8')).toContain('name="prompt"\r\n\r\n会议\r\n')
    expect(text).toContain('filename="rec-1.wav"\r\nContent-Type: audio/wav')
    expect(s.body.includes(Buffer.from(wav))).toBe(true)
  })

  it('accepts json, verbose_json, text and SenseVoice-tagged answers', async () => {
    for (const [mode, expected] of [['verbose', 'hello there'], ['plain', 'plain transcript'], ['sensevoice', '今天天气不错。']]) {
      const { app, getCookie } = await adminApp({ asrBaseUrl: `${base}/${mode}/v1` })
      const r = await upload(app, getCookie(), wav)
      expect(JSON.parse(r.text)).toEqual({ ok: true, text: expected })
    }
  })

  it('maps upstream errors and never leaks keys', async () => {
    const cases: [string, number, string][] = [
      ['echo401', 502, 'auth'], ['nothing', 502, 'not_found'], ['big', 413, 'too_large'], ['dur', 413, 'too_large'],
      ['e500', 502, 'upstream'], ['html', 502, 'bad_response'], ['odd', 502, 'bad_response'], ['slow', 504, 'timeout'],
    ]
    for (const [mode, status, code] of cases) {
      const { app, getCookie } = await adminApp({ asrBaseUrl: `${base}/${mode}/v1` })
      const r = await upload(app, getCookie(), wav)
      expect([mode, r.status]).toEqual([mode, status])
      expect(JSON.parse(r.text)).toMatchObject({ ok: false, code })
      expect(r.text).not.toContain(STORED)
    }
    const { app, getCookie } = await adminApp({ asrBaseUrl: 'http://127.0.0.1:1/v1' })
    expect(JSON.parse((await upload(app, getCookie(), wav)).text)).toMatchObject({ ok: false, code: 'network' })
  })

  it('enforces the size limit, Content-Length, content type and login', async () => {
    const { app, getCookie } = await adminApp({ asrMaxBytes: 4000 })
    seen.length = 0
    const big = new Uint8Array(5000)
    const r = await upload(app, getCookie(), big)
    expect(r.status).toBe(413)
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, code: 'too_large' })
    // a body longer than its declared length is cut off, not forwarded
    const lie = await upload(app, getCookie(), big, { length: 100 })
    expect(lie.status).not.toBe(200)
    expect(seen.every((s) => s.body.length < 1000)).toBe(true)
    expect((await upload(app, getCookie(), wav, { ctype: 'text/plain' })).status).toBe(415)
    expect((await upload(app, getCookie(), wav, { ctype: 'multipart/form-data; boundary=x' })).status).toBe(415)
    expect((await upload(app, '', wav)).status).toBe(401)
    // cross-site origin is rejected
    const cross = await app.request('/api/transcribe', { method: 'POST', headers: { cookie: getCookie(), 'content-type': 'audio/wav', 'content-length': String(wav.length), origin: 'https://evil.example', host: 'localhost' }, body: wav })
    expect(cross.status).toBe(403)
  })

  it('is available to non-admin users', async () => {
    const { app, getCookie, db } = await adminApp()
    db.prepare('UPDATE users SET is_admin = 0').run()
    expect((await upload(app, getCookie(), wav)).status).toBe(200)
  })

  it('works without an API key and then sends no Authorization header (e.g. a private SenseVoice server)', async () => {
    const ctx = makeApp({ asrBaseUrl: `${base}/noauth/v1`, asrModel: 'sensevoice-small', asrApiKey: '' })
    await ctx.req('POST', '/api/setup', { username: 'admin', password: 'password123', setupCode: CODE })
    const r = await upload(ctx.app, ctx.getCookie(), wav)
    expect(JSON.parse(r.text)).toEqual({ ok: true, text: '无鉴权' })
    expect(await (await ctx.req('POST', '/api/settings/asr/test', {})).json()).toMatchObject({ ok: true, text: '无鉴权' })
    expect((await (await ctx.req('GET', '/api/settings')).json()).asr).toMatchObject({ hasApiKey: false, keySource: 'none' })
  })

  it('reports not configured', async () => {
    const { app, getCookie } = await adminApp({ asrBaseUrl: '', asrModel: '' })
    const r = await upload(app, getCookie(), wav)
    expect(r.status).toBe(503)
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, code: 'not_configured' })
  })
})

describe('ASR settings', () => {
  it('stores the ASR key encrypted, never returns it, and supports env defaults', async () => {
    const { req, db } = await adminApp({ asrApiKey: ENV })
    const v = await (await req('GET', '/api/settings')).json()
    expect(v.asr).toMatchObject({ baseUrl: `${base}/json/v1`, model: 'whisper-1', hasApiKey: true, keySource: 'settings', segmentSeconds: 28 })
    const stored = getSetting(db, 'asr_api_key_enc')!
    expect(stored.startsWith('v1:')).toBe(true)
    expect(JSON.stringify(db.prepare('SELECT * FROM settings').all())).not.toContain(STORED)
    for (const [m, p, b] of [['GET', '/api/settings'], ['GET', '/api/settings/public'], ['PUT', '/api/settings', {}], ['POST', '/api/settings/asr/test', {}], ['POST', '/api/settings/asr/models', {}]] as [string, string, unknown?][]) {
      const t = await (await req(m, p, b)).text()
      expect(t).not.toContain(STORED)
      expect(t).not.toContain(ENV)
    }
    const cleared = await (await req('PUT', '/api/settings', { clearAsrApiKey: true })).json()
    expect(cleared.asr.keySource).toBe('env')
    const pub = await (await req('GET', '/api/settings/public')).json()
    expect(pub.asr).toMatchObject({ configured: true, segmentSeconds: 28 })
  })

  it('saves base URL, model and a clamped max segment length', async () => {
    const { req } = await adminApp()
    let v = await (await req('PUT', '/api/settings', { asrBaseUrl: 'https://api.ant-ling.com/v1/', asrModel: 'Ming-3.0-asr-tiny', asrSegmentSeconds: 120 })).json()
    expect(v.asr).toMatchObject({ baseUrl: 'https://api.ant-ling.com/v1', model: 'Ming-3.0-asr-tiny', segmentSeconds: 120 })
    v = await (await req('PUT', '/api/settings', { asrSegmentSeconds: 2 })).json()
    expect(v.asr.segmentSeconds).toBe(5)
    v = await (await req('PUT', '/api/settings', { asrSegmentSeconds: 99999 })).json()
    expect(v.asr.segmentSeconds).toBe(600)
    expect((await req('PUT', '/api/settings', { asrSegmentSeconds: 'abc' })).status).toBe(400)
    expect((await req('PUT', '/api/settings', { asrBaseUrl: 'ftp://x' })).status).toBe(400)
  })

  it('test connection and model list use the form values with the stored key as fallback', async () => {
    const { req, db } = await adminApp()
    seen.length = 0
    expect(await (await req('POST', '/api/settings/asr/test', {})).json()).toMatchObject({ ok: true, text: '你好世界' })
    expect(seen[0].auth).toBe(`Bearer ${STORED}`)
    expect(seen[0].body.toString('latin1')).toContain('RIFF')
    expect(await (await req('POST', '/api/settings/asr/test', { apiKey: 'sk-bad' })).json()).toMatchObject({ ok: false, code: 'auth' })
    expect(await (await req('POST', '/api/settings/asr/test', { baseUrl: `${base}/nothing/v1` })).json()).toMatchObject({ ok: false, code: 'not_found' })
    expect(await (await req('POST', '/api/settings/asr/models', { apiKey: FORM })).json()).toEqual({ ok: true, models: ['SenseVoiceSmall', 'whisper-1'] })
    expect(seen.at(-1)!.auth).toBe(`Bearer ${FORM}`)
    expect((await req('POST', '/api/settings/asr/test', { baseUrl: 'javascript:x' })).status).toBe(400)
    db.prepare('UPDATE users SET is_admin = 0').run()
    expect((await req('POST', '/api/settings/asr/test', {})).status).toBe(403)
    expect((await req('POST', '/api/settings/asr/models', {})).status).toBe(403)
  })
})

describe('transcript parsing', () => {
  it('handles the response shapes providers use', () => {
    expect(parseTranscription('{"text":"a"}', 'application/json')).toBe('a')
    expect(parseTranscription('{"result":{"text":"nested"}}', 'application/json')).toBe('nested')
    expect(parseTranscription('{"segments":[{"text":"x"},{"text":"y"}]}', 'application/json')).toBe('xy')
    expect(parseTranscription('[{"text":"a"},{"text":"b"}]', 'application/json')).toBe('ab')
    expect(parseTranscription('"just a string"', 'application/json')).toBe('just a string')
    expect(parseTranscription('hello\n', 'text/plain')).toBe('hello')
    expect(parseTranscription('{"foo":1}', 'application/json')).toBeUndefined()
    expect(parseTranscription('<html></html>', 'text/html')).toBeUndefined()
    expect(parseTranscription('not json', 'application/json')).toBeUndefined()
    expect(cleanTranscript('<|en|><|EMO_UNKNOWN|><|Speech|><|woitn|>hi there')).toBe('hi there')
  })
})
