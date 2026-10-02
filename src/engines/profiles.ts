/**
 * Mock engine profiles.
 *
 * IMPORTANT — these numbers are ILLUSTRATIVE ASSUMPTIONS, NOT MEASUREMENTS.
 * They were picked so the simulated race looks plausible (a slow-ish, sometimes spiky,
 * overconfident LLM vs. a fast, calibrated System One model) and they say NOTHING about
 * how GPT or Jev actually perform. Only LIVE mode (real calls through server/) measures
 * anything; the UI always labels mock runs as SIMULADO.
 *
 * Error rates are per decision. "Move error" at a junction picks another valid (suboptimal)
 * move, elsewhere it picks an invalid move (crash). "Speed error" picks an adjacent wrong speed.
 */
import type { Difficulty, EngineId } from '../shared/contracts.ts'

export type ConfidenceModel = 'calibrated' | 'overconfident'

export interface MockLatencyProfile {
  /** Median of the log-normal latency body, in ms. */
  medianMs: number
  /** Log-space standard deviation of the body. */
  sigma: number
  /** Hard clamp (applied after spikes), in ms. */
  minMs: number
  maxMs: number
  /** Probability that a decision is a latency spike (replaces the log-normal body). */
  spikeProbability: number
  /** A spike lasts medianMs × uniform(min, max). */
  spikeMultiplier: { min: number; max: number }
}

export interface MockProfile {
  /** Model name reported in DecisionResult.model. */
  model: string
  latency: MockLatencyProfile
  /** Probability of choosing a wrong move, by difficulty. `junction` = oracle.isJunction. */
  moveErrorRate: {
    nonJunction: Record<Difficulty, number>
    junction: Record<Difficulty, number>
  }
  /** Probability of choosing a wrong speed, by difficulty. */
  speedErrorRate: Record<Difficulty, number>
  /** Probability of an unparseable / out-of-schema output (status 'invalid'). */
  invalidRate: number
  /** Probability of a transient provider failure (status 'error'). */
  transientErrorRate: number
  /**
   * 'calibrated': confidence is the probability assigned to the chosen option and tracks correctness
   * (full distributions + Jev's native confidence).
   * 'overconfident': verbalized 0.88–0.99 regardless of correctness, no distribution.
   */
  confidenceModel: ConfidenceModel
  /** Estimated output tokens per decision. */
  outputTokens: number
  /** Estimated fixed prompt tokens (game brief, rules, questions) added to the observation tokens. */
  promptOverheadTokens: number
  /** USD per million tokens. */
  prices: { inputPerMTok: number; outputPerMTok: number }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export const MOCK_PROFILES: Record<EngineId, MockProfile> = {
  // GPT-like: ~0.9 s median, heavy right tail with 3–6 s spikes, a bit more error-prone on hard maps
  // and junctions, 1–2 % invalid outputs, verbalized (overconfident) confidence.
  gpt: {
    model: 'mock-gpt',
    latency: {
      medianMs: 900,
      sigma: 0.45,
      minMs: 250,
      maxMs: 9000,
      spikeProbability: 0.04,
      spikeMultiplier: { min: 3.3, max: 6.6 },
    },
    moveErrorRate: {
      nonJunction: { easy: 0.01, normal: 0.03, hard: 0.1 },
      junction: { easy: 0.08, normal: 0.18, hard: 0.32 },
    },
    speedErrorRate: { easy: 0.1, normal: 0.18, hard: 0.28 },
    invalidRate: 0.015,
    transientErrorRate: 0.005,
    confidenceModel: 'overconfident',
    outputTokens: 40,
    promptOverheadTokens: 450,
    prices: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  },
  // Jev-like: 70–500 ms (published range), never out-of-schema, calibrated probabilities,
  // output tokens are free.
  jev: {
    model: 'mock-jev',
    latency: {
      medianMs: 180,
      sigma: 0.35,
      minMs: 70,
      maxMs: 500,
      spikeProbability: 0.02,
      spikeMultiplier: { min: 1.8, max: 2.6 },
    },
    moveErrorRate: {
      nonJunction: { easy: 0.01, normal: 0.02, hard: 0.06 },
      junction: { easy: 0.05, normal: 0.11, hard: 0.22 },
    },
    speedErrorRate: { easy: 0.06, normal: 0.1, hard: 0.16 },
    invalidRate: 0,
    transientErrorRate: 0.002,
    confidenceModel: 'calibrated',
    outputTokens: 16,
    promptOverheadTokens: 520,
    prices: { inputPerMTok: 0.042, outputPerMTok: 0 },
  },
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function merge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = merge(base[key], value)
  }
  return out
}

/** Returns a new profile: `overrides` applied on top of `base`, merged key by key (nested objects too). */
export function mergeProfile(base: MockProfile, overrides?: DeepPartial<MockProfile>): MockProfile {
  return merge(base, overrides) as MockProfile
}
