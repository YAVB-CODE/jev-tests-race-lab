import type { Cell, Hazard, Heading, OracleAnswer, RelativeMove, SpeedMode, TrackDefinition } from '../shared/contracts.ts'
import { analyzeCell, createContext } from './analysis.ts'
import type { CellAnalysis } from './analysis.ts'

/** Converts a cell analysis into the contract's OracleAnswer. */
export function oracleFromAnalysis(analysis: CellAnalysis): OracleAnswer {
  const speedByMove: Partial<Record<RelativeMove, SpeedMode>> = {}
  const routeLengthByMove: Partial<Record<RelativeMove, number>> = {}
  for (const m of analysis.moves) {
    if (m.kind !== 'ok') continue
    speedByMove[m.move] = m.speed!
    routeLengthByMove[m.move] = m.routeLength!
  }
  // Never happens on a validated track with generated hazards; fall back to any road exit.
  const fallback = analysis.moves.find((m) => m.kind === 'blocked')?.move ?? 'forward'
  return {
    bestMove: analysis.bestMove ?? fallback,
    validMoves: [...analysis.validMoves],
    speedByMove,
    routeLengthByMove,
    isJunction: analysis.validMoves.length > 1,
  }
}

/**
 * Ground truth for a car at `cell` facing `heading`: shortest route to the next checkpoint over the
 * directed race graph avoiding cones, and the correct speed for each valid move (RULES / correctSpeed).
 */
export function computeOracle(track: TrackDefinition, hazards: readonly Hazard[], cell: Cell, heading: Heading): OracleAnswer {
  return oracleFromAnalysis(analyzeCell(createContext(track, hazards), cell, heading))
}
