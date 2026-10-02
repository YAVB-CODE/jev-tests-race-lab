import { describe, expect, it } from 'vitest'
import { getRaceGraph, validateTrack } from './graph.ts'
import { cellKey, toEgocentric } from './geometry.ts'
import { TRACKS, getTrack, parseTrack } from './tracks/index.ts'

const spec = (map: string, startHeading: 'N' | 'E' | 'S' | 'W' = 'E') => ({
  id: 'test',
  name: 'Prueba',
  description: 'Circuito de prueba',
  startHeading,
  map,
})

describe('track presets', () => {
  it('ships the three presets with Spanish names', () => {
    expect(TRACKS.map((t) => t.id)).toEqual(['ovalo', 'tecnico', 'bifurcaciones'])
    expect(TRACKS.map((t) => t.name)).toEqual(['Óvalo', 'Técnico', 'Bifurcaciones'])
    for (const t of TRACKS) expect(t.description.length).toBeGreaterThan(10)
  })

  it.each(TRACKS.map((t) => [t.id, t] as const))('%s is valid and within the size budget', (_, track) => {
    expect(() => validateTrack(track)).not.toThrow()
    expect(track.width).toBeGreaterThanOrEqual(14)
    expect(track.width).toBeLessThanOrEqual(22)
    expect(track.height).toBeGreaterThanOrEqual(10)
    expect(track.height).toBeLessThanOrEqual(16)
    expect(track.lapLength).toBeGreaterThanOrEqual(30)
    expect(track.lapLength).toBeLessThanOrEqual(70)
    for (const tile of track.tiles) expect([2, 3]).toContain(tile.exits.length)
    const start = track.tiles.find((t) => t.kind === 'start')!
    expect({ x: start.x, y: start.y }).toEqual(track.start.cell)
    expect(track.checkpoints.length).toBeGreaterThanOrEqual(2)
    track.checkpoints.forEach((cp, i) => {
      const tile = track.tiles.find((t) => t.x === cp.x && t.y === cp.y)!
      expect(tile.kind).toBe('checkpoint')
      expect(tile.checkpointIndex).toBe(i)
    })
  })

  it('every road edge is driven in exactly one direction and checkpoints are on every lap', () => {
    for (const track of TRACKS) {
      const g = getRaceGraph(track)
      for (const tile of track.tiles) {
        const out = g.outgoing.get(cellKey(tile))!
        const inc = g.incoming.get(cellKey(tile))!
        expect(out.length + inc.length).toBe(tile.exits.length)
      }
      for (const lap of g.laps) {
        for (const cp of track.checkpoints) expect(lap.some((c) => c.x === cp.x && c.y === cp.y)).toBe(true)
      }
    }
  })

  it('Óvalo and Técnico have no forks; Bifurcaciones has 2–3 forks with a checkpoint after each merge', () => {
    expect(getTrack('ovalo').hasForks).toBe(false)
    expect(getTrack('tecnico').hasForks).toBe(false)
    const track = getTrack('bifurcaciones')
    const g = getRaceGraph(track)
    expect(track.hasForks).toBe(true)
    expect(g.forks.length).toBeGreaterThanOrEqual(2)
    expect(g.forks.length).toBeLessThanOrEqual(3)
    const targets = g.forks.map((f) => g.targetOf.get(cellKey(f.fork)))
    for (const f of g.forks) {
      // fork and merge aim at the same checkpoint → the comparison spans both whole branches
      expect(g.targetOf.get(cellKey(f.merge))).toBe(g.targetOf.get(cellKey(f.fork)))
      expect(f.branches[0].length).not.toBe(f.branches[1].length)
    }
    expect(new Set(targets).size).toBe(targets.length) // a checkpoint separates consecutive forks
  })

  it('each fork (branches + merge + next checkpoint) fits the 11x11 hard-mode window seen from the fork', () => {
    const track = getTrack('bifurcaciones')
    const g = getRaceGraph(track)
    for (const f of g.forks) {
      const heading = (['N', 'E', 'S', 'W'] as const).find((h) => g.incoming.get(cellKey(f.fork))!.includes(
        ({ N: 'S', S: 'N', E: 'W', W: 'E' } as const)[h],
      ))!
      const cells = [...f.branches.flatMap((b) => b.cells), f.merge, g.targets[g.targetOf.get(cellKey(f.fork))!]]
      for (const c of cells) {
        const o = toEgocentric(f.fork, heading, c)
        expect(o.ahead).toBeGreaterThanOrEqual(0)
        expect(o.ahead).toBeLessThanOrEqual(10)
        expect(Math.abs(o.right)).toBeLessThanOrEqual(5)
      }
    }
  })

  it('getTrack throws for unknown ids', () => {
    expect(() => getTrack('nope')).toThrow(/Unknown track "nope"/)
  })
})

describe('parseTrack validation errors', () => {
  const ok = `
    ..........
    .┌─S────┐.
    .│......│.
    .│......1.
    .└──────┘.
  `

  it('accepts a minimal valid loop', () => {
    const t = parseTrack(spec(ok))
    expect(t.lapLength).toBe(20)
    expect(t.hasForks).toBe(false)
  })

  it('rejects an open loop / dangling exit', () => {
    expect(() =>
      parseTrack(
        spec(`
          .┌─S────┐.
          .│......│.
          .│......1.
          .└──────..
        `),
      ),
    ).toThrow(/exit|loop/)
  })

  it('rejects unintended adjacency between parallel roads', () => {
    expect(() =>
      parseTrack(
        spec(`
          .┌─S────┐.
          .│┌────┐│.
          .└┘....1│.
          .......└┘.
        `),
      ),
    ).toThrow(/adjacent but not connected|exit/)
  })

  it('rejects a missing start, a curved start, unknown characters and missing checkpoints', () => {
    expect(() => parseTrack(spec(ok.replace('S', '─')))).toThrow(/missing start/)
    expect(() => parseTrack(spec(ok, 'N'))).toThrow(/straight aligned with the start heading/)
    expect(() => parseTrack(spec(ok.replace('1', '#')))).toThrow(/unknown character/)
    expect(() => parseTrack(spec(ok.replace('1', '2')))).toThrow(/checkpoint 1 is missing/)
    expect(() => parseTrack(spec(ok.replace('1', '│')))).toThrow(/at least one checkpoint/)
  })

  it('rejects a checkpoint inside a fork branch', () => {
    expect(() =>
      parseTrack(
        spec(`
          ...┌─1─┐...
          ...│...│...
          .┌─┴───┴─┐.
          .│.......│.
          .└──S────┘.
        `),
      ),
    ).toThrow(/checkpoint .* is not on every lap/)
  })

  it('rejects a fork connected directly to its merge', () => {
    expect(() =>
      parseTrack(
        spec(`
          ..┌┐......
          .┌┴┴──S─┐.
          .│......│.
          .└───1──┘.
        `),
      ),
    ).toThrow(/adjacent but not connected|directly/)
  })
})
