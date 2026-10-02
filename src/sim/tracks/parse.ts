/**
 * ASCII track format.
 *
 * One character per grid cell. Road pieces are box-drawing glyphs, so every connection is explicit
 * and two parallel roads can never be joined by accident:
 *
 *   ─ │ ┌ ┐ └ ┘   straights and curves (2 exits)
 *   ├ ┤ ┬ ┴       forks / merges (3 exits)
 *   S             start/finish (a straight; its exits are inferred from the neighbouring glyphs)
 *   1-9           checkpoints in race order (2 exits, inferred like S)
 *   . or space    off-track
 *
 * Race direction comes from the start heading given next to the map.
 */
import type { Cell, Heading, TrackDefinition, TrackTile } from '../../shared/contracts.ts'
import { HEADINGS } from '../../shared/contracts.ts'
import { opposite } from '../geometry.ts'
import { buildRaceGraph, validateTrack } from '../graph.ts'

export interface TrackSpec {
  id: string
  /** Spanish display name. */
  name: string
  /** Spanish one-line description. */
  description: string
  startHeading: Heading
  /** ASCII rows; blank leading/trailing lines and indentation are ignored. */
  map: string
}

const GLYPH_EXITS: Record<string, Heading[]> = {
  '─': ['E', 'W'],
  '│': ['N', 'S'],
  '┌': ['E', 'S'],
  '┐': ['S', 'W'],
  '└': ['N', 'E'],
  '┘': ['N', 'W'],
  '├': ['N', 'E', 'S'],
  '┤': ['N', 'S', 'W'],
  '┬': ['E', 'S', 'W'],
  '┴': ['N', 'E', 'W'],
}

const VEC: Record<Heading, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] }

function sortExits(exits: Heading[]): Heading[] {
  return [...exits].sort((a, b) => HEADINGS.indexOf(a) - HEADINGS.indexOf(b))
}

/** Parses and fully validates a track. Throws a descriptive Error when the map is inconsistent. */
export function parseTrack(spec: TrackSpec): TrackDefinition {
  const fail = (msg: string): never => {
    throw new Error(`Track "${spec.id}": ${msg}`)
  }
  const rows = spec.map
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Array.from(line))
  if (rows.length === 0) fail('empty map')
  const width = rows[0].length
  const height = rows.length
  rows.forEach((row, y) => {
    if (row.length !== width) fail(`row ${y} has ${row.length} cells, expected ${width}`)
  })
  const at = (x: number, y: number): string => (x >= 0 && y >= 0 && x < width && y < height ? rows[y][x] : '.')
  const isSpecial = (ch: string): boolean => ch === 'S' || /^[1-9]$/.test(ch)

  const tiles: TrackTile[] = []
  const checkpoints: Array<Cell | undefined> = []
  let start: Cell | null = null
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x]
      if (ch === '.' || ch === ' ') continue
      if (GLYPH_EXITS[ch]) {
        tiles.push({ x, y, exits: sortExits(GLYPH_EXITS[ch]), kind: 'road' })
        continue
      }
      if (!isSpecial(ch)) fail(`unknown character "${ch}" at (${x},${y})`)
      const exits: Heading[] = []
      for (const dir of HEADINGS) {
        const [dx, dy] = VEC[dir]
        const other = at(x + dx, y + dy)
        if (isSpecial(other)) fail(`special tiles "${ch}" at (${x},${y}) and "${other}" must not be adjacent`)
        if (GLYPH_EXITS[other]?.includes(opposite(dir))) exits.push(dir)
      }
      if (ch === 'S') {
        if (start) fail('more than one start tile "S"')
        start = { x, y }
        tiles.push({ x, y, exits: sortExits(exits), kind: 'start' })
      } else {
        const index = Number(ch) - 1
        if (checkpoints[index]) fail(`checkpoint ${ch} appears twice`)
        checkpoints[index] = { x, y }
        tiles.push({ x, y, exits: sortExits(exits), kind: 'checkpoint', checkpointIndex: index })
      }
    }
  }
  if (!start) fail('missing start tile "S"')
  for (let i = 0; i < checkpoints.length; i++) {
    if (!checkpoints[i]) fail(`checkpoint ${i + 1} is missing (checkpoints must be numbered 1..n)`)
  }

  const layout = {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    width,
    height,
    tiles,
    start: { cell: start!, heading: spec.startHeading },
    checkpoints: checkpoints as Cell[],
  }
  const graph = buildRaceGraph(layout)
  const track: TrackDefinition = { ...layout, lapLength: graph.lapLength, hasForks: graph.forks.length > 0 }
  validateTrack(track)
  return track
}
