/** Minimal DecisionRecord factory for unit tests: pass only the fields a test cares about. */
import type { DecisionRecord, EngineId, MoveOutcome, SpeedOutcome } from '../../shared/contracts.ts'

export interface RecordSpec {
  engine?: EngineId
  index?: number
  moveOutcome?: MoveOutcome
  speedOutcome?: SpeedOutcome
  latencyMs?: number
  providerLatencyMs?: number
  confidence?: number
  isJunction?: boolean
  status?: 'ok' | 'invalid' | 'error' | 'timeout'
  costUsd?: number
  tokens?: [number, number]
  estimated?: boolean
  raceTimeAtStartMs?: number
}

export function makeRecord(spec: RecordSpec = {}): DecisionRecord {
  const engine = spec.engine ?? 'jev'
  const index = spec.index ?? 0
  const moveOutcome = spec.moveOutcome ?? 'optimal'
  const speedOutcome = spec.speedOutcome ?? 'correct'
  const failed = moveOutcome === 'crash' || moveOutcome === 'invalid' || moveOutcome === 'timeout' || moveOutcome === 'error'
  const status = spec.status ?? (moveOutcome === 'invalid' ? 'invalid' : moveOutcome === 'timeout' ? 'timeout' : moveOutcome === 'error' ? 'error' : 'ok')
  return {
    id: `${engine}-${index}`,
    engine,
    index,
    lap: 1,
    cell: { x: 0, y: 0 },
    heading: 'N',
    observation: { decisionIndex: index, lap: 1, totalLaps: 1, heading: 'N', currentSpeed: 'cruise', difficulty: 'easy' },
    oracle: {
      bestMove: 'forward',
      validMoves: spec.isJunction ? ['forward', 'left'] : ['forward'],
      speedByMove: { forward: 'cruise' },
      routeLengthByMove: { forward: 3 },
      isJunction: spec.isJunction ?? false,
    },
    result: {
      engine,
      mode: 'mock',
      model: 'test',
      status,
      answer: { move: status === 'ok' ? 'forward' : null, speed: status === 'ok' ? 'cruise' : null, moveConfidence: spec.confidence },
      providerLatencyMs: spec.providerLatencyMs,
      usage: spec.tokens ? { inputTokens: spec.tokens[0], outputTokens: spec.tokens[1] } : undefined,
      costUsd: spec.costUsd,
      estimated: spec.estimated,
    },
    latencyMs: spec.latencyMs ?? 100,
    moveOutcome,
    speedOutcome,
    hit: moveOutcome === 'optimal' && speedOutcome === 'correct',
    error: failed || speedOutcome === 'too_fast',
    appliedMove: 'forward',
    appliedSpeed: 'cruise',
    penaltyMs: 0,
    raceTimeAtStartMs: spec.raceTimeAtStartMs ?? 0,
  }
}
