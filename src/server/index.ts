import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { loadConfig } from './config'
import { openDb } from './db'
import { SecretBox, resolveAppSecret } from './secrets'
import { createApp } from './app'
import { createFirstUser, userCount } from './auth'
import { validateCredentials } from './passwords'
import { APP_NAME } from '../shared/brand'

declare const __APP_VERSION__: string | undefined

async function main() {
  const config = loadConfig()
  const db = openDb(config.dataDir)
  const secretBox = new SecretBox(resolveAppSecret(config.dataDir, config.appSecret))
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

  if (userCount(db) === 0) {
    if (config.adminUsername && config.adminPassword) {
      const err = validateCredentials(config.adminUsername, config.adminPassword)
      if (err) console.error(`[error] ADMIN_USERNAME/ADMIN_PASSWORD rejected: ${err}`)
      else { await createFirstUser(db, config.adminUsername, config.adminPassword); console.log(`[info] Created admin user "${config.adminUsername}" from environment.`) }
    } else {
      console.warn('[warn] No user exists yet. Open the app and create the admin account on the setup page now (anyone who can reach it first could claim it), or set ADMIN_USERNAME and ADMIN_PASSWORD.')
    }
  }

  const app = createApp({ db, config, secretBox, version })
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
  const shutdown = () => { server.close(); db.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => { console.error(e); process.exit(1) })
