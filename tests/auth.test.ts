import { describe, expect, it } from 'vitest'
import { makeApp } from './helpers'
import { hashPassword, verifyPassword } from '../src/server/passwords'

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('correct horse 电池')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse 电池', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
  })
})

describe('setup and login', () => {
  it('first-run setup creates the admin once, then is closed', async () => {
    const { req, setCookie } = makeApp()
    expect(await (await req('GET', '/api/setup')).json()).toEqual({ needsSetup: true })
    expect((await req('GET', '/api/docs')).status).toBe(401)
    const r = await req('POST', '/api/setup', { username: 'admin', password: 'password123' })
    expect(r.status).toBe(200)
    const sc = r.headers.get('set-cookie')!
    expect(sc).toMatch(/HttpOnly/i)
    expect(sc).toMatch(/SameSite=Lax/i)
    expect((await r.json()).user).toEqual({ id: 1, username: 'admin', isAdmin: true })
    expect(await (await req('GET', '/api/setup')).json()).toEqual({ needsSetup: false })
    setCookie('')
    const again = await req('POST', '/api/setup', { username: 'evil', password: 'password123' })
    expect(again.status).toBe(403)
    // there is no registration endpoint
    expect((await req('POST', '/api/auth/register', { username: 'evil', password: 'password123' })).status).toBe(401)
  })

  it('validates credentials on setup', async () => {
    const { req } = makeApp()
    expect((await req('POST', '/api/setup', { username: 'a', password: 'password123' })).status).toBe(400)
    expect((await req('POST', '/api/setup', { username: 'admin', password: 'short' })).status).toBe(400)
  })

  it('logs in, reads /me, logs out', async () => {
    const { req, setCookie } = makeApp()
    await req('POST', '/api/setup', { username: 'admin', password: 'password123' })
    setCookie('')
    expect((await req('POST', '/api/auth/login', { username: 'admin', password: 'nope-nope' })).status).toBe(401)
    expect((await req('POST', '/api/auth/login', { username: 'ADMIN', password: 'password123' })).status).toBe(200)
    expect((await (await req('GET', '/api/auth/me')).json()).user.username).toBe('admin')
    await req('POST', '/api/auth/logout', {})
    expect((await req('GET', '/api/auth/me')).status).toBe(401)
  })

  it('rate-limits failed logins', async () => {
    const { req, setCookie } = makeApp()
    await req('POST', '/api/setup', { username: 'admin', password: 'password123' })
    setCookie('')
    for (let i = 0; i < 10; i++) expect((await req('POST', '/api/auth/login', { username: 'admin', password: 'bad-password' })).status).toBe(401)
    const blocked = await req('POST', '/api/auth/login', { username: 'admin', password: 'password123' })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()
  })

  it('changes the password and invalidates other sessions', async () => {
    const { req, setCookie, getCookie } = makeApp()
    await req('POST', '/api/setup', { username: 'admin', password: 'password123' })
    const first = getCookie()
    await req('POST', '/api/auth/login', { username: 'admin', password: 'password123' })
    expect((await req('POST', '/api/auth/password', { current: 'password123', next: 'newpassword456' })).status).toBe(200)
    expect((await req('GET', '/api/auth/me')).status).toBe(200)
    setCookie(first)
    expect((await req('GET', '/api/auth/me')).status).toBe(401)
  })

  it('rejects non-JSON and cross-origin writes (CSRF)', async () => {
    const { app, req } = makeApp()
    await req('POST', '/api/setup', { username: 'admin', password: 'password123' })
    const form = await app.request('/api/docs', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x' })
    expect(form.status).toBe(415)
    const xo = await req('POST', '/api/docs', { title: 'x' }, { origin: 'https://evil.example', host: 'localhost' })
    expect(xo.status).toBe(403)
  })
})

describe('documents', () => {
  it('CRUD scoped to the owner', async () => {
    const { req, db } = makeApp()
    await req('POST', '/api/setup', { username: 'admin', password: 'password123' })
    const created = await (await req('POST', '/api/docs', { title: '我的导图' })).json()
    const id = created.doc.id
    expect(created.doc.markdown).toBe('# 我的导图\n')
    expect((await req('PUT', `/api/docs/${id}`, { markdown: '# 新\n- a\n', title: '改名' })).status).toBe(200)
    const got = (await (await req('GET', `/api/docs/${id}`)).json()).doc
    expect(got).toMatchObject({ title: '改名', markdown: '# 新\n- a\n' })
    const list = (await (await req('GET', '/api/docs')).json()).docs
    expect(list).toHaveLength(1)
    const md = await req('GET', `/api/docs/${id}/export?format=md`)
    expect(await md.text()).toBe('# 新\n- a\n')
    expect(md.headers.get('content-disposition')).toContain("UTF-8''%E6%94%B9%E5%90%8D.md")
    expect(await (await req('GET', `/api/docs/${id}/export?format=opml`)).text()).toContain('<outline text="a"/>')
    // another user's document is invisible
    db.prepare("INSERT INTO users(username, password_hash, is_admin, created_at) VALUES('other', 'x', 0, 0)").run()
    db.prepare("INSERT INTO documents(id, user_id, title, markdown, created_at, updated_at) VALUES('foreign', 2, 't', 'secret', 0, 0)").run()
    expect((await req('GET', '/api/docs/foreign')).status).toBe(404)
    expect((await req('PUT', '/api/docs/foreign', { markdown: 'x' })).status).toBe(404)
    expect((await req('DELETE', '/api/docs/foreign', {})).status).toBe(404)
    expect((await req('DELETE', `/api/docs/${id}`, {})).status).toBe(200)
    expect((await (await req('GET', '/api/docs')).json()).docs).toHaveLength(0)
  })
})
