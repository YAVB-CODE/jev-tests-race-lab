import { describe, expect, it } from 'vitest'
import { latencyStats, mean, percentile, safeDiv } from './stats.ts'

describe('percentile (linear interpolation)', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('matches hand-computed values', () => {
    expect(percentile(sorted, 0)).toBe(1)
    expect(percentile(sorted, 50)).toBeCloseTo(5.5, 10)
    expect(percentile(sorted, 90)).toBeCloseTo(9.1, 10)
    expect(percentile(sorted, 95)).toBeCloseTo(9.55, 10)
    expect(percentile(sorted, 100)).toBe(10)
  })

  it('handles degenerate inputs', () => {
    expect(percentile([], 50)).toBe(0)
    expect(percentile([42], 95)).toBe(42)
    expect(percentile([1, 3], 50)).toBe(2)
    expect(percentile(sorted, -10)).toBe(1)
    expect(percentile(sorted, 150)).toBe(10)
  })
})

describe('latencyStats', () => {
  it('computes mean, percentiles, min, max and population stdDev', () => {
    const s = latencyStats([9, 2, 4, 4, 4, 5, 5, 7]) // unsorted on purpose
    expect(s.count).toBe(8)
    expect(s.mean).toBe(5)
    expect(s.stdDev).toBeCloseTo(2, 10)
    expect(s.min).toBe(2)
    expect(s.max).toBe(9)
    expect(s.p50).toBe(4.5)
    // sorted: 2 4 4 4 5 5 7 9 → p90 rank 6.3 → 7 + 0.3 * 2 = 7.6; p95 rank 6.65 → 7 + 0.65 * 2 = 8.3
    expect(s.p90).toBeCloseTo(7.6, 10)
    expect(s.p95).toBeCloseTo(8.3, 10)
  })

  it('does not mutate its input', () => {
    const input = [3, 1, 2]
    latencyStats(input)
    expect(input).toEqual([3, 1, 2])
  })

  it('ignores non-finite values', () => {
    const s = latencyStats([100, Number.NaN, Number.POSITIVE_INFINITY, 300])
    expect(s.count).toBe(2)
    expect(s.mean).toBe(200)
  })

  it('returns zeros for empty input', () => {
    expect(latencyStats([])).toEqual({ count: 0, mean: 0, p50: 0, p90: 0, p95: 0, min: 0, max: 0, stdDev: 0 })
  })

  it('has zero spread for a single value', () => {
    const s = latencyStats([250])
    expect(s).toMatchObject({ count: 1, mean: 250, p50: 250, p95: 250, min: 250, max: 250, stdDev: 0 })
  })
})

describe('safeDiv / mean', () => {
  it('never returns NaN or Infinity', () => {
    expect(safeDiv(1, 0)).toBe(0)
    expect(safeDiv(0, 0)).toBe(0)
    expect(safeDiv(1, 0, -1)).toBe(-1)
    expect(safeDiv(6, 3)).toBe(2)
    expect(mean([])).toBe(0)
    expect(mean([1, 2, 3])).toBe(2)
  })
})
