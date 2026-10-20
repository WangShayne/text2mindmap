import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Returns the app secret: APP_SECRET env, else a generated one persisted in DATA_DIR/secret.key. */
export function resolveAppSecret(dataDir: string, envSecret?: string, log: (m: string) => void = console.warn): string {
  if (envSecret) return envSecret
  if (dataDir === ':memory:') return crypto.randomBytes(32).toString('hex')
  const file = path.join(dataDir, 'secret.key')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  fs.mkdirSync(dataDir, { recursive: true })
  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 })
  log(`[warn] APP_SECRET is not set. Generated one and saved it to ${file}. Back it up with your data: without it, stored API keys cannot be decrypted.`)
  return secret
}

export class SecretBox {
  private key: Buffer
  constructor(secret: string) {
    this.key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('text2mindmap'), Buffer.from('settings-encryption-v1'), 32))
  }
  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
  }
  decrypt(blob: string): string {
    const [v, iv, tag, ct] = blob.split(':')
    if (v !== 'v1') throw new Error('Unknown ciphertext version')
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
  }
}
