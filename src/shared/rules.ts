/**
 * Jev Race Lab — canonical game rules.
 *
 * Single source of truth for:
 *  - the simulator (oracle / grading / timing) in src/sim
 *  - the wording sent to BOTH models (server/adapters) — same text for GPT and Jev, for fairness
 *  - the mocks and the UI (penalties, speeds)
 */
import type { RelativeMove, SpeedMode } from './contracts.ts'

export const RULES = {
  /** Real-time ms to travel one cell at each speed. */
  CELL_TRAVEL_MS: { slow: 650, cruise: 420, boost: 260 } satisfies Record<SpeedMode, number>,
  /** Move off-track / wrong-way / into cones. Car is towed back onto the best route. */
  CRASH_PENALTY_MS: 3000,
  /** Speed faster than allowed (too_fast). */
  SPIN_PENALTY_MS: 1500,
  /** Unparseable answer, engine error or timeout. Car continues on autopilot (best move, slow). */
  INVALID_PENALTY_MS: 2000,
  DEFAULT_DECISION_TIMEOUT_MS: 10_000,
  STRAIGHT_RUN_CAP: 5,
  SPEED: {
    /** How many cells ahead `firstOilAt` looks. */
    LOOKAHEAD: 4,
    /** slow is required when oil is at route cell <= this index (1-based) ... */
    OIL_SLOW_WITHIN: 2,
    /** ... or when straightRun <= this value (the car must turn right after entering the next cell). */
    SLOW_MAX_STRAIGHT: 1,
    /** boost is allowed only when straightRun >= this value ... */
    BOOST_MIN_STRAIGHT: 4,
    /** ... and there is no oil in the first N route cells. */
    BOOST_CLEAR_WITHIN: 4,
  },
} as const

/**
 * Correct speed for a route, given its straight run and first-oil index.
 * The simulator's oracle MUST use this function so the rules text and the grading never diverge.
 */
export function correctSpeed(straightRun: number, firstOilAt: number | null): SpeedMode {
  const s = RULES.SPEED
  if ((firstOilAt !== null && firstOilAt <= s.OIL_SLOW_WITHIN) || straightRun <= s.SLOW_MAX_STRAIGHT) return 'slow'
  if (straightRun >= s.BOOST_MIN_STRAIGHT && (firstOilAt === null || firstOilAt > s.BOOST_CLEAR_WITHIN)) return 'boost'
  return 'cruise'
}

/** Speeds ordered from safest to fastest — used to grade too_slow / too_fast. */
export const SPEED_ORDER: Record<SpeedMode, number> = { slow: 0, cruise: 1, boost: 2 }

// ─────────────────────────── Prompt wording ───────────────────────────
// English on purpose: it is Jev's primary training language (accuracy is best in English).
// GPT receives the same text so the comparison is fair.

export const GAME_BRIEF = [
  'You drive a race car on a grid-based looping circuit. The car stops at every cell and you decide its next move and speed.',
  'Moves are RELATIVE to the car heading: "forward" keeps the heading, "left"/"right" turn 90 degrees. U-turns do not exist.',
  'A move is valid only if it stays on the track in race direction and its route is not blocked by cones. Invalid moves crash the car (time penalty).',
  'At a fork several moves can be valid: the best one is the shortest route to the next checkpoint.',
  'The observation may include: `options` (one entry per move: onTrack, blocked, nextCellHazard, straightRun, firstOilAt, summary, distanceToCheckpoint),',
  '`localMap` (egocentric ASCII grid, car at the bottom-center facing up, legend included) and `nextCheckpoint` (egocentric offset: ahead, right).',
  'Speed rules for the route after the move:',
  `- slow is REQUIRED if there is oil within the first ${RULES.SPEED.OIL_SLOW_WITHIN} cells of the route, or if straightRun <= ${RULES.SPEED.SLOW_MAX_STRAIGHT} (must turn right after entering the next cell).`,
  `- boost is allowed ONLY if straightRun >= ${RULES.SPEED.BOOST_MIN_STRAIGHT} and there is no oil in the first ${RULES.SPEED.BOOST_CLEAR_WITHIN} cells of the route.`,
  '- otherwise cruise.',
  'Going faster than allowed spins the car out (penalty). Going slower than needed only wastes time.',
].join('\n')

export const MOVE_QUESTION = {
  instructions:
    'Which move should the car make now? Choose a valid move (on track, in race direction, not blocked by cones); among valid moves choose the shortest route to the next checkpoint.',
  criteria: {
    forward: 'Keep driving straight in the current heading.',
    left: "Turn 90 degrees to the car's left, relative to its current heading.",
    right: "Turn 90 degrees to the car's right, relative to its current heading.",
  } satisfies Record<RelativeMove, string>,
} as const

export const SPEED_QUESTION = {
  instructions: 'At which speed should the car take the best move, following the speed rules?',
  criteria: {
    slow: `Required when the route after the best move has oil within its first ${RULES.SPEED.OIL_SLOW_WITHIN} cells, or straightRun <= ${RULES.SPEED.SLOW_MAX_STRAIGHT}.`,
    cruise: 'Normal speed: slow is not required but boost is not allowed.',
    boost: `Only when the route after the best move goes straight for at least ${RULES.SPEED.BOOST_MIN_STRAIGHT} cells with no oil in its first ${RULES.SPEED.BOOST_CLEAR_WITHIN} cells.`,
  } satisfies Record<SpeedMode, string>,
} as const
