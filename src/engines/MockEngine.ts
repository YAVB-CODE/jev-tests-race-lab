/**
 * MockEngine — a local, profile-driven stand-in for a model. SIMULATED: it reads the oracle (the ideal
 * answer) and injects errors, latency and confidence according to a MockProfile. Nothing here is measured.
 *
 * Reproducibility: every random number comes from `ctx.random`, and each decision consumes a FIXED number
 * of draws (independent of branches taken or of an abort), so a seeded stream gives the same results run
 * after run and one decision never shifts the randomness of the following ones.
 */
import type {
  DecisionAnswer,
  DecisionEngine,
  DecisionResult,
  EngineContext,
  EngineId,
  Observation,
  OracleAnswer,
  RelativeMove,
  SpeedMode,
} from '../shared/contracts.ts'
import { RELATIVE_MOVES, SPEED_MODES } from '../shared/contracts.ts'
import { logNormal } from '../shared/rng.ts'
import { SPEED_ORDER } from '../shared/rules.ts'
import { abortableDelay } from './abort.ts'
import { engineLabel } from './labels.ts'
import { MOCK_PROFILES, mergeProfile } from './profiles.ts'
import type { DeepPartial, MockLatencyProfile, MockProfile } from './profiles.ts'

export interface MockEngineOptions {
  /** Applied on top of MOCK_PROFILES[id], key by key. */
  profile?: DeepPartial<MockProfile>
  label?: string
}

/** The chosen option always keeps at least 50 % of the mass, so it stays the argmax of its distribution. */
const MAX_WRONG_PROBABILITY = 0.5
/** Floor for the per-decision wrong probability (calibrated model): never claim 100 % certainty. */
const MIN_WRONG_PROBABILITY = 0.002

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/** Samples the (simulated) provider latency. Always consumes 4 draws. */
export function sampleLatencyMs(latency: MockLatencyProfile, random: () => number): number {
  const body = logNormal(random, latency.medianMs, latency.sigma)
  const spikeRoll = random()
  const spikeMagnitude = random()
  const { min, max } = latency.spikeMultiplier
  const raw = spikeRoll < latency.spikeProbability ? latency.medianMs * (min + spikeMagnitude * (max - min)) : body
  return Math.round(clamp(raw, latency.minMs, latency.maxMs))
}

/**
 * Per-decision probability of being wrong for a 'calibrated' model. It is a latent "difficulty" signal with
 * mean `rate` (so the long-run error rate matches the profile): `u` shapes it as rate × (1 + (3u² − 1)·s),
 * s ∈ (0, 1] chosen so the value never exceeds MAX_WRONG_PROBABILITY. The model then reports 1 − that value as
 * its confidence and errs with exactly that probability — calibrated by construction, and wrong answers
 * come with visibly lower confidence.
 */
function latentWrongProbability(rate: number, u: number): number {
  const mean = clamp(rate, 0, MAX_WRONG_PROBABILITY)
  if (mean === 0) return 0
  const spread = Math.min(1, (MAX_WRONG_PROBABILITY - mean) / (2 * mean))
  const factor = 1 + (3 * u * u - 1) * spread
  return clamp(mean * factor, Math.min(MIN_WRONG_PROBABILITY, mean), MAX_WRONG_PROBABILITY)
}

function pick<T>(items: readonly T[], u: number): T {
  return items[Math.min(items.length - 1, Math.floor(u * items.length))]
}

/** A wrong move: another valid one at a junction, otherwise an invalid one (crash). */
function pickWrongMove(oracle: OracleAnswer, u: number): RelativeMove {
  const alternatives = oracle.validMoves.filter((m) => m !== oracle.bestMove)
  if (alternatives.length > 0) return pick(alternatives, u)
  const invalid = RELATIVE_MOVES.filter((m) => !oracle.validMoves.includes(m))
  if (invalid.length > 0) return pick(invalid, u)
  return oracle.bestMove
}

/** A wrong speed adjacent to the ideal one (random when there is no ideal, i.e. the move was invalid). */
function pickWrongSpeed(ideal: SpeedMode | undefined, u: number): SpeedMode {
  if (ideal === undefined) return pick(SPEED_MODES, u)
  const neighbours = SPEED_MODES.filter((s) => Math.abs(SPEED_ORDER[s] - SPEED_ORDER[ideal]) === 1)
  return pick(neighbours, u)
}

/**
 * Full distribution: `chosen` gets `peak`, the rest is split proportionally to `weights`.
 * Probabilities are rounded to 4 decimals; the last one absorbs the residual so the sum is exactly 1.
 */
function buildDistribution<T extends string>(
  options: readonly T[],
  chosen: T,
  peak: number,
  weights: Record<T, number>,
): Record<T, number> {
  const others = options.filter((o) => o !== chosen)
  const remaining = 1 - round4(peak)
  const totalWeight = others.reduce((sum, o) => sum + weights[o], 0)
  const out = { [chosen]: round4(peak) } as Record<T, number>
  let assigned = 0
  others.forEach((o, i) => {
    const p = i === others.length - 1 ? Math.max(0, round4(remaining - assigned)) : round4((remaining * weights[o]) / totalWeight)
    out[o] = p
    assigned += p
  })
  return out
}

/** Jev's Choice confidence: (n·peak − 1) / (n − 1), clamped to [0, 1]. */
function nativeConfidence(peak: number, n: number): number {
  return round4(clamp((n * peak - 1) / (n - 1), 0, 1))
}

function verbalizedConfidence(u: number): number {
  return Math.round((0.88 + u * 0.11) * 100) / 100
}

function estimateInputTokens(observation: Observation, overhead: number): number {
  return Math.ceil(JSON.stringify(observation).length / 4) + overhead
}

export class MockEngine implements DecisionEngine {
  readonly id: EngineId
  readonly mode = 'mock' as const
  readonly label: string
  readonly profile: MockProfile

  constructor(id: EngineId, options: MockEngineOptions = {}) {
    this.id = id
    this.profile = mergeProfile(MOCK_PROFILES[id], options.profile)
    this.label = options.label ?? engineLabel(id, 'mock')
  }

  async decide(observation: Observation, ctx: EngineContext): Promise<DecisionResult> {
    const result = this.simulate(observation, ctx.oracle, ctx.random)
    await abortableDelay(result.providerLatencyMs ?? 0, ctx.signal)
    return result
  }

  /** Builds the whole (simulated) answer up front; the wait happens afterwards. */
  private simulate(observation: Observation, oracle: OracleAnswer, random: () => number): DecisionResult {
    const profile = this.profile
    const latencyMs = sampleLatencyMs(profile.latency, random)

    // Fixed draw order (4 for the latency + these 10) — see the file header.
    const transientRoll = random()
    const invalidRoll = random()
    const moveLatent = random()
    const moveRoll = random()
    const movePick = random()
    const speedLatent = random()
    const speedRoll = random()
    const speedPick = random()
    const moveConfidenceDraw = random()
    const speedConfidenceDraw = random()

    const base = {
      engine: this.id,
      mode: 'mock' as const,
      model: profile.model,
      providerLatencyMs: latencyMs,
      estimated: true,
    }
    const request = { observation }
    const emptyAnswer: DecisionAnswer = { move: null, speed: null }

    if (transientRoll < profile.transientErrorRate) {
      const errorMessage = 'Simulated transient provider error (HTTP 503)'
      return {
        ...base,
        status: 'error',
        answer: emptyAnswer,
        errorMessage,
        raw: { request, response: { answer: emptyAnswer, simulated: true, error: errorMessage } },
      }
    }

    const inputTokens = estimateInputTokens(observation, profile.promptOverheadTokens)
    const outputTokens = profile.outputTokens
    const usage = { inputTokens, outputTokens }
    const costUsd = (inputTokens * profile.prices.inputPerMTok + outputTokens * profile.prices.outputPerMTok) / 1_000_000

    if (invalidRoll < profile.invalidRate) {
      return {
        ...base,
        status: 'invalid',
        answer: emptyAnswer,
        errorMessage: 'Simulated invalid output: could not be parsed into a valid move and speed',
        usage,
        costUsd,
        raw: { request, response: { answer: emptyAnswer, simulated: true, invalid: true } },
      }
    }

    const calibrated = profile.confidenceModel === 'calibrated'
    const difficulty = observation.difficulty

    // Move
    const moveRate = oracle.isJunction
      ? profile.moveErrorRate.junction[difficulty]
      : profile.moveErrorRate.nonJunction[difficulty]
    const moveWrongProbability = calibrated ? latentWrongProbability(moveRate, moveLatent) : clamp(moveRate, 0, 1)
    const move = moveRoll < moveWrongProbability ? pickWrongMove(oracle, movePick) : oracle.bestMove

    // Speed (graded against the chosen move's ideal speed, or the best move's if the move is invalid)
    const idealSpeed = oracle.speedByMove[move]
    const referenceSpeed = idealSpeed ?? oracle.speedByMove[oracle.bestMove] ?? 'cruise'
    const speedRate = profile.speedErrorRate[difficulty]
    const speedWrongProbability = calibrated ? latentWrongProbability(speedRate, speedLatent) : clamp(speedRate, 0, 1)
    const speed = speedRoll < speedWrongProbability ? pickWrongSpeed(idealSpeed, speedPick) : referenceSpeed

    const answer: DecisionAnswer = { move, speed }
    if (calibrated) {
      const movePeak = 1 - moveWrongProbability
      const speedPeak = 1 - speedWrongProbability
      const moveWeights = {} as Record<RelativeMove, number>
      for (const m of RELATIVE_MOVES) {
        moveWeights[m] = m === oracle.bestMove && move !== oracle.bestMove ? 5 : oracle.validMoves.includes(m) ? 3 : 1
      }
      const speedWeights = {} as Record<SpeedMode, number>
      for (const s of SPEED_MODES) {
        speedWeights[s] = s === referenceSpeed && speed !== referenceSpeed ? 5 : Math.abs(SPEED_ORDER[s] - SPEED_ORDER[speed]) === 1 ? 3 : 1
      }
      const moveProbabilities = buildDistribution(RELATIVE_MOVES, move, movePeak, moveWeights)
      const speedProbabilities = buildDistribution(SPEED_MODES, speed, speedPeak, speedWeights)
      answer.moveProbabilities = moveProbabilities
      answer.speedProbabilities = speedProbabilities
      answer.moveConfidence = moveProbabilities[move]
      answer.speedConfidence = speedProbabilities[speed]
      answer.nativeMoveConfidence = nativeConfidence(moveProbabilities[move], RELATIVE_MOVES.length)
      answer.nativeSpeedConfidence = nativeConfidence(speedProbabilities[speed], SPEED_MODES.length)
    } else {
      answer.moveConfidence = verbalizedConfidence(moveConfidenceDraw)
      answer.speedConfidence = verbalizedConfidence(speedConfidenceDraw)
    }

    return {
      ...base,
      status: 'ok',
      answer,
      usage,
      costUsd,
      raw: { request, response: { answer, simulated: true } },
    }
  }
}
