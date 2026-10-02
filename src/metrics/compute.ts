/**
 * Pure metrics engine: DecisionRecord[] (+ the lane snapshot) → EngineMetrics.
 * No React, no DOM, no clock — safe to call on every streamed record and to unit test.
 *
 * Conventions
 *  - Empty / degenerate input never produces NaN or Infinity.
 *  - Rates are fractions in [0, 1] (the UI formats them as %).
 *  - A metric whose denominator can legitimately be empty while the lane already has decisions
 *    (e.g. accuracy at junctions when none was met yet) is `null`, so "no data" is distinguishable from 0 %.
 */
import type { DecisionRecord, LaneSnapshot, MoveOutcome, SpeedOutcome } from '../shared/contracts.ts'
import { latencyStats, safeDiv } from './stats.ts'
import type { LatencyStats } from './stats.ts'

export const MOVE_OUTCOMES: readonly MoveOutcome[] = ['optimal', 'suboptimal', 'crash', 'invalid', 'timeout', 'error']
export const SPEED_OUTCOMES: readonly SpeedOutcome[] = ['correct', 'too_slow', 'too_fast', 'not_graded']

export const CALIBRATION_BINS = 10
/** moveConfidence below this value counts as a "low confidence" decision. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5

// ───────────────────────────────── Types ─────────────────────────────────

export interface ReliabilityBin {
  lo: number
  hi: number
  count: number
  /** Mean stated confidence in the bin (null when the bin is empty). */
  avgConfidence: number | null
  /** Share of optimal moves in the bin (null when the bin is empty). */
  accuracy: number | null
}

export interface CalibrationMetrics {
  /** Decisions that carry `answer.moveConfidence`. */
  count: number
  /** Mean squared error between stated confidence and correctness (0 = perfect, 0.25 = coin flip). null without data. */
  brier: number | null
  /** Expected calibration error over 10 equal-width bins (0 = perfectly calibrated). null without data. */
  ece: number | null
  bins: ReliabilityBin[]
  avgConfidence: number | null
  avgConfidenceWhenRight: number | null
  avgConfidenceWhenWrong: number | null
  /** Share of calibrated decisions with moveConfidence < 0.5. null without data. */
  lowConfidenceRate: number | null
}

export interface TimeBreakdown {
  raceMs: number
  movingMs: number
  thinkingMs: number
  penaltyMs: number
  /** thinkingMs / raceMs (0..1). */
  thinkingShare: number
}

export interface EngineMetrics {
  /** Graded decisions. */
  decisions: number

  /** Acierto: optimal move AND correct speed. */
  hits: number
  /** Error: crash / invalid / timeout / error move, or too_fast speed. */
  errors: number
  /** Neither hit nor error (e.g. suboptimal move, or a too_slow speed). */
  partials: number
  hitRate: number
  errorRate: number
  partialRate: number

  /** Optimal moves / all decisions (a missing or invalid answer is a miss). */
  moveAccuracy: number | null
  moveOptimal: number
  /** Correct speeds / decisions whose speed was graded. */
  speedAccuracy: number | null
  speedGraded: number
  speedCorrect: number
  /** Optimal moves / decisions taken at a junction (oracle.isJunction). */
  junctionAccuracy: number | null
  junctionDecisions: number
  junctionOptimal: number

  /** status === 'invalid' (or move graded as invalid): unparseable / out-of-set answers. */
  invalidCount: number
  invalidRate: number
  timeouts: number
  crashes: number
  /** Spin-outs (speedOutcome === 'too_fast'). */
  spins: number

  moveOutcomes: Record<MoveOutcome, number>
  speedOutcomes: Record<SpeedOutcome, number>

  /** End-to-end latency measured by the runner (record.latencyMs). */
  latency: LatencyStats
  /** Upstream latency reported by the engine / server (result.providerLatencyMs). */
  providerLatency: LatencyStats

  time: TimeBreakdown
  lapsCompleted: number
  lapTimesMs: number[]
  bestLapMs: number | null

  tokensIn: number
  tokensOut: number
  costUsd: number
  costPerDecision: number
  /** true when at least one record's usage / cost is an estimate (mock engines). */
  costEstimated: boolean

  decisionsPerMinute: number

  calibration: CalibrationMetrics
}

export interface SeriesPoint {
  /** 1-based decision number. */
  n: number
  /** Rate in [0, 1]. */
  value: number
}

// ───────────────────────────── Computation ──────────────────────────────

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>
  for (const k of keys) out[k] = 0
  return out
}

export function computeCalibration(records: readonly DecisionRecord[]): CalibrationMetrics {
  const binCount = new Array<number>(CALIBRATION_BINS).fill(0)
  const binConf = new Array<number>(CALIBRATION_BINS).fill(0)
  const binRight = new Array<number>(CALIBRATION_BINS).fill(0)

  let n = 0
  let brierSum = 0
  let confSum = 0
  let confRightSum = 0
  let confWrongSum = 0
  let rightN = 0
  let wrongN = 0
  let low = 0

  for (const r of records) {
    const raw = r.result.answer.moveConfidence
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const conf = Math.min(1, Math.max(0, raw))
    const right = r.moveOutcome === 'optimal'
    const y = right ? 1 : 0

    n += 1
    brierSum += (conf - y) ** 2
    confSum += conf
    if (right) {
      rightN += 1
      confRightSum += conf
    } else {
      wrongN += 1
      confWrongSum += conf
    }
    if (conf < LOW_CONFIDENCE_THRESHOLD) low += 1

    // conf === 1 belongs to the last bin; the epsilon absorbs 0.1 * k float noise (e.g. 0.7 * 10).
    const b = Math.min(CALIBRATION_BINS - 1, Math.floor(conf * CALIBRATION_BINS + 1e-9))
    binCount[b] += 1
    binConf[b] += conf
    binRight[b] += y
  }

  const bins: ReliabilityBin[] = []
  let ece = 0
  for (let i = 0; i < CALIBRATION_BINS; i++) {
    const count = binCount[i]
    const avgConfidence = count > 0 ? binConf[i] / count : null
    const accuracy = count > 0 ? binRight[i] / count : null
    bins.push({ lo: i / CALIBRATION_BINS, hi: (i + 1) / CALIBRATION_BINS, count, avgConfidence, accuracy })
    if (count > 0 && avgConfidence !== null && accuracy !== null) {
      ece += (count / n) * Math.abs(accuracy - avgConfidence)
    }
  }

  return {
    count: n,
    brier: n > 0 ? brierSum / n : null,
    ece: n > 0 ? ece : null,
    bins,
    avgConfidence: n > 0 ? confSum / n : null,
    avgConfidenceWhenRight: rightN > 0 ? confRightSum / rightN : null,
    avgConfidenceWhenWrong: wrongN > 0 ? confWrongSum / wrongN : null,
    lowConfidenceRate: n > 0 ? low / n : null,
  }
}

export function computeMetrics(records: readonly DecisionRecord[], snapshot: LaneSnapshot | null): EngineMetrics {
  const decisions = records.length
  const moveOutcomes = zeroCounts(MOVE_OUTCOMES)
  const speedOutcomes = zeroCounts(SPEED_OUTCOMES)

  let hits = 0
  let errors = 0
  let junctionDecisions = 0
  let junctionOptimal = 0
  let invalidCount = 0
  let tokensIn = 0
  let tokensOut = 0
  let costUsd = 0
  let costEstimated = false
  let lastEndMs = 0
  const e2e: number[] = []
  const provider: number[] = []

  for (const r of records) {
    moveOutcomes[r.moveOutcome] += 1
    speedOutcomes[r.speedOutcome] += 1
    if (r.hit) hits += 1
    if (r.error) errors += 1
    if (r.oracle.isJunction) {
      junctionDecisions += 1
      if (r.moveOutcome === 'optimal') junctionOptimal += 1
    }
    if (r.result.status === 'invalid' || r.moveOutcome === 'invalid') invalidCount += 1

    if (Number.isFinite(r.latencyMs)) e2e.push(r.latencyMs)
    const pl = r.result.providerLatencyMs
    if (typeof pl === 'number' && Number.isFinite(pl)) provider.push(pl)

    const usage = r.result.usage
    if (usage) {
      tokensIn += usage.inputTokens || 0
      tokensOut += usage.outputTokens || 0
    }
    if (typeof r.result.costUsd === 'number' && Number.isFinite(r.result.costUsd)) costUsd += r.result.costUsd
    if (r.result.estimated) costEstimated = true

    const end = r.raceTimeAtStartMs + (r.latencyMs || 0)
    if (end > lastEndMs) lastEndMs = end
  }

  const partials = Math.max(0, decisions - hits - errors)
  const moveOptimal = moveOutcomes.optimal
  const speedCorrect = speedOutcomes.correct
  const speedGraded = decisions - speedOutcomes.not_graded

  const time: TimeBreakdown = snapshot
    ? {
        raceMs: snapshot.raceTimeMs,
        movingMs: snapshot.movingTimeMs,
        thinkingMs: snapshot.thinkingTimeMs,
        penaltyMs: snapshot.penaltyTimeMs,
        thinkingShare: safeDiv(snapshot.thinkingTimeMs, snapshot.raceTimeMs),
      }
    : { raceMs: 0, movingMs: 0, thinkingMs: 0, penaltyMs: 0, thinkingShare: 0 }

  const lapTimesMs = snapshot ? [...snapshot.lapTimesMs] : []
  // Throughput over race time; without a snapshot, approximate with the end of the last decision.
  const throughputMs = time.raceMs > 0 ? time.raceMs : lastEndMs

  return {
    decisions,
    hits,
    errors,
    partials,
    hitRate: safeDiv(hits, decisions),
    errorRate: safeDiv(errors, decisions),
    partialRate: safeDiv(partials, decisions),

    moveAccuracy: decisions > 0 ? moveOptimal / decisions : null,
    moveOptimal,
    speedAccuracy: speedGraded > 0 ? speedCorrect / speedGraded : null,
    speedGraded,
    speedCorrect,
    junctionAccuracy: junctionDecisions > 0 ? junctionOptimal / junctionDecisions : null,
    junctionDecisions,
    junctionOptimal,

    invalidCount,
    invalidRate: safeDiv(invalidCount, decisions),
    timeouts: moveOutcomes.timeout,
    crashes: moveOutcomes.crash,
    spins: speedOutcomes.too_fast,

    moveOutcomes,
    speedOutcomes,

    latency: latencyStats(e2e),
    providerLatency: latencyStats(provider),

    time,
    lapsCompleted: lapTimesMs.length,
    lapTimesMs,
    bestLapMs: lapTimesMs.length > 0 ? Math.min(...lapTimesMs) : null,

    tokensIn,
    tokensOut,
    costUsd,
    costPerDecision: safeDiv(costUsd, decisions),
    costEstimated,

    decisionsPerMinute: throughputMs > 0 ? safeDiv(decisions, throughputMs / 60_000) : 0,

    calibration: computeCalibration(records),
  }
}

// ─────────────────────────────── Series ────────────────────────────────

/** Hit rate over a sliding window of the last `window` decisions. Records must be in chronological order. */
export function rollingHitRate(records: readonly DecisionRecord[], window: number): SeriesPoint[] {
  const w = Math.max(1, Math.floor(window) || 1)
  const out: SeriesPoint[] = []
  let inWindow = 0
  for (let i = 0; i < records.length; i++) {
    if (records[i].hit) inWindow += 1
    if (i >= w && records[i - w].hit) inWindow -= 1
    out.push({ n: i + 1, value: inWindow / Math.min(w, i + 1) })
  }
  return out
}

/** Running hit rate: hits so far / decisions so far. Records must be in chronological order. */
export function cumulativeHitRate(records: readonly DecisionRecord[]): SeriesPoint[] {
  const out: SeriesPoint[] = []
  let hits = 0
  for (let i = 0; i < records.length; i++) {
    if (records[i].hit) hits += 1
    out.push({ n: i + 1, value: hits / (i + 1) })
  }
  return out
}
