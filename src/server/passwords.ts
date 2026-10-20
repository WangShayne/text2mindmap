import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>
const N = 1 << 15, r = 8, p = 1, LEN = 32
const MAXMEM = 64 * 1024 * 1024

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(pw, salt, LEN, { N, r, p, maxmem: MAXMEM })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, rr, pp, salt, hash] = parts
  const expected = Buffer.from(hash, 'base64')
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +rr, p: +pp, maxmem: MAXMEM })
  return got.length === expected.length && crypto.timingSafeEqual(got, expected)
}

export function validateCredentials(username: unknown, password: unknown): string | null {
  if (typeof username !== 'string' || !/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) return 'Username must be 3-32 letters, digits, _ . or -'
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) return 'Password must be 8-256 characters'
  return null
}
