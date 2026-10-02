/**
 * Per-lap hazards, deterministic for (seed, track, lap) so both lanes race the same obstacles.
 *
 * - Cones: per fork, maybe block ONE branch (never both, never the main line), on one of the first two
 *   cells of the branch so they are visible from the fork in every observation mode.
 * - Oil: a few cells, weighted towards straights and curve entries (where the speed choice matters).
 *   Never on start/checkpoints/junctions, never next to another hazard, a checkpoint or a junction —
 *   which keeps the race direction of every cell inferable from the egocentric map.
 */
import type { Cell, Hazard, TrackDefinition, TrackTile } from '../shared/contracts.ts'
import { HEADINGS } from '../shared/contracts.ts'
import { createRng, hashSeed, randInt } from '../shared/rng.ts'
import { cellKey, neighbor, opposite } from './geometry.ts'
import { getRaceGraph } from './graph.ts'

export const HAZARD_TUNING = {
  /** Chance that a fork gets one branch closed by cones on a given lap. */
  CONE_PROBABILITY: 0.55,
  /** When a fork is blocked, chance that the closed branch is the shortcut. */
  SHORTCUT_BIAS: 0.65,
  /** Roughly one oil cell every N cells of lap. */
  CELLS_PER_OIL: 16,
  MIN_OIL: 2,
  MAX_OIL: 5,
} as const

function isStraight(tile: TrackTile): boolean {
  return tile.exits.length === 2 && tile.exits[0] === opposite(tile.exits[1])
}

export function generateHazards(track: TrackDefinition, seed: number, lap: number): Hazard[] {
  const graph = getRaceGraph(track)
  const rand = createRng(hashSeed(seed, track.id, 'hazards', lap))
  const startKey = cellKey(track.start.cell)
  const afterStartKey = cellKey(neighbor(track.start.cell, track.start.heading))
  const hazards: Hazard[] = []
  const taken = new Set<string>()

  for (const fork of graph.forks) {
    // Always draw the same amount of numbers per fork so the stream stays aligned.
    const block = rand() < HAZARD_TUNING.CONE_PROBABILITY
    const shortcut = rand() < HAZARD_TUNING.SHORTCUT_BIAS
    const slot = rand()
    if (!block) continue
    const branch = fork.branches[shortcut ? fork.shortcut : 1 - fork.shortcut]
    const options = branch.cells.slice(0, 2).filter((c) => cellKey(c) !== startKey && cellKey(c) !== afterStartKey)
    if (options.length === 0) continue
    const cell = options[Math.min(options.length - 1, Math.floor(slot * options.length))]
    hazards.push({ cell: { ...cell }, kind: 'cones' })
    taken.add(cellKey(cell))
  }

  const avoid = new Set<string>([startKey, afterStartKey])
  for (const tile of graph.tiles.values()) {
    if (tile.kind !== 'road' || tile.exits.length === 3) {
      avoid.add(cellKey(tile))
      for (const dir of HEADINGS) avoid.add(cellKey(neighbor(tile, dir)))
    }
  }
  const candidates: Array<{ cell: Cell; weight: number }> = []
  for (const tile of graph.tiles.values()) {
    const key = cellKey(tile)
    if (avoid.has(key) || taken.has(key)) continue
    const out = graph.outgoing.get(key)![0]
    const next = graph.tiles.get(cellKey(neighbor(tile, out)))!
    const straight = isStraight(tile)
    const curveEntry = straight && !isStraight(next)
    candidates.push({ cell: { x: tile.x, y: tile.y }, weight: straight ? (curveEntry ? 4 : 3) : 1 })
  }

  const target = Math.round(track.lapLength / HAZARD_TUNING.CELLS_PER_OIL) + randInt(rand, 0, 1)
  const count = Math.max(HAZARD_TUNING.MIN_OIL, Math.min(HAZARD_TUNING.MAX_OIL, target))
  const nearTaken = (cell: Cell): boolean =>
    taken.has(cellKey(cell)) || HEADINGS.some((dir) => taken.has(cellKey(neighbor(cell, dir))))
  for (let i = 0; i < count; i++) {
    const pool = candidates.filter((c) => !nearTaken(c.cell))
    if (pool.length === 0) break
    const total = pool.reduce((sum, c) => sum + c.weight, 0)
    let r = rand() * total
    let pick = pool[pool.length - 1]
    for (const c of pool) {
      r -= c.weight
      if (r < 0) {
        pick = c
        break
      }
    }
    hazards.push({ cell: { ...pick.cell }, kind: 'oil' })
    taken.add(cellKey(pick.cell))
  }
  return hazards
}
