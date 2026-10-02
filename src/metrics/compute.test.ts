import { describe, expect, it } from 'vitest'
import { computeMetrics, cumulativeHitRate, rollingHitRate } from './compute.ts'
import { makeRecord } from './__fixtures__/makeRecord.ts'
import { generateSampleLane, generateSampleLanes, truncateSampleLane } from './__fixtures__/sampleRecords.ts'

/** Recursively assert that every number in a value is finite (no NaN / Infinity). */
function expectAllFinite(value: unknown, path = 'metrics'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${value}`).toBe(true)
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => expectAllFinite(v, `${path}[${i}]`))
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) expectAllFinite(v, `${path}.${k}`)
  }
}

describe('computeMetrics — empty input', () => {
  it('returns zeros / nulls and never NaN or Infinity', () => {
    const m = computeMetrics([], null)
    expectAllFinite(m)
    expect(m.decisions).toBe(0)
    expect(m.hits + m.errors + m.partials).toBe(0)
    expect(m.hitRate).toBe(0)
    expect(m.errorRate).toBe(0)
    expect(m.moveAccuracy).toBeNull()
    expect(m.speedAccuracy).toBeNull()
    expect(m.junctionAccuracy).toBeNull()
    expect(m.latency.count).toBe(0)
    expect(m.providerLatency.count).toBe(0)
    expect(m.bestLapMs).toBeNull()
    expect(m.lapsCompleted).toBe(0)
    expect(m.costUsd).toBe(0)
    expect(m.costPerDecision).toBe(0)
    expect(m.costEstimated).toBe(false)
    expect(m.decisionsPerMinute).toBe(0)
    expect(m.time.thinkingShare).toBe(0)
    expect(m.calibration.count).toBe(0)
    expect(m.calibration.brier).toBeNull()
    expect(m.calibration.ece).toBeNull()
    expect(m.calibration.lowConfidenceRate).toBeNull()
    expect(m.calibration.bins).toHaveLength(10)
    expect(m.calibration.bins.every((b) => b.count === 0 && b.accuracy === null)).toBe(true)
  })

  it('handles a zero-length race snapshot without dividing by zero', () => {
    const { snapshot } = generateSampleLane({ engine: 'jev', count: 0 })
    const m = computeMetrics([], { ...snapshot, raceTimeMs: 0, thinkingTimeMs: 0 })
    expectAllFinite(m)
    expect(m.time.thinkingShare).toBe(0)
  })
})

describe('computeMetrics — counts and accuracies', () => {
  const records = [
    makeRecord({ index: 0, moveOutcome: 'optimal', speedOutcome: 'correct', isJunction: true }), // hit
    makeRecord({ index: 1, moveOutcome: 'optimal', speedOutcome: 'too_slow' }), // partial
    makeRecord({ index: 2, moveOutcome: 'optimal', speedOutcome: 'too_fast', isJunction: true }), // error (spin)
    makeRecord({ index: 3, moveOutcome: 'suboptimal', speedOutcome: 'correct', isJunction: true }), // partial
    makeRecord({ index: 4, moveOutcome: 'crash', speedOutcome: 'correct' }), // error
    makeRecord({ index: 5, moveOutcome: 'invalid', speedOutcome: 'not_graded' }), // error (invalid)
    makeRecord({ index: 6, moveOutcome: 'timeout', speedOutcome: 'not_graded' }), // error (timeout)
    makeRecord({ index: 7, moveOutcome: 'error', speedOutcome: 'not_graded' }), // error
  ]
  const m = computeMetrics(records, null)

  it('classifies hits, errors and partials', () => {
    expect(m.decisions).toBe(8)
    expect(m.hits).toBe(1)
    expect(m.errors).toBe(5)
    expect(m.partials).toBe(2)
    expect(m.hits + m.errors + m.partials).toBe(m.decisions)
    expect(m.hitRate).toBeCloseTo(1 / 8, 10)
    expect(m.errorRate).toBeCloseTo(5 / 8, 10)
    expect(m.partialRate).toBeCloseTo(2 / 8, 10)
  })

  it('computes move, speed and junction accuracy', () => {
    expect(m.moveOptimal).toBe(3)
    expect(m.moveAccuracy).toBeCloseTo(3 / 8, 10)
    // speed graded on 5 decisions (3 not_graded): correct = idx 0, 3, 4
    expect(m.speedGraded).toBe(5)
    expect(m.speedAccuracy).toBeCloseTo(3 / 5, 10)
    // junctions: idx 0 (optimal), 2 (optimal), 3 (suboptimal)
    expect(m.junctionDecisions).toBe(3)
    expect(m.junctionAccuracy).toBeCloseTo(2 / 3, 10)
  })

  it('counts invalid answers, timeouts, crashes and spins', () => {
    expect(m.invalidCount).toBe(1)
    expect(m.invalidRate).toBeCloseTo(1 / 8, 10)
    expect(m.timeouts).toBe(1)
    expect(m.crashes).toBe(1)
    expect(m.spins).toBe(1)
  })

  it('tallies every outcome', () => {
    expect(m.moveOutcomes).toEqual({ optimal: 3, suboptimal: 1, crash: 1, invalid: 1, timeout: 1, error: 1 })
    expect(m.speedOutcomes).toEqual({ correct: 3, too_slow: 1, too_fast: 1, not_graded: 3 })
  })

  it('reports null accuracy at junctions when none was met', () => {
    const only = computeMetrics([makeRecord({ moveOutcome: 'optimal' })], null)
    expect(only.junctionAccuracy).toBeNull()
    expect(only.moveAccuracy).toBe(1)
  })
})

describe('computeMetrics — latency, time, cost', () => {
  it('computes end-to-end and provider latency separately', () => {
    const m = computeMetrics(
      [
        makeRecord({ index: 0, latencyMs: 100, providerLatencyMs: 80 }),
        makeRecord({ index: 1, latencyMs: 200, providerLatencyMs: 150 }),
        makeRecord({ index: 2, latencyMs: 300 }), // no provider latency
      ],
      null,
    )
    expect(m.latency.count).toBe(3)
    expect(m.latency.mean).toBe(200)
    expect(m.latency.p50).toBe(200)
    expect(m.providerLatency.count).toBe(2)
    expect(m.providerLatency.mean).toBe(115)
  })

  it('reads the time breakdown, laps and best lap from the snapshot', () => {
    const { records, snapshot } = generateSampleLane({ engine: 'jev', count: 60, decisionsPerLap: 20 })
    const m = computeMetrics(records, snapshot)
    expect(m.time.raceMs).toBe(snapshot.raceTimeMs)
    expect(m.time.movingMs + m.time.thinkingMs + m.time.penaltyMs).toBeCloseTo(m.time.raceMs, -1)
    expect(m.time.thinkingShare).toBeCloseTo(snapshot.thinkingTimeMs / snapshot.raceTimeMs, 10)
    expect(m.lapsCompleted).toBe(3)
    expect(m.lapTimesMs).toHaveLength(3)
    expect(m.bestLapMs).toBe(Math.min(...snapshot.lapTimesMs))
    expect(m.decisionsPerMinute).toBeCloseTo(60 / (snapshot.raceTimeMs / 60_000), 8)
  })

  it('approximates throughput without a snapshot', () => {
    const m = computeMetrics(
      [
        makeRecord({ index: 0, latencyMs: 500, raceTimeAtStartMs: 0 }),
        makeRecord({ index: 1, latencyMs: 500, raceTimeAtStartMs: 29_500 }),
      ],
      null,
    )
    // last decision ends at 30 s → 2 decisions in 0.5 min = 4 / min
    expect(m.decisionsPerMinute).toBeCloseTo(4, 10)
  })

  it('sums tokens and cost and flags estimates', () => {
    const m = computeMetrics(
      [
        makeRecord({ index: 0, tokens: [1000, 50], costUsd: 0.001, estimated: true }),
        makeRecord({ index: 1, tokens: [500, 25], costUsd: 0.0005 }),
        makeRecord({ index: 2 }), // no usage at all
      ],
      null,
    )
    expect(m.tokensIn).toBe(1500)
    expect(m.tokensOut).toBe(75)
    expect(m.costUsd).toBeCloseTo(0.0015, 10)
    expect(m.costPerDecision).toBeCloseTo(0.0005, 10)
    expect(m.costEstimated).toBe(true)
    expect(computeMetrics([makeRecord({ costUsd: 0.1 })], null).costEstimated).toBe(false)
  })
})

describe('computeMetrics — calibration (hand-computed example)', () => {
  // confidence → outcome. "optimal" counts as right; everything else as wrong.
  const spec: Array<[number, 'optimal' | 'crash' | 'suboptimal']> = [
    [0.9, 'optimal'],
    [0.9, 'optimal'],
    [0.9, 'crash'],
    [0.7, 'optimal'],
    [0.7, 'suboptimal'],
    [0.3, 'crash'],
    [0.1, 'crash'],
    [1.0, 'optimal'],
  ]
  const records = spec.map(([confidence, moveOutcome], index) => makeRecord({ index, confidence, moveOutcome }))
  // A record without confidence must be ignored entirely.
  records.push(makeRecord({ index: 8, moveOutcome: 'crash' }))
  const cal = computeMetrics(records, null).calibration

  it('Brier = mean((confidence − correct)²)', () => {
    // (0.1² + 0.1² + 0.9² + 0.3² + 0.7² + 0.3² + 0.1² + 0²) / 8 = 1.51 / 8
    expect(cal.count).toBe(8)
    expect(cal.brier).toBeCloseTo(0.18875, 10)
  })

  it('ECE over 10 equal-width bins', () => {
    // bin 0.9–1.0: n=4, conf 0.925, acc 0.75 → |Δ| 0.175 · 4/8 = 0.0875
    // bin 0.7–0.8: n=2, conf 0.7,   acc 0.5  → |Δ| 0.2   · 2/8 = 0.05
    // bin 0.3–0.4: n=1, conf 0.3,   acc 0    → |Δ| 0.3   · 1/8 = 0.0375
    // bin 0.1–0.2: n=1, conf 0.1,   acc 0    → |Δ| 0.1   · 1/8 = 0.0125
    expect(cal.ece).toBeCloseTo(0.1875, 10)
  })

  it('builds the reliability bins', () => {
    expect(cal.bins).toHaveLength(10)
    expect(cal.bins.reduce((s, b) => s + b.count, 0)).toBe(8)
    const b9 = cal.bins[9]
    expect(b9).toMatchObject({ lo: 0.9, hi: 1, count: 4 })
    expect(b9.avgConfidence).toBeCloseTo(0.925, 10)
    expect(b9.accuracy).toBeCloseTo(0.75, 10)
    expect(cal.bins[7]).toMatchObject({ count: 2, accuracy: 0.5 })
    expect(cal.bins[7].avgConfidence).toBeCloseTo(0.7, 10)
    expect(cal.bins[3]).toMatchObject({ count: 1, accuracy: 0 })
    expect(cal.bins[1]).toMatchObject({ count: 1, accuracy: 0 })
    expect(cal.bins[0]).toMatchObject({ count: 0, avgConfidence: null, accuracy: null })
  })

  it('confidence when right vs wrong, overall, and low-confidence share', () => {
    expect(cal.avgConfidenceWhenRight).toBeCloseTo(0.875, 10) // (0.9 + 0.9 + 0.7 + 1.0) / 4
    expect(cal.avgConfidenceWhenWrong).toBeCloseTo(0.5, 10) // (0.9 + 0.7 + 0.3 + 0.1) / 4
    expect(cal.avgConfidence).toBeCloseTo(0.6875, 10)
    expect(cal.lowConfidenceRate).toBeCloseTo(0.25, 10) // 0.3 and 0.1
  })

  it('a perfectly calibrated, always-right-at-1.0 engine scores 0', () => {
    const perfect = computeMetrics([makeRecord({ confidence: 1 }), makeRecord({ index: 1, confidence: 1 })], null).calibration
    expect(perfect.brier).toBe(0)
    expect(perfect.ece).toBe(0)
    expect(perfect.avgConfidenceWhenWrong).toBeNull()
  })

  it('clamps out-of-range confidences', () => {
    const c = computeMetrics([makeRecord({ confidence: 1.7 }), makeRecord({ index: 1, confidence: -0.2, moveOutcome: 'crash' })], null).calibration
    expect(c.brier).toBe(0)
    expect(c.bins[9].count).toBe(1)
    expect(c.bins[0].count).toBe(1)
  })
})

describe('hit-rate series', () => {
  const hit = (i: number, ok: boolean) => makeRecord({ index: i, moveOutcome: ok ? 'optimal' : 'crash' })
  const records = [hit(0, true), hit(1, false), hit(2, true), hit(3, true), hit(4, false)]

  it('cumulative hit rate', () => {
    expect(cumulativeHitRate(records)).toEqual([
      { n: 1, value: 1 },
      { n: 2, value: 0.5 },
      { n: 3, value: 2 / 3 },
      { n: 4, value: 0.75 },
      { n: 5, value: 0.6 },
    ])
  })

  it('rolling hit rate uses a sliding window (partial at the start)', () => {
    const r = rollingHitRate(records, 3)
    expect(r.map((p) => p.n)).toEqual([1, 2, 3, 4, 5])
    expect(r[0].value).toBe(1)
    expect(r[1].value).toBe(0.5)
    expect(r[2].value).toBeCloseTo(2 / 3, 10) // T F T
    expect(r[3].value).toBeCloseTo(2 / 3, 10) // F T T
    expect(r[4].value).toBeCloseTo(2 / 3, 10) // T T F
  })

  it('handles empty input and invalid windows', () => {
    expect(rollingHitRate([], 5)).toEqual([])
    expect(cumulativeHitRate([])).toEqual([])
    expect(rollingHitRate(records, 0).map((p) => p.value)).toEqual([1, 0, 1, 1, 0])
    expectAllFinite(rollingHitRate(records, Number.NaN))
  })
})

describe('sample fixtures', () => {
  it('are deterministic for a seed', () => {
    const a = generateSampleLane({ engine: 'gpt', count: 30, seed: 3 })
    const b = generateSampleLane({ engine: 'gpt', count: 30, seed: 3 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const c = generateSampleLane({ engine: 'gpt', count: 30, seed: 4 })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c))
  })

  it('produce internally consistent, finite metrics', () => {
    const lanes = generateSampleLanes({ count: 120, seed: 11 })
    for (const lane of [lanes.gpt, lanes.jev]) {
      const m = computeMetrics(lane.records, lane.snapshot)
      expectAllFinite(m)
      expect(m.decisions).toBe(120)
      expect(m.hits + m.errors + m.partials).toBe(120)
      expect(Object.values(m.moveOutcomes).reduce((a, b) => a + b, 0)).toBe(120)
      expect(Object.values(m.speedOutcomes).reduce((a, b) => a + b, 0)).toBe(120)
      expect(m.calibration.bins.reduce((s, b) => s + b.count, 0)).toBe(m.calibration.count)
      expect(m.hitRate).toBeGreaterThan(0)
      expect(m.hitRate).toBeLessThan(1)
    }
    // illustrative profiles: Jev is faster and more accurate
    const g = computeMetrics(lanes.gpt.records, lanes.gpt.snapshot)
    const j = computeMetrics(lanes.jev.records, lanes.jev.snapshot)
    expect(j.latency.p50).toBeLessThan(g.latency.p50)
    expect(j.hitRate).toBeGreaterThan(g.hitRate)
  })

  it('truncate to a mid-race lane', () => {
    const lanes = generateSampleLanes({ count: 40, seed: 5 })
    const mid = truncateSampleLane(lanes.jev, 10)
    expect(mid.records).toHaveLength(10)
    expect(mid.snapshot?.decisions).toBe(10)
    expect(computeMetrics(mid.records, mid.snapshot).decisions).toBe(10)
  })
})
