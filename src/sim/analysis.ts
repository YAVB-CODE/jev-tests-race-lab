/**
 * Route analysis shared by the oracle and the observation builder, so both always describe the same
 * facts (fairness invariant).
 */
import type { Cell, Hazard, HazardKind, Heading, RelativeMove, SpeedMode, TrackDefinition } from '../shared/contracts.ts'
import { RELATIVE_MOVES } from '../shared/contracts.ts'
import { RULES, correctSpeed } from '../shared/rules.ts'
import { cellKey, neighbor, opposite, turn } from './geometry.ts'
import { getRaceGraph } from './graph.ts'
import type { RaceGraph } from './graph.ts'

export interface SimContext {
  track: TrackDefinition
  graph: RaceGraph
  oil: ReadonlySet<string>
  cones: ReadonlySet<string>
  /** Lazily computed distance maps (cell key → moves to reach the target), one per target index. */
  distances: Map<number, Map<string, number>>
}

export type MoveKind = 'offroad' | 'wrongway' | 'blocked' | 'ok'

export interface MoveAnalysis {
  move: RelativeMove
  dir: Heading
  /** Cell the car would enter. */
  cell: Cell
  kind: MoveKind
  nextCellHazard: HazardKind | 'none'
  /** Moves to the next checkpoint through this move (null unless kind === 'ok'). */
  routeLength: number | null
  /** 0 unless kind === 'ok'. */
  straightRun: number
  firstOilAt: number | null
  /** How the route turns right after its straight run (null when the run reaches the cap). */
  turnAfterRun: 'left' | 'right' | null
  /** 1-based route index of the cones that block this move (kind === 'blocked'). */
  coneAt: number | null
  speed: SpeedMode | null
}

export interface CellAnalysis {
  cell: Cell
  heading: Heading
  /** Index into graph.targets of the next checkpoint (last index = finish line). */
  target: number
  targetCell: Cell
  targetIsFinish: boolean
  /** forward, left, right — in that order. */
  moves: MoveAnalysis[]
  validMoves: RelativeMove[]
  /** Shortest valid move (ties: forward > left > right); null when nothing is valid. */
  bestMove: RelativeMove | null
}

const ROUTE_CELLS = Math.max(RULES.SPEED.LOOKAHEAD, RULES.STRAIGHT_RUN_CAP)

export function createContext(track: TrackDefinition, hazards: readonly Hazard[]): SimContext {
  const oil = new Set<string>()
  const cones = new Set<string>()
  for (const h of hazards) (h.kind === 'oil' ? oil : cones).add(cellKey(h.cell))
  return { track, graph: getRaceGraph(track), oil, cones, distances: new Map() }
}

/** Moves from every cell to target `index`, driving in race direction and never through cones. */
export function distancesTo(ctx: SimContext, index: number): Map<string, number> {
  let dist = ctx.distances.get(index)
  if (dist) return dist
  dist = new Map<string, number>()
  const target = ctx.graph.targets[index]
  dist.set(cellKey(target), 0)
  const queue: Cell[] = [target]
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]
    const d = dist.get(cellKey(cur))!
    for (const dir of ctx.graph.incoming.get(cellKey(cur)) ?? []) {
      const prev = neighbor(cur, dir)
      const key = cellKey(prev)
      if (dist.has(key) || ctx.cones.has(key)) continue
      dist.set(key, d + 1)
      queue.push(prev)
    }
  }
  ctx.distances.set(index, dist)
  return dist
}

function targetIndex(ctx: SimContext, cell: Cell): number {
  const t = ctx.graph.targetOf.get(cellKey(cell))
  if (t === undefined) throw new Error(`Cell (${cell.x},${cell.y}) is not on track "${ctx.track.id}"`)
  return t
}

/** Route length of the move from `cell` in absolute direction `dir`, or null when it is not a valid move. */
function routeLength(ctx: SimContext, cell: Cell, dir: Heading, target: number): number | null {
  if (!(ctx.graph.outgoing.get(cellKey(cell)) ?? []).includes(dir)) return null
  const next = neighbor(cell, dir)
  if (ctx.cones.has(cellKey(next))) return null
  const d = distancesTo(ctx, target).get(cellKey(next))
  return d === undefined ? null : d + 1
}

/** Best continuation from a cell (ties: forward > left > right), or null when every move is invalid. */
export function bestStep(ctx: SimContext, cell: Cell, heading: Heading): { move: RelativeMove; dir: Heading; length: number } | null {
  const target = targetIndex(ctx, cell)
  let best: { move: RelativeMove; dir: Heading; length: number } | null = null
  for (const move of RELATIVE_MOVES) {
    const dir = turn(heading, move)
    const length = routeLength(ctx, cell, dir, target)
    if (length !== null && (best === null || length < best.length)) best = { move, dir, length }
  }
  return best
}

/** Route cells r1..rN after entering `first` with heading `dir`, following the best continuation. */
function followRoute(ctx: SimContext, first: Cell, dir: Heading): { cells: Cell[]; turns: RelativeMove[] } {
  const cells = [first]
  const turns: RelativeMove[] = []
  let cur = first
  let heading = dir
  while (cells.length < ROUTE_CELLS) {
    const step = bestStep(ctx, cur, heading)
    if (!step) break
    turns.push(step.move)
    cur = neighbor(cur, step.dir)
    heading = step.dir
    cells.push(cur)
  }
  return { cells, turns }
}

/** Index (1-based) of the cones along the single road that starts at `first`. */
function conesIndex(ctx: SimContext, first: Cell): number | null {
  let cur = first
  for (let i = 1; i <= ctx.graph.tiles.size; i++) {
    if (ctx.cones.has(cellKey(cur))) return i
    const out = ctx.graph.outgoing.get(cellKey(cur)) ?? []
    if (out.length !== 1) return null
    cur = neighbor(cur, out[0])
  }
  return null
}

function hazardAt(ctx: SimContext, cell: Cell): HazardKind | 'none' {
  const key = cellKey(cell)
  return ctx.cones.has(key) ? 'cones' : ctx.oil.has(key) ? 'oil' : 'none'
}

function analyzeMove(ctx: SimContext, cell: Cell, heading: Heading, move: RelativeMove, target: number): MoveAnalysis {
  const dir = turn(heading, move)
  const next = neighbor(cell, dir)
  const tile = ctx.graph.tiles.get(cellKey(cell))
  const base: MoveAnalysis = {
    move,
    dir,
    cell: next,
    kind: 'offroad',
    nextCellHazard: 'none',
    routeLength: null,
    straightRun: 0,
    firstOilAt: null,
    turnAfterRun: null,
    coneAt: null,
    speed: null,
  }
  if (!tile || !tile.exits.includes(dir)) return base
  if (!(ctx.graph.outgoing.get(cellKey(cell)) ?? []).includes(dir)) return { ...base, kind: 'wrongway', nextCellHazard: hazardAt(ctx, next) }
  const nextCellHazard = hazardAt(ctx, next)
  const length = routeLength(ctx, cell, dir, target)
  if (length === null) return { ...base, kind: 'blocked', nextCellHazard, coneAt: conesIndex(ctx, next) }

  const route = followRoute(ctx, next, dir)
  let straightRun = 1
  while (straightRun < RULES.STRAIGHT_RUN_CAP && route.turns[straightRun - 1] === 'forward') straightRun++
  const after = route.turns[straightRun - 1]
  const turnAfterRun = straightRun < RULES.STRAIGHT_RUN_CAP && (after === 'left' || after === 'right') ? after : null
  let firstOilAt: number | null = null
  for (let i = 0; i < Math.min(RULES.SPEED.LOOKAHEAD, route.cells.length); i++) {
    if (ctx.oil.has(cellKey(route.cells[i]))) {
      firstOilAt = i + 1
      break
    }
  }
  return {
    ...base,
    kind: 'ok',
    nextCellHazard,
    routeLength: length,
    straightRun,
    firstOilAt,
    turnAfterRun,
    speed: correctSpeed(straightRun, firstOilAt),
  }
}

/** Full analysis of the decision a car faces at `cell` with `heading`. */
export function analyzeCell(ctx: SimContext, cell: Cell, heading: Heading): CellAnalysis {
  const target = targetIndex(ctx, cell)
  const moves = RELATIVE_MOVES.map((m) => analyzeMove(ctx, cell, heading, m, target))
  const valid = moves.filter((m) => m.kind === 'ok')
  let best: MoveAnalysis | null = null
  for (const m of valid) if (best === null || m.routeLength! < best.routeLength!) best = m
  return {
    cell,
    heading,
    target,
    targetCell: ctx.graph.targets[target],
    targetIsFinish: target === ctx.graph.targets.length - 1,
    moves,
    validMoves: valid.map((m) => m.move),
    bestMove: best ? best.move : null,
  }
}

/** Headings a car can legally have on a cell (one per incoming race edge). */
export function arrivalHeadings(graph: RaceGraph, cell: Cell): Heading[] {
  return (graph.incoming.get(cellKey(cell)) ?? []).map(opposite)
}
