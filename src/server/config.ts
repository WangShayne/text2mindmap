import path from 'node:path'

function int(name: string, def: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return def
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : def
}

/** TRUST_PROXY: unset/false/0 = off, true = 1 proxy, or a number of proxy hops. */
export function parseTrustProxy(v: string | undefined): number {
  const s = (v ?? '').trim().toLowerCase()
  if (s === 'true' || s === 'yes') return 1
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 0
}

export interface AppConfig {
  port: number
  host: string
  dataDir: string
  appSecret?: string
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  llmTemperature?: number
  llmTimeoutMs: number
  llmChunkChars: number
  maxInputChars: number
  cookieSecure: 'auto' | boolean
  /** Number of reverse proxies in front of the app whose X-Forwarded-* headers are trusted (0 = none). */
  trustProxy: number
  sessionDays: number
  adminUsername?: string
  adminPassword?: string
  staticDir?: string
}

export function loadConfig(env = process.env): AppConfig {
  const temp = env.LLM_TEMPERATURE
  const cs = (env.COOKIE_SECURE ?? 'auto').toLowerCase()
  return {
    port: int('PORT', 3000),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    appSecret: env.APP_SECRET || undefined,
    llmBaseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    llmApiKey: env.LLM_API_KEY || '',
    llmModel: env.LLM_MODEL || 'gpt-4o-mini',
    llmTemperature: temp !== undefined && temp !== '' && !Number.isNaN(Number(temp)) ? Number(temp) : undefined,
    llmTimeoutMs: int('LLM_TIMEOUT_MS', 180_000),
    llmChunkChars: int('LLM_CHUNK_CHARS', 12_000),
    maxInputChars: int('MAX_INPUT_CHARS', 200_000),
    cookieSecure: cs === 'true' ? true : cs === 'false' ? false : 'auto',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sessionDays: int('SESSION_DAYS', 30),
    adminUsername: env.ADMIN_USERNAME || undefined,
    adminPassword: env.ADMIN_PASSWORD || undefined,
    staticDir: env.STATIC_DIR || undefined,
  }
}
