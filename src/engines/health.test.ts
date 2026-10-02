import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HealthResponse } from '../shared/contracts.ts'
import { createEngine, fetchHealth } from './index.ts'

const OFFLINE: HealthResponse = {
  ok: true,
  engines: { gpt: { live: false, model: 'gpt' }, jev: { live: false, model: 'jev' } },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchHealth', () => {
  it('returns the server payload when it is valid', async () => {
    const payload: HealthResponse = {
      ok: true,
      engines: { gpt: { live: true, model: 'gpt-4.1-mini' }, jev: { live: false, model: 'jev-1.13' } },
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchHealth()).toEqual(payload)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/health')
  })

  it('never throws: network failure, bad status and garbage all resolve the offline fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect(await fetchHealth()).toEqual(OFFLINE)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await fetchHealth()).toEqual(OFFLINE)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })))
    expect(await fetchHealth()).toEqual(OFFLINE)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    expect(await fetchHealth()).toEqual(OFFLINE)
  })
})

describe('createEngine', () => {
  it('builds labelled mock and live engines', () => {
    expect(createEngine('gpt', 'mock').label).toBe('GPT · simulado')
    expect(createEngine('jev', 'mock').label).toBe('Jev · simulado')
    expect(createEngine('gpt', 'live', { model: 'gpt-4.1-mini' }).label).toBe('GPT · gpt-4.1-mini')
    expect(createEngine('jev', 'live').label).toBe('Jev · jev-1.13-free')
    expect(createEngine('gpt', 'mock').mode).toBe('mock')
    expect(createEngine('jev', 'live').mode).toBe('live')
    expect(createEngine('jev', 'mock').id).toBe('jev')
  })

  it('applies partial profile overrides to mocks', async () => {
    const engine = createEngine('jev', 'mock', {
      profile: { latency: { medianMs: 0, minMs: 0, maxMs: 0, spikeProbability: 0 }, transientErrorRate: 0 },
    })
    const controller = new AbortController()
    const result = await engine.decide(
      {
        decisionIndex: 0,
        lap: 1,
        totalLaps: 1,
        heading: 'N',
        currentSpeed: 'slow',
        difficulty: 'easy',
      },
      {
        signal: controller.signal,
        random: () => 0.5,
        oracle: {
          bestMove: 'forward',
          validMoves: ['forward'],
          speedByMove: { forward: 'cruise' },
          routeLengthByMove: { forward: 3 },
          isJunction: false,
        },
      },
    )
    expect(result.providerLatencyMs).toBe(0)
    expect(result.status).toBe('ok')
  })
})
