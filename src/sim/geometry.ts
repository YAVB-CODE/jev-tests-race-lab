/** Grid geometry helpers: headings, relative moves and egocentric transforms. */
import type { Cell, Heading, RelativeMove } from '../shared/contracts.ts'

export const DIR_VECTORS: Readonly<Record<Heading, { readonly dx: number; readonly dy: number }>> = {
  N: { dx: 0, dy: -1 },
  E: { dx: 1, dy: 0 },
  S: { dx: 0, dy: 1 },
  W: { dx: -1, dy: 0 },
}

const CLOCKWISE: readonly Heading[] = ['N', 'E', 'S', 'W']

function rotate(heading: Heading, quarterTurns: number): Heading {
  return CLOCKWISE[(CLOCKWISE.indexOf(heading) + quarterTurns + 4) % 4]
}

export function turnRight(heading: Heading): Heading {
  return rotate(heading, 1)
}

export function turnLeft(heading: Heading): Heading {
  return rotate(heading, -1)
}

export function opposite(heading: Heading): Heading {
  return rotate(heading, 2)
}

/** Absolute heading after applying a relative move. */
export function turn(heading: Heading, move: RelativeMove): Heading {
  if (move === 'left') return turnLeft(heading)
  if (move === 'right') return turnRight(heading)
  return heading
}

/** Relative move that leads from `heading` to the absolute direction `dir` ('back' = U-turn, never allowed). */
export function relativeMove(heading: Heading, dir: Heading): RelativeMove | 'back' {
  const diff = (CLOCKWISE.indexOf(dir) - CLOCKWISE.indexOf(heading) + 4) % 4
  return diff === 0 ? 'forward' : diff === 1 ? 'right' : diff === 3 ? 'left' : 'back'
}

/** Adjacent cell in the given absolute direction. */
export function neighbor(cell: Cell, heading: Heading): Cell {
  const v = DIR_VECTORS[heading]
  return { x: cell.x + v.dx, y: cell.y + v.dy }
}

export function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y
}

/** Compass angle in degrees: N = 0, clockwise. */
export function headingAngle(heading: Heading): number {
  return CLOCKWISE.indexOf(heading) * 90
}

/** Signed rotation (degrees) of a relative move: left = -90, right = +90. */
export function moveDelta(move: RelativeMove): number {
  return move === 'left' ? -90 : move === 'right' ? 90 : 0
}

/** Continuous pose coordinates of the center of a cell. */
export function cellCenter(cell: Cell): { x: number; y: number } {
  return { x: cell.x + 0.5, y: cell.y + 0.5 }
}

/** Egocentric offset of `target` seen from a car at `origin` facing `heading`. */
export function toEgocentric(origin: Cell, heading: Heading, target: Cell): { ahead: number; right: number } {
  const f = DIR_VECTORS[heading]
  const r = DIR_VECTORS[turnRight(heading)]
  const dx = target.x - origin.x
  const dy = target.y - origin.y
  return { ahead: dx * f.dx + dy * f.dy, right: dx * r.dx + dy * r.dy }
}

/** Absolute cell at an egocentric offset from a car at `origin` facing `heading`. */
export function fromEgocentric(origin: Cell, heading: Heading, ahead: number, right: number): Cell {
  const f = DIR_VECTORS[heading]
  const r = DIR_VECTORS[turnRight(heading)]
  return { x: origin.x + ahead * f.dx + right * r.dx, y: origin.y + ahead * f.dy + right * r.dy }
}
