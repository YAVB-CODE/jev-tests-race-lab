import { describe, expect, it } from 'vitest'
import { HEADINGS } from '../shared/contracts.ts'
import { HAZARD_TUNING, generateHazards } from './hazards.ts'
import { analyzeCell, arrivalHeadings, createContext } from './analysis.ts'
import { cellKey, neighbor, sameCell, turn } from './geometry.ts'
import { getRaceGraph } from './graph.ts'
import { TRACKS } from './tracks/index.ts'

const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 1)
const LAPS = [1, 2, 3, 4, 5]

describe('generateHazards', () => {
  it('is deterministic for (seed, track, lap) and varies across laps and seeds', () => {
    for (const track of TRACKS) {
      expect(generateHazards(track, 42, 1)).toEqual(generateHazards(track, 42, 1))
      const variants = new Set(LAPS.map((lap) => JSON.stringify(generateHazards(track, 42, lap))))
      expect(variants.size).toBeGreaterThan(1)
      expect(JSON.stringify(generateHazards(track, 1, 1))).not.toBe(JSON.stringify(generateHazards(track, 2, 1)))
    }
  })

  it('places a few oil cells and cones only on fork branches (at most one branch per fork)', () => {
    for (const track of TRACKS) {
      const g = getRaceGraph(track)
      const afterStart = neighbor(track.start.cell, track.start.heading)
      let conesSeen = 0
      for (const seed of SEEDS) {
        for (const lap of LAPS) {
          const hazards = generateHazards(track, seed, lap)
          const oil = hazards.filter((h) => h.kind === 'oil')
          const cones = hazards.filter((h) => h.kind === 'cones')
          expect(oil.length).toBeGreaterThanOrEqual(HAZARD_TUNING.MIN_OIL)
          expect(oil.length).toBeLessThanOrEqual(HAZARD_TUNING.MAX_OIL)
          conesSeen += cones.length
          const keys = hazards.map((h) => cellKey(h.cell))
          expect(new Set(keys).size).toBe(keys.length)
          for (const h of hazards) {
            const tile = g.tiles.get(cellKey(h.cell))!
            expect(tile).toBeDefined()
            expect(tile.kind).toBe('road')
            expect(sameCell(h.cell, track.start.cell) || sameCell(h.cell, afterStart)).toBe(false)
            // never adjacent to another hazard
            for (const dir of HEADINGS) {
              expect(keys.includes(cellKey(neighbor(h.cell, dir)))).toBe(false)
            }
          }
          for (const c of cones) expect(g.trunk.has(cellKey(c.cell))).toBe(false)
          for (const fork of g.forks) {
            const blocked = fork.branches.filter((b) => b.cells.some((cell) => cones.some((c) => sameCell(c.cell, cell))))
            expect(blocked.length).toBeLessThanOrEqual(1)
          }
        }
      }
      if (track.hasForks) expect(conesSeen).toBeGreaterThan(0)
      else expect(conesSeen).toBe(0)
    }
  })

  it('never makes the race unsolvable: every reachable state has a valid move and a lap can be driven', () => {
    for (const track of TRACKS) {
      const g = getRaceGraph(track)
      for (const seed of SEEDS) {
        for (const lap of LAPS) {
          const hazards = generateHazards(track, seed, lap)
          const ctx = createContext(track, hazards)
          // drive one lap following the oracle from the start
          let cell = track.start.cell
          let heading = track.start.heading
          let steps = 0
          do {
            const a = analyzeCell(ctx, cell, heading)
            expect(a.bestMove).not.toBeNull()
            heading = turn(heading, a.bestMove!)
            cell = neighbor(cell, heading)
            expect(ctx.cones.has(cellKey(cell))).toBe(false)
            steps++
          } while (!sameCell(cell, track.start.cell) && steps < track.lapLength * 3)
          expect(sameCell(cell, track.start.cell)).toBe(true)
          expect(steps).toBeGreaterThanOrEqual(track.lapLength)
          expect(steps).toBeLessThanOrEqual(Math.max(...g.laps.map((l) => l.length)))
          if (!hazards.some((h) => h.kind === 'cones')) expect(steps).toBe(track.lapLength)
          // every trunk state has at least one valid move
          for (const key of g.trunk) {
            const tile = g.tiles.get(key)!
            for (const h of arrivalHeadings(g, tile)) {
              expect(analyzeCell(ctx, tile, h).validMoves.length).toBeGreaterThan(0)
            }
          }
        }
      }
    }
  })

  it('both lanes see the same hazards (pure function of seed/track/lap)', () => {
    const track = TRACKS[2]
    const a = Array.from({ length: 4 }, (_, i) => generateHazards(track, 99, i + 1))
    const b = Array.from({ length: 4 }, (_, i) => generateHazards(track, 99, i + 1))
    expect(a).toEqual(b)
  })
})
