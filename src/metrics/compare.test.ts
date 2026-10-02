import { describe, expect, it } from 'vitest'
import { compareHeadline, compareLanes } from './compare.ts'
import type { ComparisonRow } from './compare.ts'
import { computeMetrics } from './compute.ts'
import type { EngineMetrics } from './compute.ts'
import { latencyStats } from './stats.ts'
import { generateSampleLanes } from './__fixtures__/sampleRecords.ts'

const EMPTY = computeMetrics([], null)

/** Build metrics by overriding a few fields of the empty baseline. */
function metrics(over: Partial<EngineMetrics> & { p50?: number; p95?: number }): EngineMetrics {
  const { p50, p95, ...rest } = over
  const base: EngineMetrics = { ...EMPTY, decisions: 50, ...rest }
  if (p50 !== undefined || p95 !== undefined) {
    base.latency = { ...latencyStats([p50 ?? 1, p95 ?? p50 ?? 1]), count: 50, p50: p50 ?? 0, p95: p95 ?? p50 ?? 0, mean: p50 ?? 0 }
  }
  return base
}

const row = (rows: ComparisonRow[], key: string): ComparisonRow => {
  const r = rows.find((x) => x.key === key)
  if (!r) throw new Error(`missing row ${key}`)
  return r
}

describe('compareLanes — "lower is better" semantics', () => {
  it('latency: lower wins, reported as a factor', () => {
    const rows = compareLanes(metrics({ p50: 1200, p95: 2400 }), metrics({ p50: 190, p95: 400 }))
    const p50 = row(rows, 'latencyP50')
    expect(p50.better).toBe('jev')
    expect(p50.lowerIsBetter).toBe(true)
    expect(p50.deltaText).toBe('6.3× más rápido')
    expect(p50.gptText).toBe('1.20 s')
    expect(p50.jevText).toBe('190 ms')
    expect(row(rows, 'latencyP95').better).toBe('jev')
  })

  it('latency: GPT wins when it is faster', () => {
    const rows = compareLanes(metrics({ p50: 100 }), metrics({ p50: 300 }))
    expect(row(rows, 'latencyP50').better).toBe('gpt')
    expect(row(rows, 'latencyP50').deltaText).toBe('3.0× más rápido')
  })

  it('error rate and invalid rate: lower wins, in percentage points', () => {
    const rows = compareLanes(metrics({ errorRate: 0.2, errors: 10, invalidRate: 0.04 }), metrics({ errorRate: 0.1, errors: 5, invalidRate: 0 }))
    const err = row(rows, 'errorRate')
    expect(err.better).toBe('jev')
    expect(err.deltaText).toBe('−10.0 pp')
    expect(err.gptText).toBe('20.0% · 10/50')
    expect(row(rows, 'invalidRate').better).toBe('jev')
  })

  it('hit rate and accuracies: higher wins', () => {
    const rows = compareLanes(
      metrics({ hitRate: 0.8, hits: 40, moveAccuracy: 0.9, speedAccuracy: 0.7, junctionAccuracy: 0.5 }),
      metrics({ hitRate: 0.6, hits: 30, moveAccuracy: 0.85, speedAccuracy: 0.9, junctionAccuracy: 0.5 }),
    )
    expect(row(rows, 'hitRate').better).toBe('gpt')
    expect(row(rows, 'hitRate').deltaText).toBe('+20.0 pp')
    expect(row(rows, 'moveAccuracy').better).toBe('gpt')
    expect(row(rows, 'speedAccuracy').better).toBe('jev')
    expect(row(rows, 'junctionAccuracy').better).toBe('tie')
    expect(row(rows, 'junctionAccuracy').deltaText).toBe('')
  })

  it('cost: cheaper wins', () => {
    const rows = compareLanes(metrics({ costUsd: 0.05, costPerDecision: 0.001 }), metrics({ costUsd: 0.01, costPerDecision: 0.0002 }))
    expect(row(rows, 'costPerDecision').better).toBe('jev')
    expect(row(rows, 'costPerDecision').deltaText).toBe('5.0× más barato')
    expect(row(rows, 'costTotal').better).toBe('jev')
  })

  it('race time and best lap: lower wins; thinking share: lower wins', () => {
    const rows = compareLanes(
      metrics({ time: { raceMs: 90_000, movingMs: 40_000, thinkingMs: 40_000, penaltyMs: 10_000, thinkingShare: 0.44 }, bestLapMs: 30_000 }),
      metrics({ time: { raceMs: 60_000, movingMs: 40_000, thinkingMs: 10_000, penaltyMs: 10_000, thinkingShare: 0.17 }, bestLapMs: 20_000 }),
    )
    expect(row(rows, 'raceTime').better).toBe('jev')
    expect(row(rows, 'raceTime').deltaText).toBe('1.5× más rápido')
    expect(row(rows, 'bestLap').better).toBe('jev')
    expect(row(rows, 'thinkingShare').better).toBe('jev')
  })

  it('Brier and ECE: lower wins', () => {
    const cal = (brier: number, ece: number) => ({ ...EMPTY.calibration, count: 50, brier, ece })
    const rows = compareLanes(metrics({ calibration: cal(0.2, 0.15) }), metrics({ calibration: cal(0.08, 0.04) }))
    expect(row(rows, 'brier').better).toBe('jev')
    expect(row(rows, 'brier').deltaText).toBe('−0.120')
    expect(row(rows, 'ece').better).toBe('jev')
    expect(row(rows, 'ece').lowerIsBetter).toBe(true)
  })

  it('throughput and laps: higher wins', () => {
    const rows = compareLanes(metrics({ decisionsPerMinute: 20, lapsCompleted: 2 }), metrics({ decisionsPerMinute: 60, lapsCompleted: 3 }))
    expect(row(rows, 'decisionsPerMinute').better).toBe('jev')
    expect(row(rows, 'decisionsPerMinute').deltaText).toBe('3.0× más decisiones/min')
    expect(row(rows, 'lapsCompleted').better).toBe('jev')
    expect(row(rows, 'lapsCompleted').deltaText).toBe('+1')
  })
})

describe('compareLanes — ties and missing data', () => {
  it('identical values tie; near-identical latency ties', () => {
    const rows = compareLanes(metrics({ p50: 200, hitRate: 0.5 }), metrics({ p50: 203, hitRate: 0.5 }))
    expect(row(rows, 'latencyP50').better).toBe('tie')
    expect(row(rows, 'hitRate').better).toBe('tie')
  })

  it('empty lanes: nothing is comparable and nothing is NaN', () => {
    const rows = compareLanes(EMPTY, EMPTY)
    for (const r of rows) {
      expect(r.better).toBeNull()
      expect(r.deltaText).toBe('')
      expect(r.gptText).not.toMatch(/NaN|Infinity/)
      expect(r.jevText).not.toMatch(/NaN|Infinity/)
    }
  })

  it('a lane without data never wins', () => {
    const rows = compareLanes(EMPTY, metrics({ p50: 200, hitRate: 0.5 }))
    expect(row(rows, 'latencyP50').better).toBeNull()
    expect(row(rows, 'hitRate').better).toBeNull()
  })

  it('totals are not compared while the lanes are at different points of the race', () => {
    const a = metrics({ decisions: 30, costUsd: 0.01, time: { ...EMPTY.time, raceMs: 30_000 } })
    const b = metrics({ decisions: 50, costUsd: 0.02, time: { ...EMPTY.time, raceMs: 60_000 } })
    const rows = compareLanes(a, b)
    expect(row(rows, 'raceTime').better).toBeNull()
    expect(row(rows, 'costTotal').better).toBeNull()
  })

  it('informational rows never declare a winner', () => {
    const rows = compareLanes(
      metrics({ tokensIn: 1000, tokensOut: 100 }),
      metrics({ tokensIn: 500, tokensOut: 10, calibration: { ...EMPTY.calibration, lowConfidenceRate: 0.2 } }),
    )
    expect(row(rows, 'tokens').better).toBeNull()
    expect(row(rows, 'tokens').lowerIsBetter).toBeNull()
    expect(row(rows, 'lowConfidenceRate').better).toBeNull()
  })

  it('cost winner at zero cost does not divide by zero', () => {
    const rows = compareLanes(metrics({ costPerDecision: 0.001 }), metrics({ costPerDecision: 0 }))
    const r = row(rows, 'costPerDecision')
    expect(r.better).toBe('jev')
    expect(r.deltaText).not.toMatch(/NaN|Infinity/)
  })
})

describe('compareHeadline', () => {
  it('Jev faster and more accurate', () => {
    const rows = compareLanes(metrics({ p50: 1200, hitRate: 0.6, hits: 30 }), metrics({ p50: 190, hitRate: 0.64, hits: 32 }))
    expect(compareHeadline(rows)).toBe('Jev decide 6.3× más rápido con +4.0 pp de aciertos')
  })

  it('faster but less accurate', () => {
    const rows = compareLanes(metrics({ p50: 1200, hitRate: 0.7 }), metrics({ p50: 190, hitRate: 0.6 }))
    expect(compareHeadline(rows)).toBe('Jev decide 6.3× más rápido, pero GPT acierta +10.0 pp más')
  })

  it('tied accuracy and tied speed', () => {
    expect(compareHeadline(compareLanes(metrics({ p50: 1200, hitRate: 0.6 }), metrics({ p50: 190, hitRate: 0.6 })))).toBe(
      'Jev decide 6.3× más rápido y con aciertos equivalentes',
    )
  })

  it('no data', () => {
    expect(compareHeadline(compareLanes(EMPTY, EMPTY))).toBe('Aún no hay decisiones suficientes para comparar.')
  })

  it('works end to end on the sample fixtures', () => {
    const lanes = generateSampleLanes({ count: 100, seed: 21 })
    const rows = compareLanes(computeMetrics(lanes.gpt.records, lanes.gpt.snapshot), computeMetrics(lanes.jev.records, lanes.jev.snapshot))
    expect(compareHeadline(rows)).toMatch(/^Jev decide \d+\.\d× más rápido con \+\d+\.\d pp de aciertos$/)
    expect(row(rows, 'errorRate').better).toBe('jev')
    expect(row(rows, 'brier').better).toBe('jev')
    expect(row(rows, 'ece').better).toBe('jev')
    expect(row(rows, 'costPerDecision').better).toBe('jev')
  })
})
