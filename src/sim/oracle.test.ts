import { describe, expect, it } from 'vitest'
import type { Hazard } from '../shared/contracts.ts'
import { computeOracle } from './oracle.ts'
import { getTrack } from './tracks/index.ts'

const oval = getTrack('ovalo')
const forks = getTrack('bifurcaciones')
const oil = (x: number, y: number): Hazard => ({ cell: { x, y }, kind: 'oil' })
const cones = (x: number, y: number): Hazard => ({ cell: { x, y }, kind: 'cones' })

describe('computeOracle — Óvalo (top straight runs E from x=1 to the corner at x=16)', () => {
  it('start cell: only forward, long straight → boost, route to checkpoint 1', () => {
    const o = computeOracle(oval, [], { x: 4, y: 1 }, 'E')
    expect(o.validMoves).toEqual(['forward'])
    expect(o.bestMove).toBe('forward')
    expect(o.isJunction).toBe(false)
    expect(o.speedByMove).toEqual({ forward: 'boost' })
    // (5..16, 1) = 12 cells, then (16, 2..4) = 3 cells
    expect(o.routeLengthByMove).toEqual({ forward: 15 })
  })

  it('speed follows the straight run before the corner', () => {
    expect(computeOracle(oval, [], { x: 15, y: 1 }, 'E').speedByMove.forward).toBe('slow') // run 1
    expect(computeOracle(oval, [], { x: 14, y: 1 }, 'E').speedByMove.forward).toBe('cruise') // run 2
    expect(computeOracle(oval, [], { x: 13, y: 1 }, 'E').speedByMove.forward).toBe('cruise') // run 3
    expect(computeOracle(oval, [], { x: 12, y: 1 }, 'E').speedByMove.forward).toBe('boost') // run 4
  })

  it('at the corner the only valid move is the turn', () => {
    const o = computeOracle(oval, [], { x: 16, y: 1 }, 'E')
    expect(o.validMoves).toEqual(['right'])
    expect(o.bestMove).toBe('right')
    expect(o.speedByMove.right).toBe('boost') // right side (16, 2..8) is a 7-cell straight
  })

  it('oil within 2 cells forces slow; oil at 3–4 forbids boost', () => {
    expect(computeOracle(oval, [oil(13, 1)], { x: 12, y: 1 }, 'E').speedByMove.forward).toBe('slow')
    expect(computeOracle(oval, [oil(14, 1)], { x: 12, y: 1 }, 'E').speedByMove.forward).toBe('slow')
    expect(computeOracle(oval, [oil(15, 1)], { x: 12, y: 1 }, 'E').speedByMove.forward).toBe('cruise')
    expect(computeOracle(oval, [oil(16, 1)], { x: 12, y: 1 }, 'E').speedByMove.forward).toBe('cruise')
    expect(computeOracle(oval, [oil(9, 1)], { x: 4, y: 1 }, 'E').speedByMove.forward).toBe('boost') // 5th cell
  })

  it('target advances when the car stands on a checkpoint and after the last one', () => {
    // on checkpoint 1 (16,4) → checkpoint 2 (9,8): (16,5..8) = 4, (15..9, 8) = 7
    expect(computeOracle(oval, [], { x: 16, y: 4 }, 'S').routeLengthByMove).toEqual({ forward: 11 })
    // on checkpoint 3 (1,5) → finish (4,1): (1,4..1) = 4, (2..4, 1) = 3
    expect(computeOracle(oval, [], { x: 1, y: 5 }, 'N').routeLengthByMove).toEqual({ forward: 7 })
    // on the start → checkpoint 1 again
    expect(computeOracle(oval, [], { x: 3, y: 1 }, 'E').routeLengthByMove).toEqual({ forward: 1 })
  })
})

describe('computeOracle — Bifurcaciones', () => {
  it('fork A: forward is the shortcut, left the detour, right is off track', () => {
    const o = computeOracle(forks, [], { x: 6, y: 3 }, 'E')
    expect(o.validMoves).toEqual(['forward', 'left'])
    expect(o.isJunction).toBe(true)
    expect(o.bestMove).toBe('forward')
    expect(o.routeLengthByMove).toEqual({ forward: 6, left: 10 })
    expect(o.speedByMove.left).toBe('cruise') // (6,2), (6,1) then curves right
  })

  it('cones on the shortcut make the detour the only valid (and best) move', () => {
    const o = computeOracle(forks, [cones(8, 3)], { x: 6, y: 3 }, 'E')
    expect(o.validMoves).toEqual(['left'])
    expect(o.bestMove).toBe('left')
    expect(o.isJunction).toBe(false)
  })

  it('cones on the detour leave the shortcut', () => {
    const o = computeOracle(forks, [cones(6, 2)], { x: 6, y: 3 }, 'E')
    expect(o.validMoves).toEqual(['forward'])
  })

  it('fork B: forward shortcut vs right detour', () => {
    const o = computeOracle(forks, [], { x: 19, y: 6 }, 'S')
    expect(o.validMoves).toEqual(['forward', 'right'])
    expect(o.bestMove).toBe('forward')
    expect(o.routeLengthByMove.right! - o.routeLengthByMove.forward!).toBe(4)
  })

  it('fork C: no forward exit; right branch is shorter than left', () => {
    const o = computeOracle(forks, [], { x: 14, y: 12 }, 'W')
    expect(o.validMoves).toEqual(['left', 'right'])
    expect(o.bestMove).toBe('right')
    expect(o.routeLengthByMove).toEqual({ left: 12, right: 10 })
    expect(o.speedByMove).toEqual({ left: 'cruise', right: 'slow' })
  })

  it('turning into the other branch at a merge is wrong-way (invalid)', () => {
    // merge A reached from the detour (heading S): right would drive up the shortcut backwards
    expect(computeOracle(forks, [], { x: 10, y: 3 }, 'S').validMoves).toEqual(['left'])
    // merge A reached from the shortcut (heading E): left would drive up the detour backwards
    expect(computeOracle(forks, [], { x: 10, y: 3 }, 'E').validMoves).toEqual(['forward'])
    // merge C reached from the upper branch (heading S): forward is the lower branch backwards
    expect(computeOracle(forks, [], { x: 9, y: 12 }, 'S').validMoves).toEqual(['right'])
  })

  it('speed lookahead follows the best continuation through a fork', () => {
    // 2 cells before fork A: (5,3), fork (6,3), then the shortcut straight → run 5
    expect(computeOracle(forks, [], { x: 4, y: 3 }, 'E').speedByMove.forward).toBe('boost')
    // with the shortcut closed the route turns left at the fork → run 2
    expect(computeOracle(forks, [cones(7, 3)], { x: 4, y: 3 }, 'E').speedByMove.forward).toBe('cruise')
  })
})
