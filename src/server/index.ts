import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { loadConfig } from './config'
import { openDb } from './db'
import { SecretBox, resolveAppSecret } from './secrets'
import type { Server } from 'node:http'
import { createApp } from './app'
import { attachRealtime } from './realtime'
import { createFirstUser, userCount } from './auth'
import { validateCredentials } from './passwords'
import { SetupCode } from './setupCode'
import { APP_NAME } from '../shared/brand'

declare const __APP_VERSION__: string | undefined

async function main() {
  const config = loadConfig()
  const db = openDb(config.dataDir)
  const secretBox = new SecretBox(resolveAppSecret(config.dataDir, config.appSecret))
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

  if (userCount(db) === 0 && config.adminUsername && config.adminPassword) {
    const err = validateCredentials(config.adminUsername, config.adminPassword)
    if (err) console.error(`[error] ADMIN_USERNAME/ADMIN_PASSWORD rejected: ${err}`)
    else { await createFirstUser(db, config.adminUsername, config.adminPassword); console.log(`[info] Created admin user "${config.adminUsername}" from environment.`) }
  }
  let setupCode = SetupCode.none()
  if (userCount(db) === 0) {
    setupCode = SetupCode.generate(config.dataDir)
    const line = '='.repeat(64)
    console.log(`${line}\n  No admin account yet. Open the app and enter this one-time setup code:\n\n      SETUP CODE: ${setupCode.display}\n\n  (also in ${path.join(config.dataDir, 'setup-code')}; a new code is generated on every restart until setup is done)\n${line}`)
  } else if (config.dataDir !== ':memory:') {
    fs.rmSync(path.join(config.dataDir, 'setup-code'), { force: true })
  }

  const app = createApp({ db, config, secretBox, setupCode, version })
  const here = path.dirname(fileURLToPath(import.meta.url))
  const staticDir = config.staticDir ?? path.resolve(here, '../web')
  if (fs.existsSync(path.join(staticDir, 'index.html')) && fs.existsSync(path.join(staticDir, 'assets'))) {
    const rel = path.relative(process.cwd(), staticDir) || '.'
    app.use('/assets/*', async (c, next) => { await next(); if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable') })
    app.use('/*', serveStatic({ root: rel }))
    const indexHtml = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8')
    app.get('*', (c) => c.html(indexHtml, 200, { 'Cache-Control': 'no-cache' }))
  } else {
    console.warn(`[warn] Frontend not found in ${staticDir}; serving the API only.`)
  }

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (i) => console.log(`[info] ${APP_NAME} ${version} listening on http://${config.host}:${i.port} (data: ${config.dataDir})`))
  // WebSocket /api/realtime (live captions) is handled on the HTTP upgrade, outside Hono.
  const realtime = attachRealtime(server as Server, { db, config, secretBox })
  const shutdown = () => { realtime.close(); server.close(); db.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => { console.error(e); process.exit(1) })
