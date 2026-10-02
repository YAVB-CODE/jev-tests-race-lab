/**
 * Hand-built sample observations (contracts.ts shapes) for the tests and the live smoke test.
 */
import type { Observation } from '../src/shared/contracts.ts'

/**
 * Easy difficulty: numeric `options` + `distanceToCheckpoint`.
 * Expected answer: forward (only valid move: left is off-track, right is blocked by cones) and
 * boost (straightRun 5 ≥ 4, no oil within the first 4 cells).
 */
export const SAMPLE_EASY_OBSERVATION: Observation = {
  decisionIndex: 7,
  lap: 1,
  totalLaps: 3,
  heading: 'E',
  currentSpeed: 'cruise',
  difficulty: 'easy',
  options: [
    { move: 'forward', onTrack: true, blocked: false, nextCellHazard: 'none', straightRun: 5, firstOilAt: null, distanceToCheckpoint: 6 },
    { move: 'left', onTrack: false, blocked: false, nextCellHazard: 'none', straightRun: 0, firstOilAt: null, distanceToCheckpoint: null },
    { move: 'right', onTrack: true, blocked: true, nextCellHazard: 'none', straightRun: 2, firstOilAt: null, distanceToCheckpoint: 4 },
  ],
}

export const SAMPLE_EASY_EXPECTED = { move: 'forward', speed: 'boost' } as const

/**
 * Easy difficulty with oil: forward is on track with oil in the next cell → slow is required.
 */
export const SAMPLE_EASY_OIL_OBSERVATION: Observation = {
  decisionIndex: 12,
  lap: 2,
  totalLaps: 3,
  heading: 'N',
  currentSpeed: 'boost',
  difficulty: 'easy',
  options: [
    { move: 'forward', onTrack: true, blocked: false, nextCellHazard: 'oil', straightRun: 3, firstOilAt: 1, distanceToCheckpoint: 5 },
    { move: 'left', onTrack: false, blocked: false, nextCellHazard: 'none', straightRun: 0, firstOilAt: null, distanceToCheckpoint: null },
    { move: 'right', onTrack: false, blocked: false, nextCellHazard: 'none', straightRun: 0, firstOilAt: null, distanceToCheckpoint: null },
  ],
}

export const SAMPLE_EASY_OIL_EXPECTED = { move: 'forward', speed: 'slow' } as const
