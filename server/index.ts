/**
 * Jev Race Lab API — entry point. Loads `.env`, builds the adapters and listens on PORT (8787).
 * Serves the built SPA from `dist/` when it exists (production: `npm run build` first).
 *
 * `.env` is hot-reloaded: editing it (keys, JEV_MODEL, OPENAI_MODEL, prices…) rebuilds the
 * adapters in place, without restarting the process. Only PORT needs a restart.
 */
import { existsSync, readFileSync, watchFile } from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import type { EngineId } from '../src/shared/contracts.ts'
import { createAdapters } from './adapters/index.ts'
import { createApp } from './app.ts'
import { configWarnings, loadConfig, type ServerConfig } from './env.ts'

const root = path.resolve(import.meta.dirname, '..')
const envFile = path.join(root, '.env')
/** Variables exported in the shell win over `.env`, same precedence as dotenv.config(). */
const shellEnv = { ...process.env }

function readConfig(): ServerConfig {
  const fileEnv = existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {}
  return loadConfig({ ...fileEnv, ...shellEnv })
}

let config = readConfig()
/** createApp reads this object on every request, so reloading swaps its entries in place. */
const adapters = createAdapters(config)

function describeLanes(): string {
  const lane = (id: EngineId) =>
    `${id}: ${adapters[id].live ? 'LIVE' : 'no key (mock only)'} · ${adapters[id].model}${adapters[id].provider ? ` via ${adapters[id].provider}` : ''}`
  return `${lane('gpt')} | ${lane('jev')}`
}

function reloadEnv() {
  const next = readConfig()
  const before = describeLanes()
  Object.assign(adapters, createAdapters(next))
  if (next.port !== config.port) console.warn(`[api] ⚠ PORT changed to ${next.port}: restart the API to apply it`)
  config = { ...next, port: config.port }
  const after = describeLanes()
  console.log(after === before ? '[api] .env reloaded (no engine changes)' : `[api] .env reloaded → ${after}`)
  for (const warning of configWarnings(config)) console.warn(`[api] ⚠ ${warning}`)
}

// Polling (not fs.watch) so editors that save by replacing the file are detected too.
watchFile(envFile, { interval: 1000 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) reloadEnv()
})
const distDir = path.join(root, 'dist')
const staticDir = existsSync(path.join(distDir, 'index.html')) ? distDir : null
const app = createApp({ adapters, staticDir })

const server = app.listen(config.port, () => {
  console.log(`[api] Jev Race Lab API on http://localhost:${config.port}${staticDir ? ' (serving dist/)' : ''}`)
  console.log(`[api] ${describeLanes()}`)
  for (const warning of configWarnings(config)) console.warn(`[api] ⚠ ${warning}`)
})

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`[api] failed to start: ${error.code ?? ''} ${error.message}`)
  process.exit(1)
})

function shutdown(signal: string) {
  console.log(`[api] ${signal} received, closing`)
  server.close(() => process.exit(0))
  server.closeAllConnections()
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
