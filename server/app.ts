/**
 * Express app factory (no listening here, so tests can mount it on an ephemeral port).
 *
 *  GET  /api/health  → HealthResponse (live = API key configured, model = configured model)
 *  GET  /api/models  → ModelsResponse: models selectable in the UI per engine (?refresh=1 re-lists)
 *  POST /api/decide  → DecisionResult. 400 only for malformed requests; model-level failures
 *                      (missing key, upstream error, unparseable output) are HTTP 200 with
 *                      status 'invalid' | 'error' inside (see contracts.ts DecideResponse).
 *
 * Client disconnects (runner timeout / race abort) abort the upstream call via AbortController.
 * Logs one concise line per API request (engine, status, latency); never bodies or keys.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { DecisionResult, EngineId, HealthResponse, ModelsResponse } from '../src/shared/contracts.ts'
import { errorResult, type Adapters } from './adapters/common.ts'
import { parseDecideRequest } from './validate.ts'

export interface AppOptions {
  adapters: Adapters
  /** Built SPA to serve (production). null/undefined = API only. */
  staticDir?: string | null
  /** Request log sink (default console.log). Pass () => {} to silence. */
  log?: (line: string) => void
  /** JSON body limit (default 128kb; an observation is a few KB). */
  bodyLimit?: string
}

interface DecideLocals {
  engine?: EngineId
  decision?: DecisionResult
}

function requestLogger(log: (line: string) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api')) return next()
    const started = performance.now()
    res.on('close', () => {
      const ms = Math.round(performance.now() - started)
      const locals = res.locals as DecideLocals
      const parts = [`[api] ${req.method} ${req.path}`, res.writableFinished ? String(res.statusCode) : 'client-closed', `${ms}ms`]
      if (locals.engine) parts.push(`engine=${locals.engine}`)
      const d = locals.decision
      if (d) {
        parts.push(`decision=${d.status}`, `model=${d.model}`)
        if (d.providerLatencyMs !== undefined) parts.push(`provider=${d.providerLatencyMs}ms`)
        if (d.status !== 'ok' && d.errorMessage) {
          parts.push(`· ${d.errorMessage.length > 160 ? `${d.errorMessage.slice(0, 160)}…` : d.errorMessage}`)
        }
      }
      log(parts.join(' '))
    })
    next()
  }
}

export function createApp(options: AppOptions): express.Express {
  const { adapters, staticDir, log = console.log, bodyLimit = '128kb' } = options
  const app = express()
  app.disable('x-powered-by')
  app.use(requestLogger(log))
  app.use('/api', express.json({ limit: bodyLimit }))

  app.get('/api/health', (_req, res) => {
    // Never cached: the engines can change at runtime when .env is edited.
    res.set('Cache-Control', 'no-store')
    const health: HealthResponse = {
      ok: true,
      engines: {
        gpt: { live: adapters.gpt.live, model: adapters.gpt.model, provider: adapters.gpt.provider },
        jev: { live: adapters.jev.live, model: adapters.jev.model, provider: adapters.jev.provider },
      },
    }
    res.json(health)
  })

  app.get('/api/models', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const force = req.query.refresh === '1'
    const [gpt, jev] = await Promise.all([adapters.gpt.listModels(force), adapters.jev.listModels(force)])
    const body: ModelsResponse = { engines: { gpt, jev } }
    res.json(body)
  })

  app.post('/api/decide', async (req, res) => {
    const parsed = parseDecideRequest(req.body)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }
    const { engine, observation, model } = parsed.value
    const locals = res.locals as DecideLocals
    locals.engine = engine
    const adapter = adapters[engine]

    // Browser went away (runner timeout / abort) → cancel the upstream request.
    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) controller.abort(new Error('Client disconnected'))
    }
    res.on('close', onClose)

    let result: DecisionResult
    try {
      result = await adapter.decide(observation, { signal: controller.signal, model })
    } catch {
      // Adapters are designed not to throw; this is a last-resort guard (no details: may contain secrets).
      result = errorResult(engine, adapter.model, 'Unexpected server error in adapter')
    } finally {
      res.off('close', onClose)
    }
    locals.decision = result
    if (controller.signal.aborted || res.destroyed) return
    res.json(result)
  })

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  if (staticDir && existsSync(staticDir)) {
    const indexHtml = path.join(staticDir, 'index.html')
    app.use(express.static(staticDir))
    // SPA fallback for client-side routes.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()
      res.sendFile(indexHtml)
    })
  }

  // JSON errors (malformed JSON → 400, too large → 413) instead of Express' HTML page.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err)
    const e = err as { status?: number; statusCode?: number; type?: string }
    const status = e.status ?? e.statusCode ?? 500
    const message =
      e.type === 'entity.parse.failed'
        ? 'Malformed JSON body'
        : e.type === 'entity.too.large'
          ? 'Request body too large'
          : status < 500
            ? 'Bad request'
            : 'Internal server error'
    res.status(status).json({ error: message })
  })

  return app
}
