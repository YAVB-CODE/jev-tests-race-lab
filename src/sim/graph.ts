/**
 * Directed race graph derived from a track's tiles and its start heading.
 *
 * Every simple lap (start → … → start, no U-turns, no repeated cell) is enumerated; the direction in
 * which those laps traverse each road edge is the race direction. Driving an edge the other way is
 * "wrong-way". This also validates the layout (closed loop, no dead ends, checkpoints on every lap…).
 */
import type { Cell, Heading, TrackDefinition, TrackTile } from '../shared/contracts.ts'
import { HEADINGS } from '../shared/contracts.ts'
import { cellKey, neighbor, opposite, sameCell, turnLeft, turnRight } from './geometry.ts'

/** A track before its derived fields (lapLength, hasForks) are known. */
export type TrackLayout = Omit<TrackDefinition, 'lapLength' | 'hasForks'>

export interface ForkBranch {
  /** Absolute direction leaving the fork cell. */
  dir: Heading
  /** Cells strictly between the fork and the merge, in race order (never empty). */
  cells: Cell[]
  /** Moves from the fork cell to the merge cell through this branch. */
  length: number
}

export interface ForkInfo {
  fork: Cell
  merge: Cell
  /** Exactly two branches. */
  branches: ForkBranch[]
  /** Index of the shorter branch (ties: the first). */
  shortcut: number
}

export interface RaceGraph {
  layout: TrackLayout
  tiles: ReadonlyMap<string, TrackTile>
  /** Exits in race direction. */
  outgoing: ReadonlyMap<string, readonly Heading[]>
  /** Exits against race direction (where cars come from). */
  incoming: ReadonlyMap<string, readonly Heading[]>
  /** Route targets: checkpoints in order, then the start/finish cell. */
  targets: readonly Cell[]
  /** Index into `targets` of the next target of a car standing on each cell. */
  targetOf: ReadonlyMap<string, number>
  /** Cells that every lap goes through. */
  trunk: ReadonlySet<string>
  forks: readonly ForkInfo[]
  /** Every simple lap, as the ordered cells starting at the start cell. */
  laps: readonly Cell[][]
  lapLength: number
  /** Shortest distance (moves, ignoring hazards) from each cell to the finish; start = lapLength. */
  distToFinish: ReadonlyMap<string, number>
}

const MAX_LAPS = 4096

function fail(trackId: string, message: string): never {
  throw new Error(`Track "${trackId}": ${message}`)
}

function fmt(cell: Cell): string {
  return `(${cell.x},${cell.y})`
}

/** Builds and validates the race graph. Throws a descriptive Error on any inconsistency. */
export function buildRaceGraph(layout: TrackLayout): RaceGraph {
  const id = layout.id
  const tiles = new Map<string, TrackTile>()
  for (const tile of layout.tiles) {
    const key = cellKey(tile)
    if (tiles.has(key)) fail(id, `duplicate tile at ${fmt(tile)}`)
    if (tile.x < 0 || tile.y < 0 || tile.x >= layout.width || tile.y >= layout.height) {
      fail(id, `tile ${fmt(tile)} is outside the ${layout.width}x${layout.height} grid`)
    }
    tiles.set(key, tile)
  }
  if (tiles.size === 0) fail(id, 'no road tiles')

  // Local consistency: 2–3 exits, symmetric connections, no unintended adjacency.
  for (const tile of tiles.values()) {
    if (tile.exits.length < 2 || tile.exits.length > 3) {
      fail(id, `tile ${fmt(tile)} has ${tile.exits.length} exits (expected 2 or 3)`)
    }
    if (new Set(tile.exits).size !== tile.exits.length) fail(id, `tile ${fmt(tile)} repeats an exit`)
    for (const dir of HEADINGS) {
      const other = tiles.get(cellKey(neighbor(tile, dir)))
      const linked = tile.exits.includes(dir)
      if (linked && !other) fail(id, `tile ${fmt(tile)} has an exit ${dir} into off-track cell ${fmt(neighbor(tile, dir))}`)
      if (linked && other && !other.exits.includes(opposite(dir))) {
        fail(id, `tile ${fmt(tile)} exits ${dir} but ${fmt(other)} does not connect back`)
      }
      if (!linked && other && other.exits.includes(opposite(dir))) {
        fail(id, `tile ${fmt(other)} exits ${opposite(dir)} but ${fmt(tile)} does not connect back`)
      }
      if (!linked && other) {
        fail(id, `road tiles ${fmt(tile)} and ${fmt(other)} are adjacent but not connected (ambiguous map)`)
      }
    }
  }

  // Start and checkpoints.
  const start = layout.start
  const startTile = tiles.get(cellKey(start.cell))
  if (!startTile) fail(id, `start ${fmt(start.cell)} is not a road tile`)
  if (startTile.kind !== 'start') fail(id, `start tile ${fmt(start.cell)} must have kind "start"`)
  if (startTile.exits.length !== 2 || !startTile.exits.includes(start.heading) || !startTile.exits.includes(opposite(start.heading))) {
    fail(id, `start tile ${fmt(start.cell)} must be a straight aligned with the start heading ${start.heading}`)
  }
  const starts = [...tiles.values()].filter((t) => t.kind === 'start')
  if (starts.length !== 1) fail(id, `expected exactly one start tile, found ${starts.length}`)
  if (layout.checkpoints.length === 0) fail(id, 'at least one checkpoint is required')
  layout.checkpoints.forEach((cp, i) => {
    const tile = tiles.get(cellKey(cp))
    if (!tile) fail(id, `checkpoint ${i + 1} ${fmt(cp)} is not a road tile`)
    if (tile.kind !== 'checkpoint' || tile.checkpointIndex !== i) {
      fail(id, `tile ${fmt(cp)} must be kind "checkpoint" with checkpointIndex ${i}`)
    }
    if (tile.exits.length !== 2) fail(id, `checkpoint ${i + 1} ${fmt(cp)} must not be a fork or merge`)
  })
  const cpTiles = [...tiles.values()].filter((t) => t.kind === 'checkpoint')
  if (cpTiles.length !== layout.checkpoints.length) fail(id, 'checkpoint tiles do not match the checkpoints list')

  // Enumerate every simple lap (DFS without U-turns).
  const laps: Cell[][] = []
  const path: Cell[] = [start.cell]
  const visited = new Set<string>([cellKey(start.cell)])
  const dfs = (cell: Cell, heading: Heading): void => {
    const tile = tiles.get(cellKey(cell))!
    for (const dir of [heading, turnLeft(heading), turnRight(heading)]) {
      if (!tile.exits.includes(dir)) continue
      const next = neighbor(cell, dir)
      if (sameCell(next, start.cell)) {
        if (dir === start.heading) {
          laps.push([...path])
          if (laps.length > MAX_LAPS) fail(id, `more than ${MAX_LAPS} distinct laps; simplify the layout`)
        }
        continue
      }
      const key = cellKey(next)
      if (visited.has(key)) continue
      visited.add(key)
      path.push(next)
      dfs(next, dir)
      path.pop()
      visited.delete(key)
    }
  }
  dfs(start.cell, start.heading)
  if (laps.length === 0) fail(id, 'the road does not form a closed loop back to the start in race direction')

  // Orient edges from the laps.
  const outgoing = new Map<string, Heading[]>()
  const incoming = new Map<string, Heading[]>()
  for (const key of tiles.keys()) {
    outgoing.set(key, [])
    incoming.set(key, [])
  }
  for (const lap of laps) {
    for (let i = 0; i < lap.length; i++) {
      const a = lap[i]
      const b = lap[(i + 1) % lap.length]
      const dir = HEADINGS.find((h) => sameCell(neighbor(a, h), b))!
      const outA = outgoing.get(cellKey(a))!
      if (!outA.includes(dir)) outA.push(dir)
      const inB = incoming.get(cellKey(b))!
      if (!inB.includes(opposite(dir))) inB.push(opposite(dir))
    }
  }
  for (const tile of tiles.values()) {
    const key = cellKey(tile)
    const out = outgoing.get(key)!
    const inc = incoming.get(key)!
    for (const dir of tile.exits) {
      const isOut = out.includes(dir)
      const isIn = inc.includes(dir)
      if (isOut && isIn) fail(id, `edge ${fmt(tile)} → ${dir} is driven in both directions by different laps`)
      if (!isOut && !isIn) fail(id, `edge ${fmt(tile)} → ${dir} is never driven by any lap (dead end or unreachable road)`)
    }
    out.sort((p, q) => HEADINGS.indexOf(p) - HEADINGS.indexOf(q))
    inc.sort((p, q) => HEADINGS.indexOf(p) - HEADINGS.indexOf(q))
  }

  // Trunk = cells on every lap; checkpoints must be on every lap, in order.
  const trunk = new Set<string>(laps[0].map(cellKey))
  for (const lap of laps.slice(1)) {
    const keys = new Set(lap.map(cellKey))
    for (const key of [...trunk]) if (!keys.has(key)) trunk.delete(key)
  }
  const targets: Cell[] = [...layout.checkpoints, start.cell]
  const targetOf = new Map<string, number>()
  for (const lap of laps) {
    let last = -1
    for (const cp of layout.checkpoints) {
      const at = lap.findIndex((c) => sameCell(c, cp))
      if (at < 0) fail(id, `checkpoint ${fmt(cp)} is not on every lap (it must be on the main line)`)
      if (at <= last) fail(id, `checkpoint ${fmt(cp)} is out of order along the race direction`)
      last = at
    }
    let next = targets.length - 1
    for (let i = lap.length - 1; i >= 0; i--) {
      const key = cellKey(lap[i])
      const prev = targetOf.get(key)
      if (prev !== undefined && prev !== next) fail(id, `cell ${fmt(lap[i])} has an ambiguous next checkpoint`)
      targetOf.set(key, next)
      const cpIndex = layout.checkpoints.findIndex((c) => sameCell(c, lap[i]))
      if (cpIndex >= 0) next = cpIndex
    }
  }

  // Forks: one input, two outputs; both branches must rejoin at the same merge.
  const forks: ForkInfo[] = []
  for (const key of orderedCells(laps)) {
    const tile = tiles.get(key)!
    const out = outgoing.get(key)!
    const inc = incoming.get(key)!
    if (tile.exits.length === 3 && !((out.length === 2 && inc.length === 1) || (out.length === 1 && inc.length === 2))) {
      fail(id, `junction ${fmt(tile)} must be a fork (1 in, 2 out) or a merge (2 in, 1 out)`)
    }
    if (out.length !== 2) continue
    if (!trunk.has(key)) fail(id, `fork ${fmt(tile)} lies inside another fork's branch (nested forks are not supported)`)
    const branches: ForkBranch[] = []
    let merge: Cell | null = null
    for (const dir of out) {
      const cells: Cell[] = []
      let cur = neighbor(tile, dir)
      let length = 1
      while (incoming.get(cellKey(cur))!.length === 1) {
        if (outgoing.get(cellKey(cur))!.length !== 1) fail(id, `branch from fork ${fmt(tile)} contains another fork at ${fmt(cur)}`)
        if (tiles.get(cellKey(cur))!.kind !== 'road') fail(id, `branch from fork ${fmt(tile)} contains a start/checkpoint tile ${fmt(cur)}`)
        cells.push(cur)
        cur = neighbor(cur, outgoing.get(cellKey(cur))![0])
        length++
        if (length > tiles.size) fail(id, `branch from fork ${fmt(tile)} never rejoins`)
      }
      if (cells.length === 0) fail(id, `fork ${fmt(tile)} connects directly to merge ${fmt(cur)}; every branch needs at least one cell`)
      if (merge && !sameCell(merge, cur)) fail(id, `branches of fork ${fmt(tile)} rejoin at different cells`)
      merge = cur
      branches.push({ dir, cells, length })
    }
    const shortcut = branches[1].length < branches[0].length ? 1 : 0
    forks.push({ fork: { x: tile.x, y: tile.y }, merge: merge!, branches, shortcut })
  }

  const lapLength = Math.min(...laps.map((l) => l.length))

  // Distance to the finish line ignoring hazards (used for progress).
  const distToFinish = new Map<string, number>()
  const startKey = cellKey(start.cell)
  distToFinish.set(startKey, 0)
  const queue: Cell[] = [start.cell]
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]
    const d = distToFinish.get(cellKey(cur))!
    for (const dir of incoming.get(cellKey(cur))!) {
      const prev = neighbor(cur, dir)
      const pk = cellKey(prev)
      if (pk === startKey || distToFinish.has(pk)) continue
      distToFinish.set(pk, d + 1)
      queue.push(prev)
    }
  }
  distToFinish.set(startKey, lapLength)

  return { layout, tiles, outgoing, incoming, targets, targetOf, trunk, forks, laps, lapLength, distToFinish }
}

/** Cell keys in first-seen order along the laps (stable fork ordering). */
function orderedCells(laps: Cell[][]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const lap of laps) {
    for (const cell of lap) {
      const key = cellKey(cell)
      if (!seen.has(key)) {
        seen.add(key)
        order.push(key)
      }
    }
  }
  return order
}

const cache = new WeakMap<TrackDefinition, RaceGraph>()

/** Cached race graph of a track definition. */
export function getRaceGraph(track: TrackDefinition): RaceGraph {
  let graph = cache.get(track)
  if (!graph) {
    graph = buildRaceGraph(track)
    cache.set(track, graph)
  }
  return graph
}

/**
 * Full validation of a track definition (closed loop, start, checkpoints, 2–3 exits, unambiguous
 * adjacency, consistent lapLength / hasForks). Throws a descriptive Error.
 */
export function validateTrack(track: TrackDefinition): RaceGraph {
  const graph = buildRaceGraph(track)
  if (graph.lapLength !== track.lapLength) {
    fail(track.id, `lapLength is ${track.lapLength} but the shortest lap is ${graph.lapLength} cells`)
  }
  if ((graph.forks.length > 0) !== track.hasForks) fail(track.id, `hasForks must be ${graph.forks.length > 0}`)
  cache.set(track, graph)
  return graph
}

/** Race-direction exits of a cell (empty when off-track). Handy for drawing direction arrows. */
export function raceExits(track: TrackDefinition, cell: Cell): readonly Heading[] {
  return getRaceGraph(track).outgoing.get(cellKey(cell)) ?? []
}
