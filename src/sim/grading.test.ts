import { describe, expect, it } from 'vitest'
import type { DecisionResult, DecisionStatus, OracleAnswer, RelativeMove, SpeedMode } from '../shared/contracts.ts'
import { RULES } from '../shared/rules.ts'
import { gradeDecision } from './grading.ts'

// Fork: forward = shortcut (6 cells, boost), left = detour (10 cells, cruise), right = off track.
const oracle: OracleAnswer = {
  bestMove: 'forward',
  validMoves: ['forward', 'left'],
  speedByMove: { forward: 'cruise', left: 'slow' },
  routeLengthByMove: { forward: 6, left: 10 },
  isJunction: true,
}

const result = (move: RelativeMove | null, speed: SpeedMode | null, status: DecisionStatus = 'ok'): DecisionResult => ({
  engine: 'gpt',
  mode: 'mock',
  model: 'mock-gpt',
  status,
  answer: { move, speed },
})

describe('gradeDecision', () => {
  it.each([
    // move, speed, status → moveOutcome, speedOutcome, hit, error, appliedMove, appliedSpeed, penalty
    ['forward', 'cruise', 'ok', 'optimal', 'correct', true, false, 'forward', 'cruise', 0],
    ['forward', 'slow', 'ok', 'optimal', 'too_slow', false, false, 'forward', 'slow', 0],
    ['forward', 'boost', 'ok', 'optimal', 'too_fast', false, true, 'forward', 'cruise', RULES.SPIN_PENALTY_MS],
    ['left', 'slow', 'ok', 'suboptimal', 'correct', false, false, 'left', 'slow', 0],
    ['left', 'cruise', 'ok', 'suboptimal', 'too_fast', false, true, 'left', 'slow', RULES.SPIN_PENALTY_MS],
    ['right', 'slow', 'ok', 'crash', 'not_graded', false, true, 'forward', 'slow', RULES.CRASH_PENALTY_MS],
    [null, 'slow', 'ok', 'invalid', 'not_graded', false, true, 'forward', 'slow', RULES.INVALID_PENALTY_MS],
    ['forward', null, 'ok', 'invalid', 'not_graded', false, true, 'forward', 'slow', RULES.INVALID_PENALTY_MS],
    [null, null, 'invalid', 'invalid', 'not_graded', false, true, 'forward', 'slow', RULES.INVALID_PENALTY_MS],
    [null, null, 'timeout', 'timeout', 'not_graded', false, true, 'forward', 'slow', RULES.INVALID_PENALTY_MS],
    ['forward', 'cruise', 'error', 'error', 'not_graded', false, true, 'forward', 'slow', RULES.INVALID_PENALTY_MS],
  ] as const)(
    '%s @ %s (%s) → %s / %s',
    (move, speed, status, moveOutcome, speedOutcome, hit, error, appliedMove, appliedSpeed, penaltyMs) => {
      expect(gradeDecision(oracle, result(move, speed, status))).toEqual({
        moveOutcome,
        speedOutcome,
        hit,
        error,
        appliedMove,
        appliedSpeed,
        penaltyMs,
      })
    },
  )

  it('treats garbage values from an engine as invalid', () => {
    const garbage = { ...result(null, null), answer: { move: 'backwards', speed: 'warp' } } as unknown as DecisionResult
    expect(gradeDecision(oracle, garbage).moveOutcome).toBe('invalid')
  })

  it('equal-length alternatives are both optimal', () => {
    const tie: OracleAnswer = { ...oracle, routeLengthByMove: { forward: 6, left: 6 }, speedByMove: { forward: 'cruise', left: 'cruise' } }
    expect(gradeDecision(tie, result('left', 'cruise')).moveOutcome).toBe('optimal')
    expect(gradeDecision(tie, result('left', 'cruise')).hit).toBe(true)
  })
})
