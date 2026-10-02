import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionResult, Difficulty, OracleAnswer } from '../shared/contracts.ts'
import { RELATIVE_MOVES, SPEED_MODES } from '../shared/contracts.ts'
import { createRng } from '../shared/rng.ts'
import { MockEngine, sampleLatencyMs } from './MockEngine.ts'
import { MOCK_PROFILES } from './profiles.ts'
import { JUNCTION_ORACLE, STRAIGHT_ORACLE, ZERO_LATENCY, makeCtx, makeObservation } from './testFixtures.ts'

const N = 3000

async function run(
  engine: MockEngine,
  oracle: OracleAnswer,
  difficulty: Difficulty,
  count: number,
  seed = 7,
): Promise<DecisionResult[]> {
  const ctx = makeCtx(oracle, seed)
  const results: DecisionResult[] = []
  for (let i = 0; i < count; i++) results.push(await engine.decide(makeObservation(difficulty, i), ctx))
  return results
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

afterEach(() => {
  vi.useRealTimers()
})

describe('MockEngine basics', () => {
  it('identifies itself as a mock with Spanish labels', () => {
    const gpt = new MockEngine('gpt')
    const jev = new MockEngine('jev')
    expect(gpt.mode).toBe('mock')
    expect(gpt.label).toBe('GPT · simulado')
    expect(jev.label).toBe('Jev · simulado')
  })

  it('is deterministic for the same seed and different for another', async () => {
    const a = await run(new MockEngine('gpt', { profile: ZERO_LATENCY }), JUNCTION_ORACLE, 'hard', 200, 42)
    const b = await run(new MockEngine('gpt', { profile: ZERO_LATENCY }), JUNCTION_ORACLE, 'hard', 200, 42)
    const c = await run(new MockEngine('gpt', { profile: ZERO_LATENCY }), JUNCTION_ORACLE, 'hard', 200, 43)
    expect(b).toEqual(a)
    expect(c).not.toEqual(a)
  })

  it('consumes a fixed number of random draws per decision', async () => {
    const draws = new Set<number>()
    for (const oracle of [STRAIGHT_ORACLE, JUNCTION_ORACLE]) {
      for (const id of ['gpt', 'jev'] as const) {
        for (let seed = 0; seed < 40; seed++) {
          const rng = createRng(seed)
          let count = 0
          const counted = () => {
            count++
            return rng()
          }
          const engine = new MockEngine(id, { profile: ZERO_LATENCY })
          const ctx = { ...makeCtx(oracle, seed), random: counted }
          await engine.decide(makeObservation('hard'), ctx)
          draws.add(count)
        }
      }
    }
    expect(draws.size).toBe(1)
  })

  it('fills usage, estimated cost, provider latency and raw payloads', async () => {
    const engine = new MockEngine('gpt', {
      profile: { ...ZERO_LATENCY, invalidRate: 0, transientErrorRate: 0 },
    })
    const obs = makeObservation('easy')
    const result = await engine.decide(obs, makeCtx(STRAIGHT_ORACLE, 3))
    const p = MOCK_PROFILES.gpt
    const expectedIn = Math.ceil(JSON.stringify(obs).length / 4) + p.promptOverheadTokens
    expect(result.status).toBe('ok')
    expect(result.engine).toBe('gpt')
    expect(result.mode).toBe('mock')
    expect(result.model).toBe('mock-gpt')
    expect(result.estimated).toBe(true)
    expect(result.providerLatencyMs).toBe(0)
    expect(result.usage).toEqual({ inputTokens: expectedIn, outputTokens: p.outputTokens })
    expect(result.costUsd).toBeCloseTo((expectedIn * 0.4 + p.outputTokens * 1.6) / 1e6, 12)
    expect(result.raw).toMatchObject({ request: { observation: obs }, response: { simulated: true } })
  })

  it('prices Jev output as free', async () => {
    const engine = new MockEngine('jev', { profile: { ...ZERO_LATENCY, transientErrorRate: 0 } })
    const obs = makeObservation('normal')
    const result = await engine.decide(obs, makeCtx(STRAIGHT_ORACLE, 5))
    const inputTokens = Math.ceil(JSON.stringify(obs).length / 4) + MOCK_PROFILES.jev.promptOverheadTokens
    expect(result.costUsd).toBeCloseTo((inputTokens * 0.042) / 1e6, 12)
  })

  it('merges partial nested profile overrides without losing the other keys', () => {
    const engine = new MockEngine('jev', { profile: { latency: { medianMs: 10 }, moveErrorRate: { junction: { hard: 0.5 } } } })
    expect(engine.profile.latency.medianMs).toBe(10)
    expect(engine.profile.latency.maxMs).toBe(500)
    expect(engine.profile.moveErrorRate.junction.hard).toBe(0.5)
    expect(engine.profile.moveErrorRate.junction.easy).toBe(MOCK_PROFILES.jev.moveErrorRate.junction.easy)
    // the shared defaults are not mutated
    expect(MOCK_PROFILES.jev.latency.medianMs).toBe(180)
  })
})

describe('MockEngine latency', () => {
  it('waits the sampled latency (clamped to the profile) before resolving', async () => {
    vi.useFakeTimers()
    const engine = new MockEngine('jev', { profile: { transientErrorRate: 0 } })
    const ctx = makeCtx(STRAIGHT_ORACLE, 11)
    let done = false
    const promise = engine.decide(makeObservation(), ctx).then((r) => {
      done = true
      return r
    })
    await vi.advanceTimersByTimeAsync(60)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    const result = await promise
    expect(result.providerLatencyMs).toBeGreaterThanOrEqual(70)
    expect(result.providerLatencyMs).toBeLessThanOrEqual(500)
  })

  it('samples Jev within 70–500 ms and GPT with a median near 900 ms and occasional multi-second spikes', () => {
    const latencies = (id: 'gpt' | 'jev') => {
      const rng = createRng(99)
      return Array.from({ length: N }, () => sampleLatencyMs(MOCK_PROFILES[id].latency, rng))
    }
    const jev = latencies('jev')
    expect(Math.min(...jev)).toBeGreaterThanOrEqual(70)
    expect(Math.max(...jev)).toBeLessThanOrEqual(500)
    const gpt = latencies('gpt').sort((a, b) => a - b)
    const median = gpt[Math.floor(gpt.length / 2)]
    expect(median).toBeGreaterThan(750)
    expect(median).toBeLessThan(1050)
    expect(gpt.some((ms) => ms >= 3000 && ms <= 6700)).toBe(true)
  })
})

describe('MockEngine error injection', () => {
  it('matches the profile move-error rate (non-junction, junction)', async () => {
    const clean = { ...ZERO_LATENCY, invalidRate: 0, transientErrorRate: 0 }
    for (const oracle of [STRAIGHT_ORACLE, JUNCTION_ORACLE]) {
      const difficulty: Difficulty = oracle.isJunction ? 'normal' : 'hard'
      for (const id of ['gpt', 'jev'] as const) {
        const engine = new MockEngine(id, { profile: clean })
        const rate = MOCK_PROFILES[id].moveErrorRate[oracle.isJunction ? 'junction' : 'nonJunction'][difficulty]
        const results = await run(engine, oracle, difficulty, N, 1234)
        const wrong = results.filter((r) => r.answer.move !== oracle.bestMove).length / N
        expect(Math.abs(wrong - rate)).toBeLessThan(0.03)
      }
    }
  })

  it('crashes (invalid move) off junctions and picks a valid suboptimal move at junctions', async () => {
    const forceWrong = { ...ZERO_LATENCY, invalidRate: 0, transientErrorRate: 0 }
    const alwaysWrong = {
      ...forceWrong,
      moveErrorRate: {
        nonJunction: { easy: 1, normal: 1, hard: 1 },
        junction: { easy: 1, normal: 1, hard: 1 },
      },
      confidenceModel: 'overconfident' as const,
    }
    const engine = new MockEngine('gpt', { profile: alwaysWrong })
    const straight = await run(engine, STRAIGHT_ORACLE, 'easy', 100)
    for (const r of straight) {
      expect(r.answer.move).not.toBeNull()
      expect(STRAIGHT_ORACLE.validMoves).not.toContain(r.answer.move)
    }
    const junction = await run(engine, JUNCTION_ORACLE, 'easy', 100)
    for (const r of junction) expect(r.answer.move).toBe('left')
  })

  it('speed errors are adjacent to the ideal speed of the chosen move', async () => {
    const alwaysWrongSpeed = {
      ...ZERO_LATENCY,
      invalidRate: 0,
      transientErrorRate: 0,
      confidenceModel: 'overconfident' as const,
      moveErrorRate: {
        nonJunction: { easy: 0, normal: 0, hard: 0 },
        junction: { easy: 0, normal: 0, hard: 0 },
      },
      speedErrorRate: { easy: 1, normal: 1, hard: 1 },
    }
    const engine = new MockEngine('gpt', { profile: alwaysWrongSpeed })
    const seen = new Set<string>()
    for (const r of await run(engine, STRAIGHT_ORACLE, 'easy', 100)) {
      expect(r.answer.move).toBe('forward')
      expect(r.answer.speed).toBe('cruise') // ideal is boost: the only adjacent speed is cruise
      seen.add(String(r.answer.speed))
    }
    for (const r of await run(engine, JUNCTION_ORACLE, 'easy', 200)) {
      expect(['slow', 'boost']).toContain(r.answer.speed) // ideal cruise: both neighbours
      seen.add(String(r.answer.speed))
    }
    expect(seen).toEqual(new Set(['cruise', 'slow', 'boost']))
  })

  it('jev mock never returns invalid; gpt mock does at roughly its configured rate', async () => {
    const jev = await run(new MockEngine('jev', { profile: ZERO_LATENCY }), JUNCTION_ORACLE, 'hard', N, 5)
    expect(jev.some((r) => r.status === 'invalid')).toBe(false)
    expect(jev.every((r) => r.status === 'ok' || r.status === 'error')).toBe(true)

    const gpt = await run(new MockEngine('gpt', { profile: ZERO_LATENCY }), JUNCTION_ORACLE, 'hard', N, 5)
    const invalid = gpt.filter((r) => r.status === 'invalid')
    expect(invalid.length / N).toBeGreaterThan(0.005)
    expect(invalid.length / N).toBeLessThan(0.03)
    for (const r of invalid) {
      expect(r.answer.move).toBeNull()
      expect(r.answer.speed).toBeNull()
    }
  })

  it('transient errors resolve status "error" with a message and no answer', async () => {
    const engine = new MockEngine('gpt', { profile: { ...ZERO_LATENCY, transientErrorRate: 1 } })
    const result = await engine.decide(makeObservation(), makeCtx())
    expect(result.status).toBe('error')
    expect(result.errorMessage).toBeTruthy()
    expect(result.answer).toEqual({ move: null, speed: null })
  })
})

describe('MockEngine confidence', () => {
  it('calibrated: wrong answers carry lower confidence and mean confidence tracks accuracy', async () => {
    const engine = new MockEngine('jev', { profile: { ...ZERO_LATENCY, invalidRate: 0, transientErrorRate: 0 } })
    const results = await run(engine, JUNCTION_ORACLE, 'hard', N, 21)
    const right = results.filter((r) => r.answer.move === JUNCTION_ORACLE.bestMove)
    const wrong = results.filter((r) => r.answer.move !== JUNCTION_ORACLE.bestMove)
    expect(wrong.length).toBeGreaterThan(100)
    const confidence = (rs: DecisionResult[]) => mean(rs.map((r) => r.answer.moveConfidence ?? NaN))
    expect(confidence(wrong)).toBeLessThan(confidence(right) - 0.05)
    expect(Math.abs(confidence(results) - right.length / N)).toBeLessThan(0.03)

    // reliability: in each confidence bin the empirical accuracy is close to the bin's mean confidence
    for (const [lo, hi] of [[0.5, 0.75], [0.75, 0.9], [0.9, 1.01]] as const) {
      const bin = results.filter((r) => (r.answer.moveConfidence ?? 0) >= lo && (r.answer.moveConfidence ?? 0) < hi)
      if (bin.length < 50) continue
      const accuracy = bin.filter((r) => r.answer.move === JUNCTION_ORACLE.bestMove).length / bin.length
      expect(Math.abs(accuracy - confidence(bin))).toBeLessThan(0.08)
    }
  })

  it('calibrated: full distributions sum to 1, peak on the chosen option, native confidence formula', async () => {
    const engine = new MockEngine('jev', { profile: { ...ZERO_LATENCY, invalidRate: 0, transientErrorRate: 0 } })
    const results = await run(engine, JUNCTION_ORACLE, 'hard', 500, 8)
    for (const r of results) {
      const { move, speed, moveProbabilities, speedProbabilities, moveConfidence, speedConfidence } = r.answer
      expect(move).not.toBeNull()
      expect(speed).not.toBeNull()
      const moveSum = RELATIVE_MOVES.reduce((s, m) => s + (moveProbabilities?.[m] ?? 0), 0)
      const speedSum = SPEED_MODES.reduce((s, m) => s + (speedProbabilities?.[m] ?? 0), 0)
      expect(moveSum).toBeCloseTo(1, 9)
      expect(speedSum).toBeCloseTo(1, 9)
      expect(moveConfidence).toBe(moveProbabilities?.[move!])
      expect(speedConfidence).toBe(speedProbabilities?.[speed!])
      expect(Math.max(...RELATIVE_MOVES.map((m) => moveProbabilities?.[m] ?? 0))).toBe(moveConfidence)
      expect(r.answer.nativeMoveConfidence).toBeCloseTo((3 * moveConfidence! - 1) / 2, 3)
      expect(r.answer.nativeSpeedConfidence).toBeCloseTo((3 * speedConfidence! - 1) / 2, 3)
    }
  })

  it('overconfident: self-reported 0.88–0.99 regardless of correctness, no distribution', async () => {
    const engine = new MockEngine('gpt', { profile: { ...ZERO_LATENCY, invalidRate: 0, transientErrorRate: 0 } })
    const results = await run(engine, JUNCTION_ORACLE, 'hard', N, 31)
    const right = results.filter((r) => r.answer.move === JUNCTION_ORACLE.bestMove)
    const wrong = results.filter((r) => r.answer.move !== JUNCTION_ORACLE.bestMove)
    expect(wrong.length).toBeGreaterThan(300)
    for (const r of results) {
      expect(r.answer.moveConfidence).toBeGreaterThanOrEqual(0.88)
      expect(r.answer.moveConfidence).toBeLessThanOrEqual(0.99)
      expect(r.answer.moveProbabilities).toBeUndefined()
      expect(r.answer.speedProbabilities).toBeUndefined()
      expect(r.answer.nativeMoveConfidence).toBeUndefined()
    }
    const confidence = (rs: DecisionResult[]) => mean(rs.map((r) => r.answer.moveConfidence ?? NaN))
    expect(Math.abs(confidence(right) - confidence(wrong))).toBeLessThan(0.01)
  })
})

describe('MockEngine abort handling', () => {
  it('rejects immediately with an AbortError when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const engine = new MockEngine('gpt')
    await expect(engine.decide(makeObservation(), makeCtx(STRAIGHT_ORACLE, 1, controller.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('rejects promptly with an AbortError and clears the timer when aborted mid-wait', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const engine = new MockEngine('gpt', { profile: { latency: { minMs: 5000, maxMs: 5000 } } })
    const promise = engine.decide(makeObservation(), makeCtx(STRAIGHT_ORACLE, 1, controller.signal))
    const assertion = expect(promise).rejects.toBeInstanceOf(DOMException)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    await assertion
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes its abort listener once it resolves', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const engine = new MockEngine('jev', { profile: { transientErrorRate: 0 } })
    const promise = engine.decide(makeObservation(), makeCtx(STRAIGHT_ORACLE, 2, controller.signal))
    await vi.advanceTimersByTimeAsync(600)
    await promise
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
