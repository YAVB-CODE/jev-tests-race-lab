/**
 * Hand-built demo circuit (16 × 10) so TrackView can be developed and QA'd before the real tracks
 * in src/sim land. Clockwise loop with a chicane on the top straight and one fork: at (10,8) the
 * car either goes straight (short route) or turns right into a longer detour; both rejoin at (5,8).
 * Start/finish is (3,1) heading East; checkpoints at (14,4) and (3,8).
 *
 * Tiles are derived from the two lap routes (consecutive cells ⇒ mutually consistent `exits`),
 * so every exit of a tile is mirrored by the neighbour it points to.
 */
import type { Cell, Hazard, Heading, TrackDefinition, TrackTile } from '../../../shared/contracts.ts'

type XY = readonly [number, number]

const cell = ([x, y]: XY): Cell => ({ x, y })

/** Clockwise lap, shortest route (heading East on the top straight). Starts at the start/finish cell. */
const SHORT: XY[] = [
  [3, 1], [4, 1], [5, 1], // top straight → chicane entry
  [5, 2], [6, 2], [7, 2], [8, 2], // chicane: down, across…
  [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 1], // …and back up
  [14, 1], // corner
  [14, 2], [14, 3], [14, 4], [14, 5], [14, 6], [14, 7], // right straight (checkpoint 1 at (14,4))
  [14, 8], // corner
  [13, 8], [12, 8], [11, 8],
  [10, 8], // FORK: straight on (short) or turn right (detour)
  [9, 8], [8, 8], [7, 8], [6, 8], // short route
  [5, 8], // MERGE
  [4, 8], [3, 8], [2, 8], // bottom straight (checkpoint 2 at (3,8))
  [1, 8], // corner
  [1, 7], [1, 6], [1, 5], [1, 4], [1, 3], [1, 2], // left straight
  [1, 1], // corner
  [2, 1],
]

/** Cells of the longer detour between the fork (10,8) and the merge (5,8). */
const DETOUR: XY[] = [[10, 7], [10, 6], [9, 6], [8, 6], [7, 6], [6, 6], [5, 6], [5, 7]]

const FORK_INDEX = SHORT.findIndex(([x, y]) => x === 10 && y === 8)
const MERGE_INDEX = SHORT.findIndex(([x, y]) => x === 5 && y === 8)

const ALT: XY[] = [...SHORT.slice(0, FORK_INDEX + 1), ...DETOUR, ...SHORT.slice(MERGE_INDEX)]

const HEADING_OF: Array<[Heading, number, number]> = [
  ['N', 0, -1],
  ['E', 1, 0],
  ['S', 0, 1],
  ['W', -1, 0],
]

const START: XY = [3, 1]
const CHECKPOINTS: XY[] = [[14, 4], [3, 8]]

function buildTiles(routes: XY[][]): TrackTile[] {
  const exits = new Map<string, Set<Heading>>()
  const add = (a: XY, b: XY) => {
    const found = HEADING_OF.find(([, dx, dy]) => a[0] + dx === b[0] && a[1] + dy === b[1])
    if (!found) throw new Error(`demoTrack: cells ${a} and ${b} are not adjacent`)
    const [h, dx, dy] = found
    const opposite = HEADING_OF.find(([, ox, oy]) => ox === -dx && oy === -dy)![0]
    const key = (c: XY) => `${c[0]},${c[1]}`
    if (!exits.has(key(a))) exits.set(key(a), new Set())
    if (!exits.has(key(b))) exits.set(key(b), new Set())
    exits.get(key(a))!.add(h)
    exits.get(key(b))!.add(opposite)
  }
  for (const route of routes) {
    for (let i = 0; i < route.length; i++) add(route[i]!, route[(i + 1) % route.length]!)
  }
  const order = ['N', 'E', 'S', 'W']
  return [...exits.entries()].map(([key, set]) => {
    const [x, y] = key.split(',').map(Number) as [number, number]
    const checkpointIndex = CHECKPOINTS.findIndex(([cx, cy]) => cx === x && cy === y)
    const tile: TrackTile = {
      x,
      y,
      exits: [...set].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
      kind: x === START[0] && y === START[1] ? 'start' : checkpointIndex >= 0 ? 'checkpoint' : 'road',
    }
    if (checkpointIndex >= 0 && tile.kind === 'checkpoint') tile.checkpointIndex = checkpointIndex
    return tile
  })
}

export const DEMO_TRACK: TrackDefinition = {
  id: 'demo',
  name: 'Demo · Chicane y desvío',
  description: 'Circuito de prueba 16×10 con una chicane y una bifurcación (atajo vs. desvío).',
  width: 16,
  height: 10,
  tiles: buildTiles([SHORT, ALT]),
  start: { cell: cell(START), heading: 'E' },
  checkpoints: CHECKPOINTS.map(cell),
  lapLength: SHORT.length,
  hasForks: true,
}

/** Full-lap cell sequences (cyclic, index 0 = start cell) the demo lanes drive along. */
export const DEMO_ROUTE_SHORT: Cell[] = SHORT.map(cell)
export const DEMO_ROUTE_DETOUR: Cell[] = ALT.map(cell)

/** Hazard sets; the demo cycles through them, one per lap (hazards regenerate every lap). */
export const DEMO_HAZARD_SETS: Hazard[][] = [
  [
    { cell: { x: 11, y: 1 }, kind: 'oil' },
    { cell: { x: 14, y: 6 }, kind: 'cones' },
    { cell: { x: 7, y: 8 }, kind: 'oil' },
    { cell: { x: 1, y: 4 }, kind: 'cones' },
  ],
  [
    { cell: { x: 6, y: 2 }, kind: 'cones' },
    { cell: { x: 14, y: 2 }, kind: 'oil' },
    { cell: { x: 8, y: 6 }, kind: 'oil' },
    { cell: { x: 12, y: 8 }, kind: 'cones' },
    { cell: { x: 1, y: 6 }, kind: 'oil' },
  ],
  [
    { cell: { x: 10, y: 1 }, kind: 'cones' },
    { cell: { x: 14, y: 5 }, kind: 'oil' },
    { cell: { x: 9, y: 8 }, kind: 'cones' },
    { cell: { x: 2, y: 8 }, kind: 'oil' },
    { cell: { x: 1, y: 2 }, kind: 'cones' },
  ],
]

export const DEMO_HAZARDS: Hazard[] = DEMO_HAZARD_SETS[0]!
