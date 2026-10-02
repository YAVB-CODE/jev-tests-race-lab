/**
 * Pure geometry helpers for the circuit renderer. Everything is expressed in grid units:
 * cell (x, y) spans [x, x+1] × [y, y+1] and its center is (x + 0.5, y + 0.5).
 *
 * The road is drawn in concentric layers (shoulder > edge line > asphalt). Curves are quarter circles
 * centered on the cell corner, and junction fillets are circles centered on the cell corner too,
 * so every layer shares the same centers and curves look rounded instead of blocky.
 */
import type { Cell, Heading, TrackDefinition, TrackTile } from '../../shared/contracts.ts'

export interface Vec {
  x: number
  y: number
}

export const DIRS: Record<Heading, Vec> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
}

export const OPPOSITE: Record<Heading, Heading> = { N: 'S', S: 'N', E: 'W', W: 'E' }

/** Compass heading → rotation in degrees (0 = North, clockwise). */
export const HEADING_ANGLE: Record<Heading, number> = { N: 0, E: 90, S: 180, W: 270 }

/** Half-widths (grid units) of the concentric road layers. */
export const ROAD = {
  SHOULDER: 0.4,
  /** Outer boundary of the road itself (white edge line). */
  EDGE: 0.34,
  ASPHALT: 0.305,
  KERB: 0.075,
} as const

const num = (v: number) => String(Math.round(v * 10000) / 10000)
const pt = (x: number, y: number) => `${num(x)} ${num(y)}`

/** Small deterministic hash → [0, 1). Used for stable per-cell variations (bushes, cones, oil blobs). */
export function hash2(x: number, y: number, salt = 0): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  h = Math.imul(h, 2246822519)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** Id of a shared SVG gradient / pattern; `uid` keeps ids unique when several TrackViews share a page. */
export function gradId(uid: string, name: string): string {
  return `${uid}-${name}`
}

// ───────────────────────────── Tile shapes ─────────────────────────────

export type TileShape =
  | { type: 'straight'; cx: number; cy: number; a: Heading; b: Heading }
  | { type: 'curve'; cx: number; cy: number; a: Heading; b: Heading }
  /** Dead end (1 exit), fork / merge (3 exits) or crossing (4 exits). */
  | { type: 'arms'; cx: number; cy: number; exits: Heading[] }

export function classifyTile(tile: TrackTile): TileShape {
  const exits = [...new Set(tile.exits)]
  const cx = tile.x + 0.5
  const cy = tile.y + 0.5
  if (exits.length === 2) {
    const [a, b] = exits as [Heading, Heading]
    return OPPOSITE[a] === b ? { type: 'straight', cx, cy, a, b } : { type: 'curve', cx, cy, a, b }
  }
  return { type: 'arms', cx, cy, exits }
}

/** SVG arc around `corner` between two unit directions, picking the sweep flag from the cross product. */
function arcD(corner: Vec, from: Vec, to: Vec, r: number): string {
  const sweep = from.x * to.y - from.y * to.x > 0 ? 1 : 0
  const x1 = corner.x + from.x * r
  const y1 = corner.y + from.y * r
  const x2 = corner.x + to.x * r
  const y2 = corner.y + to.y * r
  return `M${pt(x1, y1)}A${num(r)} ${num(r)} 0 0 ${sweep} ${pt(x2, y2)}`
}

/** Quarter circle of radius `r` around the cell corner shared by the two exits of a curve tile. */
function curveArc(s: Extract<TileShape, { type: 'curve' }>, r: number): string {
  const da = DIRS[s.a]
  const db = DIRS[s.b]
  const corner = { x: s.cx + 0.5 * (da.x + db.x), y: s.cy + 0.5 * (da.y + db.y) }
  return arcD(corner, { x: -db.x, y: -db.y }, { x: -da.x, y: -da.y }, r)
}

/**
 * Concave fillet between two perpendicular arms of a junction, for a layer with half-width `hw`.
 * The polygon reaches `ov` units into the arms so it overlaps the arm strokes (no anti-aliasing seam).
 */
function filletD(cx: number, cy: number, a: Heading, b: Heading, hw: number): string {
  const rf = 0.5 - hw
  const ov = 0.012
  const da = DIRS[a]
  const db = DIRS[b]
  const kx = cx + (da.x + db.x) * hw
  const ky = cy + (da.y + db.y) * hw
  const ax = kx + da.x * rf
  const ay = ky + da.y * rf
  const bx = kx + db.x * rf
  const by = ky + db.y * rf
  const sweep = db.x * da.y - db.y * da.x > 0 ? 1 : 0
  return (
    `M${pt(kx - (da.x + db.x) * ov, ky - (da.y + db.y) * ov)}` +
    `L${pt(ax - db.x * ov, ay - db.y * ov)}L${pt(ax, ay)}` +
    `A${num(rf)} ${num(rf)} 0 0 ${sweep} ${pt(bx, by)}` +
    `L${pt(bx - da.x * ov, by - da.y * ov)}Z`
  )
}

export interface LayerPaths {
  /** Path for `stroke` (stroke-width = 2 × hw, butt caps). */
  stroke: string
  /** Path for `fill` (fillets and dead-end discs). */
  fill: string
}

/**
 * One layer of the road. All tiles of a layer go into a SINGLE path per kind so the rasterizer unions
 * them: no hairline seams where tiles touch.
 */
export function roadLayer(shapes: TileShape[], hw: number): LayerPaths {
  const strokes: string[] = []
  const fills: string[] = []
  const rf = 0.5 - hw
  for (const s of shapes) {
    if (s.type === 'straight') {
      const da = DIRS[s.a]
      const db = DIRS[s.b]
      strokes.push(`M${pt(s.cx + da.x * 0.5, s.cy + da.y * 0.5)}L${pt(s.cx + db.x * 0.5, s.cy + db.y * 0.5)}`)
    } else if (s.type === 'curve') {
      strokes.push(curveArc(s, 0.5))
    } else {
      for (const e of s.exits) {
        const d = DIRS[e]
        strokes.push(`M${pt(s.cx, s.cy)}L${pt(s.cx + d.x * 0.5, s.cy + d.y * 0.5)}`)
      }
      if (s.exits.length <= 1) {
        fills.push(`M${pt(s.cx - hw, s.cy)}a${num(hw)} ${num(hw)} 0 1 0 ${num(hw * 2)} 0a${num(hw)} ${num(hw)} 0 1 0 ${num(-hw * 2)} 0Z`)
      }
      if (rf > 0.001) {
        for (let i = 0; i < s.exits.length; i++) {
          for (let j = i + 1; j < s.exits.length; j++) {
            const a = s.exits[i]!
            const b = s.exits[j]!
            if (OPPOSITE[a] !== b) fills.push(filletD(s.cx, s.cy, a, b, hw))
          }
        }
      }
    }
  }
  return { stroke: strokes.join(''), fill: fills.join('') }
}

export interface KerbPaths {
  inner: string
  outer: string
  innerDash: number
  outerDash: number
}

/** Kerbs live on the inner and outer edge of every curve tile. Dash lengths split each arc in an even number of stripes. */
export function kerbPaths(shapes: TileShape[]): KerbPaths {
  const rIn = 0.5 - ROAD.EDGE + ROAD.KERB / 2
  const rOut = 0.5 + ROAD.EDGE - ROAD.KERB / 2
  const inner: string[] = []
  const outer: string[] = []
  for (const s of shapes) {
    if (s.type !== 'curve') continue
    inner.push(curveArc(s, rIn))
    outer.push(curveArc(s, rOut))
  }
  const stripes = (r: number, n: number) => (Math.PI / 2) * r / n
  return {
    inner: inner.join(''),
    outer: outer.join(''),
    innerDash: stripes(rIn, 4),
    outerDash: stripes(rOut, 12),
  }
}

/** Dashed center line for straights and curves (not drawn on junctions). */
export function centerLinePath(shapes: TileShape[]): string {
  const out: string[] = []
  for (const s of shapes) {
    if (s.type === 'straight') {
      const da = DIRS[s.a]
      const db = DIRS[s.b]
      out.push(`M${pt(s.cx + da.x * 0.5, s.cy + da.y * 0.5)}L${pt(s.cx + db.x * 0.5, s.cy + db.y * 0.5)}`)
    } else if (s.type === 'curve') {
      out.push(curveArc(s, 0.5))
    }
  }
  return out.join('')
}

// ───────────────────────────── Decorations ─────────────────────────────

export interface CheckpointArt {
  index: number
  cx: number
  cy: number
  /** Gate across the road (straight tiles) or a ring (everything else). */
  gate: { type: 'band'; angle: number } | { type: 'ring' }
  badge: Vec
}

export interface Bush {
  x: number
  y: number
  r: number
  variant: number
}

export interface TrackArt {
  shapes: TileShape[]
  shoulder: LayerPaths
  edge: LayerPaths
  asphalt: LayerPaths
  kerbs: KerbPaths
  centerLine: string
  checkpoints: CheckpointArt[]
  bushes: Bush[]
  startCenter: Vec
  startAngle: number
}

const cellKey = (x: number, y: number) => `${x},${y}`

const BADGE_R = 0.19

function placeBadge(shape: TileShape, roadCells: Set<string>, tile: Cell, width: number, height: number): Vec {
  const { cx, cy } = shape
  const candidates: Vec[] = []
  if (shape.type === 'curve') {
    // Free diagonal: opposite to the corner the arc is centered on.
    const da = DIRS[shape.a]
    const db = DIRS[shape.b]
    candidates.push({ x: cx - (da.x + db.x) * 0.34, y: cy - (da.y + db.y) * 0.34 })
  }
  const off = ROAD.SHOULDER + 0.03 + BADGE_R * 0.55
  const exits: Heading[] =
    shape.type === 'arms' ? shape.exits : [shape.a, shape.b]
  const free = (['E', 'S', 'W', 'N'] as Heading[]).filter((h) => !exits.includes(h))
  const prefer = shape.type === 'straight' && (shape.a === 'E' || shape.a === 'W') ? ['S', 'N', 'E', 'W'] : ['E', 'W', 'S', 'N']
  for (const h of prefer as Heading[]) {
    if (free.includes(h)) candidates.push({ x: cx + DIRS[h].x * off, y: cy + DIRS[h].y * off })
  }
  candidates.push({ x: cx + off, y: cy })
  for (const c of candidates) {
    const nx = Math.floor(c.x)
    const ny = Math.floor(c.y)
    const onRoad = roadCells.has(cellKey(nx, ny)) && (nx !== tile.x || ny !== tile.y)
    const inside = c.x - BADGE_R >= 0 && c.x + BADGE_R <= width && c.y - BADGE_R >= 0 && c.y + BADGE_R <= height
    if (!onRoad && inside) return c
  }
  return candidates[0] ?? { x: cx, y: cy }
}

export function buildTrackArt(track: TrackDefinition): TrackArt {
  const shapes = track.tiles.map(classifyTile)
  const roadCells = new Set(track.tiles.map((t) => cellKey(t.x, t.y)))

  const checkpoints: CheckpointArt[] = track.checkpoints.map((c, index) => {
    const tile = track.tiles.find((t) => t.x === c.x && t.y === c.y)
    const shape = tile ? classifyTile(tile) : ({ type: 'arms', cx: c.x + 0.5, cy: c.y + 0.5, exits: [] } as TileShape)
    const gate: CheckpointArt['gate'] =
      shape.type === 'straight'
        ? { type: 'band', angle: shape.a === 'N' || shape.a === 'S' ? 0 : 90 }
        : { type: 'ring' }
    return { index, cx: c.x + 0.5, cy: c.y + 0.5, gate, badge: placeBadge(shape, roadCells, c, track.width, track.height) }
  })

  const bushes: Bush[] = []
  for (let y = 0; y < track.height; y++) {
    for (let x = 0; x < track.width; x++) {
      if (roadCells.has(cellKey(x, y))) continue
      if (hash2(x, y, 1) > 0.3) continue
      const r = 0.13 + hash2(x, y, 2) * 0.13
      const bx = x + 0.5 + (hash2(x, y, 3) - 0.5) * (0.9 - 2 * r)
      const by = y + 0.5 + (hash2(x, y, 4) - 0.5) * (0.9 - 2 * r)
      const clash = checkpoints.some((c) => Math.hypot(c.badge.x - bx, c.badge.y - by) < r + BADGE_R + 0.05)
      if (!clash) bushes.push({ x: bx, y: by, r, variant: Math.floor(hash2(x, y, 5) * 3) })
    }
  }

  return {
    shapes,
    shoulder: roadLayer(shapes, ROAD.SHOULDER),
    edge: roadLayer(shapes, ROAD.EDGE),
    asphalt: roadLayer(shapes, ROAD.ASPHALT),
    kerbs: kerbPaths(shapes),
    centerLine: centerLinePath(shapes),
    checkpoints,
    bushes,
    startCenter: { x: track.start.cell.x + 0.5, y: track.start.cell.y + 0.5 },
    startAngle: HEADING_ANGLE[track.start.heading],
  }
}

// ───────────────────────────── Hazard art ─────────────────────────────

/** Smooth closed blob (Catmull-Rom → cubic Béziers) around (0, 0), deterministic per seed. */
export function blobPath(x: number, y: number, radius: number, salt: number): string {
  const n = 9
  const pts: Vec[] = []
  for (let i = 0; i < n; i++) {
    const a = ((i + (hash2(x, y, salt + i) - 0.5) * 0.3) / n) * Math.PI * 2
    const r = radius * (0.84 + hash2(x, y, salt + 20 + i) * 0.28)
    pts.push({ x: Math.cos(a) * r * 1.06, y: Math.sin(a) * r * 0.94 })
  }
  const at = (i: number) => pts[(i + n) % n]!
  let d = `M${pt(at(0).x, at(0).y)}`
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    d += `C${pt(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6)} ${pt(p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6)} ${pt(p2.x, p2.y)}`
  }
  return `${d}Z`
}
