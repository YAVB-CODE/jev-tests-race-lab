import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionResult } from '../shared/contracts.ts'
import { RemoteEngine } from './RemoteEngine.ts'
import { JUNCTION_ORACLE, makeCtx, makeObservation } from './testFixtures.ts'

const OK_RESULT: DecisionResult = {
  engine: 'jev',
  mode: 'live',
  model: 'jev-1.13',
  status: 'ok',
  answer: { move: 'forward', speed: 'cruise', moveConfidence: 0.93 },
  providerLatencyMs: 143,
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RemoteEngine', () => {
  it('has live mode and Spanish-friendly labels', () => {
    expect(new RemoteEngine('gpt', { model: 'gpt-4.1-mini' }).label).toBe('GPT · gpt-4.1-mini')
    expect(new RemoteEngine('jev').label).toBe('Jev · jev-1.13-free')
    expect(new RemoteEngine('jev').mode).toBe('live')
  })

  it('POSTs only { engine, observation } (no model picked) — never the oracle or anything derived from it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(OK_RESULT))
    vi.stubGlobal('fetch', fetchMock)
    const engine = new RemoteEngine('jev')
    const observation = makeObservation('hard', 4)
    const ctx = makeCtx(JUNCTION_ORACLE)

    const result = await engine.decide(observation, ctx)

    expect(result).toEqual(OK_RESULT)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/decide')
    expect(init.method).toBe('POST')
    expect(init.signal).toBe(ctx.signal)
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    const sent = JSON.parse(init.body as string) as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['engine', 'observation'])
    expect(sent.engine).toBe('jev')
    expect(sent.observation).toEqual(observation)
    for (const forbidden of ['oracle', 'bestMove', 'validMoves', 'speedByMove', 'routeLengthByMove', 'isJunction']) {
      expect(init.body as string).not.toContain(forbidden)
    }
  })

  it('sends the model picked in the UI (and only the oracle-free fields)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(OK_RESULT), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const engine = new RemoteEngine('gpt', { model: 'gpt-5-mini' })
    expect(engine.label).toContain('gpt-5-mini')
    await engine.decide(makeObservation(), makeCtx())
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sent = JSON.parse(init.body as string) as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['engine', 'model', 'observation'])
    expect(sent.model).toBe('gpt-5-mini')
  })

  it('maps a network failure to status "error" with a message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const engine = new RemoteEngine('gpt', { model: 'gpt-4.1-mini' })
    const result = await engine.decide(makeObservation(), makeCtx())
    expect(result.status).toBe('error')
    expect(result.engine).toBe('gpt')
    expect(result.mode).toBe('live')
    expect(result.model).toBe('gpt-4.1-mini')
    expect(result.errorMessage).toContain('Failed to fetch')
    expect(result.answer).toEqual({ move: null, speed: null })
  })

  it('maps a non-200 response to status "error" including the HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream exploded', { status: 502 })))
    const result = await new RemoteEngine('jev').decide(makeObservation(), makeCtx())
    expect(result.status).toBe('error')
    expect(result.errorMessage).toContain('502')
    expect(result.errorMessage).toContain('upstream exploded')
  })

  it('maps an unparseable or malformed body to status "error"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>not json</html>', { status: 200 })))
    const notJson = await new RemoteEngine('jev').decide(makeObservation(), makeCtx())
    expect(notJson.status).toBe('error')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ hello: 'world' })))
    const malformed = await new RemoteEngine('jev').decide(makeObservation(), makeCtx())
    expect(malformed.status).toBe('error')
    expect(malformed.errorMessage).toContain('Malformed')
  })

  it('passes through model-level failures reported by the server (HTTP 200, status invalid)', async () => {
    const invalid: DecisionResult = { ...OK_RESULT, engine: 'gpt', status: 'invalid', answer: { move: null, speed: null } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(invalid)))
    expect(await new RemoteEngine('gpt').decide(makeObservation(), makeCtx())).toEqual(invalid)
  })

  it('rethrows the AbortError when the signal aborts mid-request', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const promise = new RemoteEngine('gpt').decide(makeObservation(), makeCtx(JUNCTION_ORACLE, 1, controller.signal))
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion
  })

  it('throws an AbortError without calling fetch when already aborted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    await expect(
      new RemoteEngine('gpt').decide(makeObservation(), makeCtx(JUNCTION_ORACLE, 1, controller.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
