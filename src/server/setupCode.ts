import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// No 0/O/1/I/L to keep it easy to read from a log.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function normalizeCode(s: unknown): string {
  return typeof s === 'string' ? s.toUpperCase().replace(/[\s-]/g, '') : ''
}

const digest = (s: string) => crypto.createHash('sha256').update(s).digest()

/**
 * One-time code that protects first-run admin creation. A new code is generated on every
 * start until the admin exists. It is printed to the log and kept in DATA_DIR/setup-code (0600).
 */
export class SetupCode {
  private code: string | null
  private constructor(code: string | null, private file?: string) { this.code = code }

  static generate(dataDir: string, length = 10): SetupCode {
    let code = ''
    while (code.length < length) {
      const b = crypto.randomBytes(1)[0]
      if (b < 248) code += ALPHABET[b % ALPHABET.length] // 248 = 8 * 31, no modulo bias
    }
    let file: string | undefined
    if (dataDir !== ':memory:') {
      file = path.join(dataDir, 'setup-code')
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(file, code + '\n', { mode: 0o600 })
      fs.chmodSync(file, 0o600)
    }
    return new SetupCode(code, file)
  }

  /** For tests: a fixed code, nothing written to disk. */
  static fixed(code: string): SetupCode { return new SetupCode(normalizeCode(code)) }
  static none(): SetupCode { return new SetupCode(null) }

  get active(): boolean { return this.code !== null }
  /** Formatted for the log, e.g. ABCDE-FGHJK */
  get display(): string { return this.code ? this.code.replace(/(.{5})(?=.)/g, '$1-') : '' }

  /** Constant-time comparison of the normalized input against the code. */
  matches(input: unknown): boolean {
    if (!this.code) return false
    return crypto.timingSafeEqual(digest(normalizeCode(input)), digest(this.code))
  }

  /** Invalidate after the admin was created. */
  consume(): void {
    this.code = null
    if (this.file) fs.rmSync(this.file, { force: true })
  }
}
