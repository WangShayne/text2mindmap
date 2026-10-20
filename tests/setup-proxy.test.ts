import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODE, makeApp } from './helpers'
import { SetupCode, normalizeCode } from '../src/server/setupCode'
import { parseTrustProxy } from '../src/server/config'

const creds = { username: 'admin', password: 'password123' }

describe('one-time setup code', () => {
  it('generates a readable code, stores it 0600 and deletes it when consumed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2m-'))
    const sc = SetupCode.generate(dir)
    const file = path.join(dir, 'setup-code')
    const stored = fs.readFileSync(file, 'utf8').trim()
    expect(stored).toMatch(/^[A-HJKMNP-Z2-9]{10}$/)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(sc.display).toMatch(/^.{5}-.{5}$/)
    expect(sc.matches(stored.toLowerCase())).toBe(true) // case-insensitive
    expect(sc.matches(sc.display)).toBe(true) // dashes ignored
    expect(sc.matches(stored.slice(0, 9))).toBe(false)
    expect(SetupCode.generate(dir).matches(stored)).toBe(false) // regenerated on restart
    sc.consume()
    expect(sc.active).toBe(false)
    expect(sc.matches(stored)).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('normalizes input', () => {
    expect(normalizeCode(' ab cd-ef ')).toBe('ABCDEF')
    expect(normalizeCode(undefined)).toBe('')
  })

  it('setup requires the code: missing or wrong -> 403, right -> admin, then the code is invalid', async () => {
    const { req, setupCode, setCookie } = makeApp()
    expect((await req('POST', '/api/setup', creds)).status).toBe(403)
    const wrong = await req('POST', '/api/setup', { ...creds, setupCode: 'WRONG-CODE1' })
    expect(wrong.status).toBe(403)
    expect((await wrong.json()).error).toMatch(/docker compose logs/)
    const ok = await req('POST', '/api/setup', { ...creds, setupCode: CODE.toLowerCase() })
    expect(ok.status).toBe(200)
    expect(setupCode.active).toBe(false)
    setCookie('')
    expect((await req('POST', '/api/setup', { username: 'other', password: 'password123', setupCode: CODE })).status).toBe(403)
  })

  it('checks the code before validating credentials (no oracle without the code)', async () => {
    const { req } = makeApp()
    expect((await req('POST', '/api/setup', { username: 'x', password: 'y', setupCode: 'nope' })).status).toBe(403)
    expect((await req('POST', '/api/setup', { username: 'x', password: 'y', setupCode: CODE })).status).toBe(400)
  })

  it('rate-limits wrong codes per IP', async () => {
    const { req } = makeApp()
    for (let i = 0; i < 10; i++) expect((await req('POST', '/api/setup', { ...creds, setupCode: `BAD${i}` })).status).toBe(403)
    const blocked = await req('POST', '/api/setup', { ...creds, setupCode: CODE })
    expect(blocked.status).toBe(429)
    // another IP is not blocked
    expect((await req('POST', '/api/setup', { ...creds, setupCode: CODE }, {}, '10.0.0.2')).status).toBe(200)
  })
})

describe('TRUST_PROXY', () => {
  it('parses values', () => {
    expect(parseTrustProxy(undefined)).toBe(0)
    expect(parseTrustProxy('false')).toBe(0)
    expect(parseTrustProxy('true')).toBe(1)
    expect(parseTrustProxy('2')).toBe(2)
    expect(parseTrustProxy('garbage')).toBe(0)
  })

  async function admin(trustProxy: number, cookieSecure: 'auto' | boolean = 'auto') {
    const t = makeApp({ trustProxy, cookieSecure })
    await t.req('POST', '/api/setup', { ...creds, setupCode: CODE })
    t.setCookie('')
    return t
  }
  const login = (t: Awaited<ReturnType<typeof admin>>, password: string, headers: Record<string, string> = {}, ip = '172.17.0.1') =>
    t.req('POST', '/api/auth/login', { username: 'admin', password }, headers, ip)

  it('off: forwarded headers are ignored (no Secure from X-Forwarded-Proto, no IP spoofing)', async () => {
    const t = await admin(0)
    const r = await login(t, 'password123', { 'x-forwarded-proto': 'https' })
    expect(r.headers.get('set-cookie')).not.toMatch(/Secure/i)
    for (let i = 0; i < 10; i++) await login(t, 'bad-password', { 'x-forwarded-for': `203.0.113.${i}` })
    // a forged X-Forwarded-For does not get a fresh rate-limit bucket
    expect((await login(t, 'password123', { 'x-forwarded-for': '198.51.100.7' })).status).toBe(429)
  })

  it('on: Secure cookie when the proxy says https, not when it says http', async () => {
    const t = await admin(1)
    expect((await login(t, 'password123', { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).toMatch(/Secure/i)
    expect((await login(t, 'password123', { 'x-forwarded-proto': 'http' })).headers.get('set-cookie')).not.toMatch(/Secure/i)
    expect((await login(t, 'password123', { 'x-forwarded-proto': 'https, http' })).headers.get('set-cookie')).toMatch(/Secure/i)
  })

  it('COOKIE_SECURE=true/false overrides detection', async () => {
    expect((await login(await admin(0, true), 'password123')).headers.get('set-cookie')).toMatch(/Secure/i)
    expect((await login(await admin(1, false), 'password123', { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).not.toMatch(/Secure/i)
  })

  it('on: rate limit uses the client IP added by the proxy (rightmost X-Forwarded-For entry)', async () => {
    const t = await admin(1)
    for (let i = 0; i < 10; i++) await login(t, 'bad-password', { 'x-forwarded-for': `1.1.1.${i}, 203.0.113.5` })
    // same real client, forged left part: still blocked
    expect((await login(t, 'password123', { 'x-forwarded-for': '9.9.9.9, 203.0.113.5' })).status).toBe(429)
    // a different real client behind the same proxy is not blocked
    expect((await login(t, 'password123', { 'x-forwarded-for': '203.0.113.6' })).status).toBe(200)
  })

  it('on with 2 hops: takes the second entry from the right', async () => {
    const t = await admin(2)
    for (let i = 0; i < 10; i++) await login(t, 'bad-password', { 'x-forwarded-for': `6.6.6.${i}, 203.0.113.9, 10.0.0.5` })
    expect((await login(t, 'password123', { 'x-forwarded-for': '203.0.113.9, 10.0.0.6' })).status).toBe(429)
    expect((await login(t, 'password123', { 'x-forwarded-for': '203.0.113.10, 10.0.0.5' })).status).toBe(200)
  })

  it('same-origin check uses X-Forwarded-Host only when the proxy is trusted', async () => {
    const off = await admin(0)
    await login(off, 'password123')
    expect((await off.req('POST', '/api/docs', { title: 'x' }, { origin: 'https://mind.example.com', host: 'mind.example.com' })).status).toBe(201)
    expect((await off.req('POST', '/api/docs', { title: 'x' }, { origin: 'https://mind.example.com', host: '127.0.0.1:3000', 'x-forwarded-host': 'mind.example.com' })).status).toBe(403)
    const on = await admin(1)
    await login(on, 'password123')
    expect((await on.req('POST', '/api/docs', { title: 'x' }, { origin: 'https://mind.example.com', host: '127.0.0.1:3000', 'x-forwarded-host': 'mind.example.com' })).status).toBe(201)
  })
})
