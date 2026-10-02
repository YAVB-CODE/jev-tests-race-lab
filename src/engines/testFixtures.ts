/** Hand-built fixtures shared by the engine tests (not part of the app bundle). */
import type { Difficulty, EngineContext, Observation, OracleAnswer } from '../shared/contracts.ts'
import { createRng } from '../shared/rng.ts'
import type { DeepPartial, MockProfile } from './profiles.ts'

export function makeObservation(difficulty: Difficulty = 'normal', decisionIndex = 0): Observation {
  return {
    decisionIndex,
    lap: 1,
    totalLaps: 3,
    heading: 'E',
    currentSpeed: 'cruise',
    difficulty,
    options: [
      { move: 'forward', onTrack: true, straightRun: 4, firstOilAt: null, nextCellHazard: 'none', summary: 'track continues straight for 4 cells' },
      { move: 'left', onTrack: true, straightRun: 2, firstOilAt: 1, nextCellHazard: 'oil', summary: 'track curves left, oil at cell 1' },
      { move: 'right', onTrack: false, summary: 'off track' },
    ],
  }
}

/** Single valid move (not a junction): forward. */
export const STRAIGHT_ORACLE: OracleAnswer = {
  bestMove: 'forward',
  validMoves: ['forward'],
  speedByMove: { forward: 'boost' },
  routeLengthByMove: { forward: 6 },
  isJunction: false,
}

/** Fork: forward (best, cruise) or left (valid but longer, slow). */
export const JUNCTION_ORACLE: OracleAnswer = {
  bestMove: 'forward',
  validMoves: ['forward', 'left'],
  speedByMove: { forward: 'cruise', left: 'slow' },
  routeLengthByMove: { forward: 5, left: 8 },
  isJunction: true,
}

export function makeCtx(
  oracle: OracleAnswer = STRAIGHT_ORACLE,
  seed = 1,
  signal: AbortSignal = new AbortController().signal,
): EngineContext {
  return { signal, oracle, random: createRng(seed) }
}

/** Overrides that make a MockEngine answer without waiting. */
export const ZERO_LATENCY: DeepPartial<MockProfile> = {
  latency: { medianMs: 0, sigma: 0, minMs: 0, maxMs: 0, spikeProbability: 0 },
}
