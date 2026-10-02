import type {
  DecisionRecord,
  DecisionResult,
  OracleAnswer,
  RelativeMove,
  SpeedMode,
} from '../shared/contracts.ts'
import { RELATIVE_MOVES, SPEED_MODES } from '../shared/contracts.ts'
import { RULES, SPEED_ORDER } from '../shared/rules.ts'

export type Grade = Pick<
  DecisionRecord,
  'moveOutcome' | 'speedOutcome' | 'hit' | 'error' | 'appliedMove' | 'appliedSpeed' | 'penaltyMs'
>

function isMove(value: unknown): value is RelativeMove {
  return typeof value === 'string' && (RELATIVE_MOVES as readonly string[]).includes(value)
}

function isSpeed(value: unknown): value is SpeedMode {
  return typeof value === 'string' && (SPEED_MODES as readonly string[]).includes(value)
}

/** Grades one decision against the oracle (see DecisionRecord / RULES). */
export function gradeDecision(oracle: OracleAnswer, result: DecisionResult): Grade {
  const autopilot = (moveOutcome: Grade['moveOutcome'], penaltyMs: number): Grade => ({
    moveOutcome,
    speedOutcome: 'not_graded',
    hit: false,
    error: true,
    appliedMove: oracle.bestMove,
    appliedSpeed: 'slow',
    penaltyMs,
  })

  if (result.status !== 'ok') {
    const status = result.status === 'invalid' || result.status === 'timeout' ? result.status : 'error'
    return autopilot(status, RULES.INVALID_PENALTY_MS)
  }
  const move = result.answer?.move
  const speed = result.answer?.speed
  if (!isMove(move) || !isSpeed(speed)) return autopilot('invalid', RULES.INVALID_PENALTY_MS)
  if (!oracle.validMoves.includes(move)) return autopilot('crash', RULES.CRASH_PENALTY_MS)

  const bestLength = oracle.routeLengthByMove[oracle.bestMove]
  const moveOutcome = oracle.routeLengthByMove[move] === bestLength ? 'optimal' : 'suboptimal'
  const correct = oracle.speedByMove[move] ?? 'slow'
  const diff = SPEED_ORDER[speed] - SPEED_ORDER[correct]
  const speedOutcome = diff === 0 ? 'correct' : diff < 0 ? 'too_slow' : 'too_fast'
  return {
    moveOutcome,
    speedOutcome,
    hit: moveOutcome === 'optimal' && speedOutcome === 'correct',
    error: speedOutcome === 'too_fast',
    appliedMove: move,
    appliedSpeed: speedOutcome === 'too_fast' ? correct : speed,
    penaltyMs: speedOutcome === 'too_fast' ? RULES.SPIN_PENALTY_MS : 0,
  }
}
