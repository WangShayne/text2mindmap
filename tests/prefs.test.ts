import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODE, makeApp } from './helpers'
import { openDb, getUserPrefs } from '../src/server/db'
import { SESSION_COOKIE, createSession } from '../src/server/auth'
import { DEFAULT_MAP_STYLE, MAP_LAYOUTS, MAP_THEMES, normalizeMapStyle } from '../src/shared/mapStyle'

async function admin() {
  const t = makeApp()
  await t.req('POST', '/api/setup', { username: 'admin', password: 'password123', setupCode: CODE })
  return t
}

describe('map style preferences (per user)', () => {
  it('needs login', async () => {
    const { req } = makeApp()
    expect((await req('GET', '/api/prefs')).status).toBe(401)
    expect((await req('PUT', '/api/prefs', { mapTheme: 'dark' })).status).toBe(401)
  })

  it('returns defaults before anything is saved', async () => {
    const { req } = await admin()
    const r = await req('GET', '/api/prefs')
    expect(r.status).toBe(200)
    expect((await r.json()).prefs).toEqual({ mapTheme: DEFAULT_MAP_STYLE.theme, mapLayout: DEFAULT_MAP_STYLE.layout })
  })

  it('saves theme and layout, independently, and keeps them', async () => {
    const { req, db } = await admin()
    let r = await (await req('PUT', '/api/prefs', { mapTheme: 'dark' })).json()
    expect(r.prefs).toEqual({ mapTheme: 'dark', mapLayout: 'logicalStructure' })
    r = await (await req('PUT', '/api/prefs', { mapLayout: 'organizationStructure' })).json()
    expect(r.prefs).toEqual({ mapTheme: 'dark', mapLayout: 'organizationStructure' })
    expect((await (await req('GET', '/api/prefs')).json()).prefs).toEqual({ mapTheme: 'dark', mapLayout: 'organizationStructure' })
    expect(getUserPrefs(db, 1)).toMatchObject({ mapTheme: 'dark', mapLayout: 'organizationStructure' })
  })

  it('accepts every listed theme and layout', async () => {
    const { req } = await admin()
    for (const mapTheme of MAP_THEMES) expect((await (await req('PUT', '/api/prefs', { mapTheme })).json()).prefs.mapTheme).toBe(mapTheme)
    for (const mapLayout of MAP_LAYOUTS) expect((await (await req('PUT', '/api/prefs', { mapLayout })).json()).prefs.mapLayout).toBe(mapLayout)
  })

  it('rejects unknown values without changing the saved ones', async () => {
    const { req } = await admin()
    await req('PUT', '/api/prefs', { mapTheme: 'ocean', mapLayout: 'mindMap' })
    expect((await req('PUT', '/api/prefs', { mapTheme: 'neon' })).status).toBe(400)
    expect((await req('PUT', '/api/prefs', { mapLayout: 'fishbone' })).status).toBe(400)
    expect((await req('PUT', '/api/prefs', { mapTheme: { evil: true } })).status).toBe(400)
    expect((await (await req('GET', '/api/prefs')).json()).prefs).toEqual({ mapTheme: 'ocean', mapLayout: 'mindMap' })
  })

  it('applies to all of the user\'s documents (not stored per document)', async () => {
    const { req } = await admin()
    await req('PUT', '/api/prefs', { mapTheme: 'forest' })
    const a = (await (await req('POST', '/api/docs', { title: 'a' })).json()).doc
    const b = (await (await req('POST', '/api/docs', { title: 'b' })).json()).doc
    for (const d of [a, b]) {
      const doc = (await (await req('GET', `/api/docs/${d.id}`)).json()).doc
      expect(doc).not.toHaveProperty('mapTheme')
    }
    expect((await (await req('GET', '/api/prefs')).json()).prefs.mapTheme).toBe('forest')
  })

  it('is separate for each user', async () => {
    const { req, db, app } = await admin()
    await req('PUT', '/api/prefs', { mapTheme: 'sunset' })
    db.prepare("INSERT INTO users(username, password_hash, is_admin, created_at) VALUES('bob', 'x', 0, 0)").run()
    const bob = db.prepare("SELECT id FROM users WHERE username = 'bob'").get() as { id: number }
    const s = createSession(db, bob.id, 1)
    const asBob = (method: string, p: string, body?: unknown) => app.request(p, {
      method, headers: { cookie: `${SESSION_COOKIE}=${s.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    }, { incoming: { socket: { remoteAddress: '10.0.0.2' } } })
    expect((await (await asBob('GET', '/api/prefs')).json()).prefs.mapTheme).toBe('light')
    await asBob('PUT', '/api/prefs', { mapTheme: 'mono', mapLayout: 'mindMap' })
    expect((await (await req('GET', '/api/prefs')).json()).prefs).toEqual({ mapTheme: 'sunset', mapLayout: 'logicalStructure' })
  })

  it('migrates an existing v0.2 database and survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2m-prefs-'))
    try {
      // Simulate a v0.2 database: schema version 1, no prefs column.
      let db = openDb(dir)
      db.exec("ALTER TABLE users DROP COLUMN prefs; PRAGMA user_version = 1;")
      db.prepare("INSERT INTO users(username, password_hash, is_admin, created_at) VALUES('old', 'x', 1, 0)").run()
      db.close()
      db = openDb(dir)
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
      expect(getUserPrefs(db, 1)).toEqual({})
      db.prepare('UPDATE users SET prefs = ? WHERE id = 1').run(JSON.stringify({ mapTheme: 'dark' }))
      db.close()
      db = openDb(dir)
      expect(getUserPrefs(db, 1)).toEqual({ mapTheme: 'dark' })
      db.close()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('normalizeMapStyle falls back to defaults', () => {
    expect(normalizeMapStyle(undefined)).toEqual(DEFAULT_MAP_STYLE)
    expect(normalizeMapStyle({ theme: 'dark', layout: 'nope' })).toEqual({ theme: 'dark', layout: 'logicalStructure' })
    expect(normalizeMapStyle({ theme: '__proto__', layout: 'mindMap' })).toEqual({ theme: 'light', layout: 'mindMap' })
  })
})
