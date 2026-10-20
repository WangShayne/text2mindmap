import crypto from 'node:crypto'
import type { DB } from './db'
import { hashPassword } from './passwords'

export interface User { id: number; username: string; is_admin: number }

export const SESSION_COOKIE = 't2m_session'

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export function userCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
}

/** Creates the first (admin) user. Returns null if a user already exists. */
export async function createFirstUser(db: DB, username: string, password: string): Promise<User | null> {
  const hash = await hashPassword(password)
  db.exec('BEGIN IMMEDIATE')
  try {
    if (userCount(db) > 0) { db.exec('ROLLBACK'); return null }
    const r = db.prepare('INSERT INTO users(username, password_hash, is_admin, created_at) VALUES(?, ?, 1, ?)').run(username, hash, Date.now())
    db.exec('COMMIT')
    return { id: Number(r.lastInsertRowid), username, is_admin: 1 }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function createSession(db: DB, userId: number, days: number): { token: string; expires: number } {
  const token = crypto.randomBytes(32).toString('base64url')
  const expires = Date.now() + days * 86_400_000
  db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)').run(sha(token), userId, Date.now(), expires)
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
  return { token, expires }
}

export function sessionUser(db: DB, token: string | undefined): User | null {
  if (!token) return null
  const r = db
    .prepare('SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .get(sha(token), Date.now()) as User | undefined
  return r ?? null
}

export function deleteSession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token))
}

/** Fixed-window limiter for failed logins, keyed by client IP. */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>()
  constructor(private max: number, private windowMs: number) {}
  blocked(key: string): number {
    const h = this.hits.get(key)
    if (!h || h.reset < Date.now()) return 0
    return h.count >= this.max ? Math.ceil((h.reset - Date.now()) / 1000) : 0
  }
  fail(key: string): void {
    const now = Date.now()
    const h = this.hits.get(key)
    if (!h || h.reset < now) this.hits.set(key, { count: 1, reset: now + this.windowMs })
    else h.count++
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k)
  }
  clear(key: string): void { this.hits.delete(key) }
}
