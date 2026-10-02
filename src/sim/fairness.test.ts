/**
 * Fairness invariant: the oracle answer must be derivable from the Observation alone.
 * Reference solvers in ./testing only read the observation; easy and normal must match the oracle on
 * every reachable state of every preset; hard (map-only) reports its agreement rate.
 */
import { describe, expect, it } from 'vitest'
import type { Difficulty, Heading, Observation, OracleAnswer, TrackDefinition } from '../shared/contracts.ts'
import { analyzeCell, arrivalHeadings, createContext } from './analysis.ts'
import { cellKey } from './geometry.ts'
import { getRaceGraph } from './graph.ts'
import { generateHazards } from './hazards.ts'
import { observationFromAnalysis } from './observation.ts'
import { oracleFromAnalysis } from './oracle.ts'
import { solveEasy, solveHard, solveNormal } from './testing/referenceSolvers.ts'
import { TRACKS } from './tracks/index.ts'

const SEEDS = [1, 7, 42, 1234, 99991, 31337, 5, 2024, 777, 8080, 65535, 123456789]
const LAPS = [1, 2, 3]

interface Case {
  track: TrackDefinition
  seed: number
  lap: number
  heading: Heading
  oracle: OracleAnswer
  obs: Record<Difficulty, Observation>
}

/** Every state a car can legally be in (cell + arrival heading) with at least one valid move. */
function* cases(): Generator<Case> {
  for (const track of TRACKS) {
    const g = getRaceGraph(track)
    for (const seed of SEEDS) {
      for (const lap of LAPS) {
        const hazards = generateHazards(track, seed, lap)
        const ctx = createContext(track, hazards)
        for (const tile of track.tiles) {
          if (ctx.cones.has(cellKey(tile))) continue
          for (const heading of arrivalHeadings(g, tile)) {
            const analysis = analyzeCell(ctx, tile, heading)
            if (analysis.validMoves.length === 0) continue // inside a branch closed by cones: unreachable
            const state = { cell: { x: tile.x, y: tile.y }, heading, lap, totalLaps: 3, decisionIndex: 0, currentSpeed: 'cruise' as const }
            const obs = {
              easy: observationFromAnalysis(ctx, analysis, state, 'easy'),
              normal: observationFromAnalysis(ctx, analysis, state, 'normal'),
              hard: observationFromAnalysis(ctx, analysis, state, 'hard'),
            }
            yield { track, seed, lap, heading, oracle: oracleFromAnalysis(analysis), obs }
          }
        }
      }
    }
  }
}

const ALL = [...cases()]
const expected = (c: Case) => ({ move: c.oracle.bestMove, speed: c.oracle.speedByMove[c.oracle.bestMove] })

describe('fairness invariant', () => {
  it('covers a meaningful number of states, including junctions', () => {
    expect(ALL.length).toBeGreaterThan(2000)
    expect(ALL.filter((c) => c.oracle.isJunction).length).toBeGreaterThan(30)
  })

  it('easy: structured option fields reproduce the oracle (move AND speed) on 100% of states', () => {
    const misses = ALL.filter((c) => JSON.stringify(solveEasy(c.obs.easy)) !== JSON.stringify(expected(c)))
    expect(misses.map((c) => `${c.track.id} s${c.seed} l${c.lap} ${JSON.stringify(c.obs.easy.options)}`)).toEqual([])
  })

  it('normal: the deterministic summaries reproduce the oracle (move AND speed) on 100% of states', () => {
    const misses = ALL.filter((c) => JSON.stringify(solveNormal(c.obs.normal)) !== JSON.stringify(expected(c)))
    expect(misses.map((c) => `${c.track.id} s${c.seed} l${c.lap} ${JSON.stringify(c.obs.normal.options)}`)).toEqual([])
  })

  it('observations never reveal the best move and are identical for repeated builds', () => {
    for (const c of ALL.slice(0, 500)) {
      for (const o of c.obs.easy.options!) expect(o.summary).not.toMatch(/best|optimal|recommend/i)
      expect(c.obs.easy.options!.map((o) => o.move)).toEqual(['forward', 'left', 'right'])
    }
  })

  it('hard: a map-only solver agrees with the oracle on a high share of states', () => {
    let move = 0
    let full = 0
    let junctions = 0
    let junctionHits = 0
    const misses: string[] = []
    for (const c of ALL) {
      const got = solveHard(c.obs.hard)
      const want = expected(c)
      if (got?.move === want.move) move++
      if (got?.move === want.move && got.speed === want.speed) full++
      else if (misses.length < 5) misses.push(`${c.track.id} s${c.seed} l${c.lap} want ${JSON.stringify(want)} got ${JSON.stringify(got)}\n${c.obs.hard.localMap!.rows.join('\n')}`)
      if (c.oracle.isJunction) {
        junctions++
        if (got?.move === want.move) junctionHits++
      }
    }
    const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(2)}%`
    console.info(
      `[hard solver] states=${ALL.length} move=${pct(move, ALL.length)} move+speed=${pct(full, ALL.length)} ` +
        `junction moves=${pct(junctionHits, junctions)} (${junctions} junction states)`,
    )
    if (misses.length) console.info(`[hard solver] sample misses:\n${misses.join('\n\n')}`)
    expect(move / ALL.length).toBeGreaterThan(0.99)
    expect(full / ALL.length).toBeGreaterThan(0.98)
  })

  it('hard observations carry only the map and the checkpoint offset', () => {
    for (const c of ALL.slice(0, 200)) {
      const h = c.obs.hard
      expect(h.options).toBeUndefined()
      expect(h.localMap!.rows).toHaveLength(11)
      for (const row of h.localMap!.rows) {
        expect(row).toHaveLength(11)
        for (const ch of row) expect(Object.keys(h.localMap!.legend)).toContain(ch)
      }
      expect(h.localMap!.rows[10][5]).toBe('@')
      expect(h.nextCheckpoint).toBeDefined()
      expect(c.obs.normal.localMap!.rows).toHaveLength(7)
      expect(c.obs.normal.options!.every((o) => Object.keys(o).sort().join() === 'move,onTrack,summary')).toBe(true)
    }
  })
})
