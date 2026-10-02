import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DecisionResult, EngineId, HealthResponse, ModelsResponse, Observation } from '../src/shared/contracts.ts'
import type { Adapters, DecideOptions, EngineAdapter } from './adapters/common.ts'
import { createAdapters } from './adapters/index.ts'
import { createApp, type AppOptions } from './app.ts'
import { loadConfig } from './env.ts'
import { SAMPLE_EASY_OBSERVATION } from './fixtures.ts'

type Decide = (observation: Observation, options?: DecideOptions) => Promise<DecisionResult>

function okResult(engine: EngineId): DecisionResult {
  return { engine, mode: 'live', model: `${engine}-test`, status: 'ok', answer: { move: 'forward', speed: 'cruise' }, providerLatencyMs: 5 }
}

function fakeAdapter(engine: EngineId, decide?: Decide): EngineAdapter & { calls: Observation[]; options: Array<DecideOptions | undefined> } {
  const calls: Observation[] = []
  const options: Array<DecideOptions | undefined> = []
  return {
    engine,
    live: true,
    model: `${engine}-test`,
    calls,
    options,
    async decide(observation, opts) {
      calls.push(observation)
      options.push(opts)
      return decide ? decide(observation, opts) : okResult(engine)
    },
    async listModels(force) {
      return { default: `${engine}-test`, models: [{ id: `${engine}-test` }, { id: `${engine}-other` }], source: force ? 'provider' : 'fallback' }
    },
  }
}

const servers: Array<{ close: () => void }> = []
afterEach(() => {
  while (servers.length) servers.pop()?.close()
})

async function start(options: Partial<AppOptions> & { adapters: Adapters }) {
  const lines: string[] = []
  const app = createApp({ log: (line) => lines.push(line), ...options })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  servers.push({ close: () => server.close() })
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, lines }
}

function post(base: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${base}/api/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  })
}

describe('GET /api/health', () => {
  it('reports each engine as live with its configured model', async () => {
    const { base } = await start({ adapters: { gpt: fakeAdapter('gpt'), jev: fakeAdapter('jev') } })
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HealthResponse
    expect(body).toEqual({ ok: true, engines: { gpt: { live: true, model: 'gpt-test' }, jev: { live: true, model: 'jev-test' } } })
  })
})

describe('POST /api/decide validation', () => {
  it.each([
    ['missing engine', { observation: SAMPLE_EASY_OBSERVATION }],
    ['unknown engine', { engine: 'claude', observation: SAMPLE_EASY_OBSERVATION }],
    ['missing observation', { engine: 'gpt' }],
    ['observation is a string', { engine: 'gpt', observation: 'go forward' }],
    ['observation is an array', { engine: 'jev', observation: [1, 2] }],
    ['observation is null', { engine: 'jev', observation: null }],
    ['body is an array', [{ engine: 'gpt', observation: {} }]],
  ])('400 when %s', async (_name, body) => {
    const gpt = fakeAdapter('gpt')
    const jev = fakeAdapter('jev')
    const { base } = await start({ adapters: { gpt, jev } })
    const res = await post(base, body)
    expect(res.status).toBe(400)
    expect(await res.json()).toHaveProperty('error')
    expect(gpt.calls.length + jev.calls.length).toBe(0)
  })

  it('400 with a JSON error for malformed JSON and for a non-JSON body', async () => {
    const { base } = await start({ adapters: { gpt: fakeAdapter('gpt'), jev: fakeAdapter('jev') } })
    const malformed = await post(base, '{"engine": "gpt", ')
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Malformed JSON body' })
    const text = await fetch(`${base}/api/decide`, { method: 'POST', body: 'hello', headers: { 'content-type': 'text/plain' } })
    expect(text.status).toBe(400)
  })

  it('routes to the right adapter and strips keys outside the Observation contract', async () => {
    const gpt = fakeAdapter('gpt')
    const jev = fakeAdapter('jev')
    const { base, lines } = await start({ adapters: { gpt, jev } })
    const leaked = { ...SAMPLE_EASY_OBSERVATION, oracle: { bestMove: 'forward' }, secret: 'x' }
    const res = await post(base, { engine: 'jev', observation: leaked })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(okResult('jev'))
    expect(gpt.calls).toHaveLength(0)
    expect(jev.calls).toEqual([SAMPLE_EASY_OBSERVATION])
    await new Promise((r) => setTimeout(r, 10))
    expect(lines.some((l) => /POST \/api\/decide 200 \d+ms engine=jev decision=ok model=jev-test provider=5ms/.test(l))).toBe(true)
  })

  it('turns an unexpected adapter exception into HTTP 200 status error', async () => {
    const gpt = fakeAdapter('gpt', async () => {
      throw new Error('kaboom with sk-should-not-leak-123456')
    })
    const { base } = await start({ adapters: { gpt, jev: fakeAdapter('jev') } })
    const res = await post(base, { engine: 'gpt', observation: SAMPLE_EASY_OBSERVATION })
    expect(res.status).toBe(200)
    const body = (await res.json()) as DecisionResult
    expect(body).toMatchObject({ engine: 'gpt', status: 'error', answer: { move: null, speed: null } })
    expect(JSON.stringify(body)).not.toContain('sk-should-not-leak')
  })

  it('404 JSON for unknown API routes', async () => {
    const { base } = await start({ adapters: { gpt: fakeAdapter('gpt'), jev: fakeAdapter('jev') } })
    const res = await fetch(`${base}/api/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})

describe('client disconnect', () => {
  it('aborts the adapter signal when the browser request is aborted', async () => {
    let sawAbort!: () => void
    const aborted = new Promise<void>((resolve) => (sawAbort = resolve))
    let started!: () => void
    const decideStarted = new Promise<void>((resolve) => (started = resolve))
    const gpt = fakeAdapter('gpt', (_obs, options) => {
      started()
      return new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => {
          sawAbort()
          resolve({ ...okResult('gpt'), status: 'error', errorMessage: 'aborted' })
        })
      })
    })
    const { base, lines } = await start({ adapters: { gpt, jev: fakeAdapter('jev') } })
    const controller = new AbortController()
    const request = post(base, { engine: 'gpt', observation: SAMPLE_EASY_OBSERVATION }, { signal: controller.signal })
    await decideStarted
    controller.abort()
    await expect(request).rejects.toThrow()
    await aborted
    await new Promise((r) => setTimeout(r, 20))
    expect(lines.some((l) => l.includes('client-closed') && l.includes('engine=gpt'))).toBe(true)
  })
})

describe('missing keys (real adapters, empty env)', () => {
  it('health shows both engines not live, decide answers fast with status error', async () => {
    const adapters = createAdapters(loadConfig({}))
    const { base } = await start({ adapters })
    const health = (await (await fetch(`${base}/api/health`)).json()) as HealthResponse
    expect(health.engines).toEqual({ gpt: { live: false, model: 'gpt-4.1-mini', provider: 'OpenAI' }, jev: { live: false, model: 'jev-1.13-free', provider: 'OpenCode Zen' } })

    for (const engine of ['gpt', 'jev'] as const) {
      const t0 = performance.now()
      const res = await post(base, { engine, observation: SAMPLE_EASY_OBSERVATION })
      expect(performance.now() - t0).toBeLessThan(1000)
      expect(res.status).toBe(200)
      const body = (await res.json()) as DecisionResult
      expect(body).toMatchObject({ engine, mode: 'live', status: 'error', answer: { move: null, speed: null } })
      expect(body.errorMessage).toContain(engine === 'gpt' ? 'OPENAI_API_KEY' : 'OPENCODE_API_KEY')
    }
  })
})

describe('static SPA (production)', () => {
  it('serves dist/ files and falls back to index.html, keeping /api 404s as JSON', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jev-dist-'))
    try {
      writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Jev Race Lab</title>')
      writeFileSync(path.join(dir, 'app.js'), 'console.log(1)')
      const { base } = await start({ adapters: { gpt: fakeAdapter('gpt'), jev: fakeAdapter('jev') }, staticDir: dir })
      expect(await (await fetch(`${base}/app.js`)).text()).toBe('console.log(1)')
      expect(await (await fetch(`${base}/race/123`)).text()).toContain('Jev Race Lab')
      expect((await fetch(`${base}/api/unknown`)).status).toBe(404)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('model selection', () => {
  async function post(base: string, body: unknown) {
    return fetch(`${base}/api/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  it('GET /api/models returns both catalogues and forwards ?refresh=1', async () => {
    const adapters = { gpt: fakeAdapter('gpt'), jev: fakeAdapter('jev') }
    const { base } = await start({ adapters })
    const cached = (await (await fetch(`${base}/api/models`)).json()) as ModelsResponse
    expect(cached.engines.gpt).toMatchObject({ default: 'gpt-test', source: 'fallback' })
    expect(cached.engines.jev.models.map((m) => m.id)).toEqual(['jev-test', 'jev-other'])
    const fresh = await fetch(`${base}/api/models?refresh=1`)
    expect(fresh.headers.get('cache-control')).toBe('no-store')
    expect(((await fresh.json()) as ModelsResponse).engines.jev.source).toBe('provider')
  })

  it('POST /api/decide passes the chosen model to the adapter', async () => {
    const jev = fakeAdapter('jev')
    const { base } = await start({ adapters: { gpt: fakeAdapter('gpt'), jev } })
    expect((await post(base, { engine: 'jev', observation: SAMPLE_EASY_OBSERVATION, model: 'jev-1.13' })).status).toBe(200)
    expect((await post(base, { engine: 'jev', observation: SAMPLE_EASY_OBSERVATION })).status).toBe(200)
    expect(jev.options.map((o) => o?.model)).toEqual(['jev-1.13', undefined])
  })

  it('rejects malformed model ids with 400', async () => {
    const { base } = await start({ adapters: { gpt: fakeAdapter('gpt'), jev: fakeAdapter('jev') } })
    for (const model of ['', 'gpt 4', 42, 'x'.repeat(101)]) {
      expect((await post(base, { engine: 'gpt', observation: SAMPLE_EASY_OBSERVATION, model })).status).toBe(400)
    }
  })
})
