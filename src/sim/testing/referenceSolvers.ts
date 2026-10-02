/**
 * Reference solvers that only look at the Observation (never at the track or the oracle).
 * Used by the fairness tests: if they reproduce the oracle, the observation carries enough information.
 */
import type { Observation, OptionView, RelativeMove, SpeedMode } from '../../shared/contracts.ts'
import { RELATIVE_MOVES } from '../../shared/contracts.ts'
import { RULES, correctSpeed } from '../../shared/rules.ts'

export interface SolverAnswer {
  move: RelativeMove
  speed: SpeedMode
}

function byMove(options: OptionView[]): OptionView[] {
  return RELATIVE_MOVES.map((m) => options.find((o) => o.move === m)).filter((o): o is OptionView => !!o)
}

/** Easy: structured numeric fields only. */
export function solveEasy(obs: Observation): SolverAnswer | null {
  let best: OptionView | null = null
  for (const o of byMove(obs.options ?? [])) {
    if (!o.onTrack || o.blocked || o.distanceToCheckpoint == null) continue
    if (!best || o.distanceToCheckpoint < best.distanceToCheckpoint!) best = o
  }
  if (!best) return null
  return { move: best.move, speed: correctSpeed(best.straightRun ?? 0, best.firstOilAt ?? null) }
}

/** Normal: parses the deterministic English summary. */
export function solveNormal(obs: Observation): SolverAnswer | null {
  let best: { move: RelativeMove; length: number; run: number; oil: number | null } | null = null
  for (const o of byMove(obs.options ?? [])) {
    const s = o.summary ?? ''
    if (!o.onTrack || /\bblocked\b/.test(s)) continue
    const length = /next checkpoint(?: \(finish line\))? in (\d+) cells?/.exec(s)
    const run = /straight for (\d+)\+? cells?/.exec(s)
    if (!length || !run) continue
    const oil = /oil at route cell (\d+)/.exec(s)
    const candidate = { move: o.move, length: Number(length[1]), run: Number(run[1]), oil: oil ? Number(oil[1]) : null }
    if (!best || candidate.length < best.length) best = candidate
  }
  if (!best) return null
  return { move: best.move, speed: correctSpeed(best.run, best.oil) }
}

// ─────────────────────────── Hard: map-only solver ───────────────────────────

/** Egocentric directions: 0 = up (forward), 1 = right, 2 = down, 3 = left. */
type Dir = 0 | 1 | 2 | 3
const DR = [-1, 0, 1, 0]
const DC = [0, 1, 0, -1]
const ARROW: Record<string, Dir> = { '^': 0, '>': 1, v: 2, '<': 3 }
const MOVE_DIR: Record<RelativeMove, Dir> = { forward: 0, left: 3, right: 1 }
const opp = (d: Dir): Dir => ((d + 2) % 4) as Dir

interface MapModel {
  n: number
  rows: string[]
  car: [number, number]
  target: [number, number] | null
  /** orientation of edge (r, c) → d: 'out' = race direction leaves (r, c) through d. */
  orient: Map<string, 'out' | 'in'>
}

const key = (r: number, c: number): string => `${r},${c}`
const ekey = (r: number, c: number, d: Dir): string => `${r},${c},${d}`

function glyph(m: MapModel, r: number, c: number): string {
  return r >= 0 && c >= 0 && r < m.n && c < m.n ? m.rows[r][c] : '.'
}

function isRoad(m: MapModel, r: number, c: number): boolean {
  return glyph(m, r, c) !== '.'
}

function roadDirs(m: MapModel, r: number, c: number): Dir[] {
  return ([0, 1, 2, 3] as Dir[]).filter((d) => isRoad(m, r + DR[d], c + DC[d]))
}

function setEdge(m: MapModel, r: number, c: number, d: Dir, v: 'out' | 'in'): boolean {
  if (m.orient.has(ekey(r, c, d))) return false
  m.orient.set(ekey(r, c, d), v)
  m.orient.set(ekey(r + DR[d], c + DC[d], opp(d)), v === 'out' ? 'in' : 'out')
  return true
}

/** Infers the race direction of every visible edge from arrows, then propagates through arrowless cells. */
function buildModel(obs: Observation): MapModel | null {
  const rows = obs.localMap?.rows
  if (!rows || rows.length === 0) return null
  const n = rows.length
  const half = (n - 1) / 2
  const nc = obs.nextCheckpoint
  const tr = nc ? n - 1 - nc.ahead : -1
  const tc = nc ? half + nc.right : -1
  const m: MapModel = {
    n,
    rows,
    car: [n - 1, half],
    target: nc && tr >= 0 && tc >= 0 && tr < n && tc < n ? [tr, tc] : null,
    orient: new Map(),
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = ARROW[rows[r][c]]
      if (a === undefined) continue
      for (const d of roadDirs(m, r, c)) setEdge(m, r, c, d, d === a ? 'out' : 'in')
    }
  }
  for (let changed = true; changed; ) {
    changed = false
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const g = rows[r][c]
        if (g === '.' || ARROW[g] !== undefined) continue
        const dirs = roadDirs(m, r, c)
        const known = dirs.map((d) => m.orient.get(ekey(r, c, d)))
        const unknown = dirs.filter((_, i) => known[i] === undefined)
        if (unknown.length === 0) continue
        const ins = known.filter((k) => k === 'in').length
        const outs = known.filter((k) => k === 'out').length
        let fill: 'out' | 'in' | null = null
        if (g === 'Y') fill = ins >= 1 ? 'out' : outs >= 2 ? 'in' : null
        else if (g === '@') fill = dirs.length === 1 || ins >= 1 ? 'out' : null // car entered from behind
        else if (dirs.length === 2) fill = ins >= 1 ? 'out' : outs >= 1 ? 'in' : null // o, X, *: one in, one out
        if (fill) for (const d of unknown) changed = setEdge(m, r, c, d, fill) || changed
      }
    }
  }
  return m
}

/** Out-directions of a cell (unknown edges count as passable; the car never re-enters its own cell). */
function outDirs(m: MapModel, r: number, c: number): Dir[] {
  return roadDirs(m, r, c).filter((d) => m.orient.get(ekey(r, c, d)) !== 'in')
}

/** Whether a reached cell may continue outside the visible window. */
function escapes(m: MapModel, r: number, c: number): boolean {
  const a = ARROW[m.rows[r][c]]
  if (a !== undefined) return !(r + DR[a] >= 0 && c + DC[a] >= 0 && r + DR[a] < m.n && c + DC[a] < m.n)
  return r === 0 || c === 0 || c === m.n - 1 || r === m.n - 1
}

interface Reach {
  dist: Map<string, number>
  target: number | null
  open: boolean
}

function explore(m: MapModel, start: [number, number], from: [number, number]): Reach {
  const dist = new Map<string, number>([[key(...start), 1]])
  const queue: Array<[number, number]> = [start]
  let open = false
  let target: number | null = null
  for (let qi = 0; qi < queue.length; qi++) {
    const [r, c] = queue[qi]
    const d0 = dist.get(key(r, c))!
    if (m.target && r === m.target[0] && c === m.target[1]) {
      target ??= d0
      open = true
    }
    if (escapes(m, r, c)) open = true
    for (const d of outDirs(m, r, c)) {
      const nr = r + DR[d]
      const nc = c + DC[d]
      if ((nr === from[0] && nc === from[1]) || glyph(m, nr, nc) === 'X' || dist.has(key(nr, nc))) continue
      if (nr === m.car[0] && nc === m.car[1]) continue
      dist.set(key(nr, nc), d0 + 1)
      queue.push([nr, nc])
    }
  }
  return { dist, target, open }
}

/** Picks the best exit of cell (r, c) entered with heading `inDir`; returns the absolute map direction. */
function chooseExit(m: MapModel, r: number, c: number, inDir: Dir, useTarget: boolean): Dir | null {
  const order: Dir[] = [inDir, ((inDir + 3) % 4) as Dir, ((inDir + 1) % 4) as Dir] // forward, left, right
  const cands: Array<{ d: Dir; reach: Reach }> = []
  for (const d of order) {
    const nr = r + DR[d]
    const nc = c + DC[d]
    if (nr < 0 || nc < 0 || nr >= m.n || nc >= m.n) {
      // Exit hidden beyond the window edge: unknown but possibly open (only junctions reach here).
      if (glyph(m, r, c) === 'Y') cands.push({ d, reach: { dist: new Map(), target: null, open: true } })
      continue
    }
    if (!isRoad(m, nr, nc) || glyph(m, nr, nc) === 'X') continue
    if (m.orient.get(ekey(r, c, d)) === 'in') continue
    const reach = explore(m, [nr, nc], [r, c])
    if (!reach.open) continue // dead end inside the window: closed by cones
    cands.push({ d, reach })
  }
  if (cands.length <= 1) return cands[0]?.d ?? null
  // 1) Branches rejoin inside the window: compare at a common cell.
  const common = [...cands[0].reach.dist.keys()].filter((k) => cands.every((x) => x.reach.dist.has(k)))
  if (common.length > 0) {
    const k = common[0]
    return cands.reduce((a, b) => (b.reach.dist.get(k)! < a.reach.dist.get(k)! ? b : a)).d
  }
  // 2) Target visible and reachable from every branch.
  if (useTarget && cands.every((x) => x.reach.target !== null)) {
    return cands.reduce((a, b) => (b.reach.target! < a.reach.target! ? b : a)).d
  }
  // 3) Heuristic: distance to the frontier plus straight-line distance to the target.
  const goal = m.target ?? m.car
  const score = (x: { reach: Reach }): number => {
    let best = Infinity
    for (const [k, d] of x.reach.dist) {
      const [rr, cc] = k.split(',').map(Number)
      if (!escapes(m, rr, cc)) continue
      best = Math.min(best, d + Math.abs(rr - goal[0]) + Math.abs(cc - goal[1]))
    }
    return best
  }
  return cands.reduce((a, b) => (score(b) < score(a) ? b : a)).d
}

/** Hard: only the egocentric map + nextCheckpoint. Best effort (the window is finite). */
export function solveHard(obs: Observation): SolverAnswer | null {
  const m = buildModel(obs)
  if (!m) return null
  const [cr, cc] = m.car
  const first = chooseExit(m, cr, cc, 0, true)
  if (first === null) return null
  const move = (Object.keys(MOVE_DIR) as RelativeMove[]).find((k) => MOVE_DIR[k] === first)!

  // Follow the best continuation for the speed rule.
  const cap = RULES.STRAIGHT_RUN_CAP
  const look = RULES.SPEED.LOOKAHEAD
  let r = cr + DR[first]
  let c = cc + DC[first]
  let heading: Dir = first
  let straightRun = 1
  let straight = true
  let firstOilAt: number | null = null
  let passedTarget = false
  for (let i = 1; i <= Math.max(cap, look); i++) {
    if (glyph(m, r, c) === 'o' && i <= look && firstOilAt === null) firstOilAt = i
    if (m.target && r === m.target[0] && c === m.target[1]) passedTarget = true
    if (i >= Math.max(cap, look)) break
    const arrow = ARROW[glyph(m, r, c)]
    let next: Dir | null
    if (arrow !== undefined) next = arrow
    else if (glyph(m, r, c) === 'Y') next = chooseExit(m, r, c, heading, !passedTarget)
    else {
      const outs = outDirs(m, r, c).filter((d) => !(r + DR[d] === r - DR[heading] && c + DC[d] === c - DC[heading]))
      next = outs.length === 1 ? outs[0] : outs.length > 1 ? chooseExit(m, r, c, heading, !passedTarget) : null
    }
    if (next === null) next = heading // unknown beyond the window: assume the road keeps going
    if (straight && next === heading && straightRun < cap) straightRun++
    else straight = false
    heading = next
    r += DR[next]
    c += DC[next]
    if (!isRoad(m, r, c) && (r < 0 || c < 0 || r >= m.n || c >= m.n)) {
      // Left the window: assume it keeps going straight from here on.
      if (straight) straightRun = Math.min(cap, straightRun + (Math.max(cap, look) - 1 - i))
      break
    }
  }
  return { move, speed: correctSpeed(straightRun, firstOilAt) }
}
