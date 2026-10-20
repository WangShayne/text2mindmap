import { createApp } from '../src/server/app'
import { loadConfig, type AppConfig } from '../src/server/config'
import { openDb } from '../src/server/db'
import { SecretBox } from '../src/server/secrets'

export function makeApp(over: Partial<AppConfig> = {}, env: Record<string, string> = {}) {
  const config = { ...loadConfig({ ...env } as NodeJS.ProcessEnv), dataDir: ':memory:', ...over }
  const db = openDb(':memory:')
  const secretBox = new SecretBox('test-secret')
  const app = createApp({ db, config, secretBox })
  let cookie = ''
  const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const sc = res.headers.get('set-cookie')
    if (sc) cookie = sc.split(';')[0]
    return res
  }
  return { app, db, config, secretBox, req, setCookie: (c: string) => { cookie = c }, getCookie: () => cookie }
}

export function parseSse(text: string): { event: string; data: any }[] {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const ev = /^event: (.*)$/m.exec(b)?.[1] ?? 'message'
      const data = b.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
      return { event: ev, data: data ? JSON.parse(data) : null }
    })
}
