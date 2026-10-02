/** Small, dependency-free statistics helpers. Every function is total: empty input never yields NaN / Infinity. */

export interface LatencyStats {
  count: number
  mean: number
  p50: number
  p90: number
  p95: number
  min: number
  max: number
  /** Population standard deviation. */
  stdDev: number
}

export const EMPTY_LATENCY: LatencyStats = Object.freeze({
  count: 0,
  mean: 0,
  p50: 0,
  p90: 0,
  p95: 0,
  min: 0,
  max: 0,
  stdDev: 0,
})

/** Safe division: returns `fallback` when the denominator is 0 or the result is not finite. */
export function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (denominator === 0) return fallback
  const v = numerator / denominator
  return Number.isFinite(v) ? v : fallback
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/**
 * Percentile of an ASCENDING-sorted array using linear interpolation between closest ranks
 * (the "type 7" definition used by NumPy / Excel PERCENTILE.INC). `p` is in [0, 100].
 */
export function percentile(sorted: readonly number[], p: number): number {
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return sorted[0]
  const clamped = Math.min(100, Math.max(0, p))
  const rank = (clamped / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

/** Count, mean, p50 / p90 / p95, min, max and population standard deviation. Non-finite values are ignored. */
export function latencyStats(values: readonly number[]): LatencyStats {
  const clean = values.filter((v) => Number.isFinite(v))
  if (clean.length === 0) return { ...EMPTY_LATENCY }
  const sorted = [...clean].sort((a, b) => a - b)
  const avg = mean(sorted)
  let sq = 0
  for (const v of sorted) sq += (v - avg) ** 2
  return {
    count: sorted.length,
    mean: avg,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdDev: Math.sqrt(sq / sorted.length),
  }
}
