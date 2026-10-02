/**
 * Observation builder: what the AI sees. Both engines receive the exact same object.
 * Everything here is derived from the same analysis as the oracle (fairness invariant), but no field
 * or text ever says which move is best.
 */
import type {
  Cell,
  Difficulty,
  Hazard,
  Heading,
  LocalMap,
  Observation,
  OptionView,
  SpeedMode,
  TrackDefinition,
} from '../shared/contracts.ts'
import { RULES } from '../shared/rules.ts'
import { analyzeCell, createContext } from './analysis.ts'
import type { CellAnalysis, MoveAnalysis, SimContext } from './analysis.ts'
import { cellKey, fromEgocentric, relativeMove, sameCell, toEgocentric } from './geometry.ts'

export interface ObservationState {
  cell: Cell
  heading: Heading
  /** 1-based. */
  lap: number
  totalLaps: number
  /** 0-based index of this decision in the race. */
  decisionIndex: number
  currentSpeed: SpeedMode
}

export const LOCAL_MAP_SIZE: Record<'normal' | 'hard', number> = { normal: 7, hard: 11 }

/** Same legend for every map; `rows` only ever use these characters. */
export const LOCAL_MAP_LEGEND: Record<string, string> = {
  '@': 'your car (bottom-center), facing up: forward = up, left = left, right = right',
  '^': 'road; race direction leaving this cell is up',
  '>': 'road; race direction leaving this cell is to the right',
  'v': 'road; race direction leaving this cell is down',
  '<': 'road; race direction leaving this cell is to the left',
  'Y': 'fork: the road splits; it continues into every adjacent road cell except the one that leads into it',
  'o': 'oil on the road (see the speed rules); the road continues through it',
  'X': 'cones: closed cell; entering it, or a branch that contains it, is a crash',
  '*': 'next checkpoint (the target of the route); the road continues through it',
  '.': 'off-track (no road)',
}

const ARROWS = ['^', '>', 'v', '<'] as const

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Deterministic English description of one option (parsable; never says which move is best). */
export function describeMove(m: MoveAnalysis, analysis: CellAnalysis): string {
  if (m.kind === 'offroad') return 'off track: no road in this direction'
  if (m.kind === 'wrongway') return 'off track: wrong way (this road runs against the race direction)'
  if (m.kind === 'blocked') {
    return m.coneAt !== null
      ? `on track but blocked: cones at route cell ${m.coneAt}, this route is closed`
      : 'on track but blocked: cones further along, this route is closed'
  }
  const cap = RULES.STRAIGHT_RUN_CAP
  const run =
    m.straightRun >= cap
      ? `straight for ${cap}+ cells`
      : `straight for ${plural(m.straightRun, 'cell')}${m.turnAfterRun ? `, then curves ${m.turnAfterRun}` : ''}`
  const oil = m.firstOilAt !== null ? `oil at route cell ${m.firstOilAt}` : `no oil in the next ${RULES.SPEED.LOOKAHEAD} route cells`
  const target = `next checkpoint${analysis.targetIsFinish ? ' (finish line)' : ''} in ${plural(m.routeLength!, 'cell')}`
  return `on track: ${run}; ${oil}; ${target}`
}

function optionView(m: MoveAnalysis, analysis: CellAnalysis, difficulty: 'easy' | 'normal'): OptionView {
  const onTrack = m.kind === 'ok' || m.kind === 'blocked'
  const summary = describeMove(m, analysis)
  if (difficulty === 'normal') return { move: m.move, onTrack, summary }
  return {
    move: m.move,
    onTrack,
    blocked: m.kind === 'blocked',
    nextCellHazard: m.nextCellHazard,
    straightRun: m.straightRun,
    firstOilAt: m.firstOilAt,
    distanceToCheckpoint: m.routeLength,
    summary,
  }
}

function cellGlyph(ctx: SimContext, analysis: CellAnalysis, cell: Cell): string {
  const key = cellKey(cell)
  if (!ctx.graph.tiles.has(key)) return '.'
  if (ctx.cones.has(key)) return 'X'
  if (ctx.oil.has(key)) return 'o'
  if (sameCell(cell, analysis.targetCell)) return '*'
  const out = ctx.graph.outgoing.get(key)!
  if (out.length > 1) return 'Y'
  const rel = relativeMove(analysis.heading, out[0])
  return rel === 'forward' ? ARROWS[0] : rel === 'right' ? ARROWS[1] : rel === 'back' ? ARROWS[2] : ARROWS[3]
}

/** Egocentric size×size map: car at the bottom-center facing up, rows[0] = farthest ahead. */
export function renderLocalMap(ctx: SimContext, analysis: CellAnalysis, size: number, hard: boolean): LocalMap {
  const half = (size - 1) / 2
  const rows: string[] = []
  for (let r = 0; r < size; r++) {
    let row = ''
    for (let c = 0; c < size; c++) {
      if (r === size - 1 && c === half) {
        row += '@'
        continue
      }
      row += cellGlyph(ctx, analysis, fromEgocentric(analysis.cell, analysis.heading, size - 1 - r, c - half))
    }
    rows.push(row)
  }
  const note = [
    `Egocentric ${size}x${size} view: rows[0] is the farthest row ahead (${size - 1} cells), the last row is the car's row; columns run from the car's left to its right (${half} cells each side).`,
    'The car "@" is at the bottom-center and faces up. Arrows show the race direction when leaving each road cell.',
    'Orthogonally adjacent road cells are always connected. Entering a road cell whose arrow points back at the cell you come from is wrong-way (crash).',
    'Cells without an arrow (Y, o, X, *) continue the road from their neighbours. Route lengths count cells entered.',
    hard ? 'nextCheckpoint gives the target position relative to the car in cells: ahead > 0 is in front, right > 0 is to the right.' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return { rows, legend: { ...LOCAL_MAP_LEGEND }, note }
}

/** Builds the observation from an existing analysis (avoids recomputing it in the runner). */
export function observationFromAnalysis(
  ctx: SimContext,
  analysis: CellAnalysis,
  state: ObservationState,
  difficulty: Difficulty,
): Observation {
  const obs: Observation = {
    decisionIndex: state.decisionIndex,
    lap: state.lap,
    totalLaps: state.totalLaps,
    heading: state.heading,
    currentSpeed: state.currentSpeed,
    difficulty,
  }
  if (difficulty === 'hard') {
    obs.localMap = renderLocalMap(ctx, analysis, LOCAL_MAP_SIZE.hard, true)
    obs.nextCheckpoint = toEgocentric(analysis.cell, analysis.heading, analysis.targetCell)
    return obs
  }
  obs.options = analysis.moves.map((m) => optionView(m, analysis, difficulty))
  if (difficulty === 'normal') obs.localMap = renderLocalMap(ctx, analysis, LOCAL_MAP_SIZE.normal, false)
  return obs
}

export function buildObservation(
  track: TrackDefinition,
  hazards: readonly Hazard[],
  state: ObservationState,
  difficulty: Difficulty,
): Observation {
  const ctx = createContext(track, hazards)
  return observationFromAnalysis(ctx, analyzeCell(ctx, state.cell, state.heading), state, difficulty)
}
