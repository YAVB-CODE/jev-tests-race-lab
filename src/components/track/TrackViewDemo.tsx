/**
 * Self-contained visual-QA demo for TrackView: two lanes (GPT left, Jev right) driven by a fake
 * runner that cycles thinking → moving, with occasional crashes, spins and hazards that regenerate
 * every lap. It uses the hand-built demo circuit, so it does not depend on src/sim.
 */
import { useEffect, useState } from 'react'
import type {
  CarPhase,
  CarPose,
  Cell,
  DecisionRecord,
  EngineId,
  Hazard,
  Heading,
  LaneSnapshot,
  LiveFrame,
  MoveOutcome,
  RelativeMove,
  SpeedMode,
  SpeedOutcome,
} from '../../shared/contracts.ts'
import { HEADINGS } from '../../shared/contracts.ts'
import { createRng } from '../../shared/rng.ts'
import { RULES } from '../../shared/rules.ts'
import { DEMO_HAZARD_SETS, DEMO_ROUTE_DETOUR, DEMO_ROUTE_SHORT, DEMO_TRACK } from './__fixtures__/demoTrack.ts'
import { HEADING_ANGLE } from './geometry.ts'
import { TrackView } from './TrackView.tsx'

// ─────────────────────────────── Fake runner ───────────────────────────────

type Forced = 'crash' | 'spin' | 'think' | null

const TOTAL_LAPS = 3
const MOVES: RelativeMove[] = ['forward', 'left', 'right']
const SPEEDS: SpeedMode[] = ['slow', 'cruise', 'boost']

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const smooth = (v: number) => v * v * (3 - 2 * v)
const easeOut = (v: number) => 1 - (1 - v) ** 3

function headingBetween(a: Cell, b: Cell): Heading {
  if (b.x > a.x) return 'E'
  if (b.x < a.x) return 'W'
  return b.y > a.y ? 'S' : 'N'
}

function relativeMove(from: Heading, to: Heading): RelativeMove {
  const d = (HEADINGS.indexOf(to) - HEADINGS.indexOf(from) + 4) % 4
  return d === 1 ? 'right' : d === 3 ? 'left' : 'forward'
}

interface FakeLaneOptions {
  /** Range of the simulated "thinking" time in ms. */
  think: [number, number]
  seed: number
}

class FakeLane {
  readonly engine: EngineId
  private readonly options: FakeLaneOptions
  private readonly listeners = new Set<(s: LaneSnapshot) => void>()
  private rand: () => number

  private route: Cell[] = DEMO_ROUTE_SHORT
  private idx = 0
  private lap = 1
  private phase: CarPhase = 'idle'
  private phaseStart = 0
  private phaseDur = 700
  private angle = 0
  private turn = 0
  private heading: Heading = DEMO_TRACK.start.heading
  private nextHeading: Heading = DEMO_TRACK.start.heading
  private speed: SpeedMode = 'cruise'
  private spinDir = 1
  private crashSide = 1
  private forced: Forced = null
  private nextMode: 'move' | 'spin' | 'crash' = 'move'

  private paused = false
  private pausedAt = 0
  private pausedTotal = 0
  private startedAt = 0
  private finishedAtRace = 0
  private lapStartRace = 0
  private lapTimes: number[] = []
  private thinkingMs = 0
  private movingMs = 0
  private penaltyMs = 0
  private decisions = 0
  private hazards: Hazard[] = DEMO_HAZARD_SETS[0]!
  private lastRecord: DecisionRecord | null = null

  constructor(engine: EngineId, options: FakeLaneOptions) {
    this.engine = engine
    this.options = options
    this.rand = createRng(options.seed)
    this.reset()
  }

  private clock(): number {
    return (this.paused ? this.pausedAt : performance.now()) - this.pausedTotal
  }

  private raceTime(t: number): number {
    return this.phase === 'finished' ? this.finishedAtRace : t - this.startedAt
  }

  private reset() {
    this.rand = createRng(this.options.seed)
    const t = this.clock()
    this.route = DEMO_ROUTE_SHORT
    this.idx = 0
    this.lap = 1
    this.phase = 'idle'
    this.phaseStart = t
    this.phaseDur = 700
    this.heading = DEMO_TRACK.start.heading
    this.angle = HEADING_ANGLE[this.heading]
    this.turn = 0
    this.speed = 'cruise'
    this.forced = null
    this.startedAt = t
    this.lapStartRace = 0
    this.lapTimes = []
    this.thinkingMs = 0
    this.movingMs = 0
    this.penaltyMs = 0
    this.decisions = 0
    this.hazards = DEMO_HAZARD_SETS[0]!
    this.lastRecord = null
    this.emit()
  }

  // ── controls ──

  restart = () => {
    this.reset()
  }

  setPaused = (paused: boolean) => {
    if (paused === this.paused) return
    if (paused) {
      this.pausedAt = performance.now()
      this.paused = true
    } else {
      this.pausedTotal += performance.now() - this.pausedAt
      this.paused = false
    }
    this.emit()
  }

  force = (kind: Exclude<Forced, null> | 'finish') => {
    const t = this.clock()
    if (kind === 'finish') {
      this.lap = TOTAL_LAPS
      this.enterFinished(t)
      return
    }
    this.forced = kind
    if (this.phase === 'thinking') {
      this.phaseDur = kind === 'think' ? t - this.phaseStart + 3000 : Math.min(this.phaseDur, t - this.phaseStart)
      if (kind === 'think') this.forced = null
    }
  }

  subscribe = (cb: (s: LaneSnapshot) => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  // ── state machine ──

  private enter(phase: CarPhase, start: number, duration: number) {
    this.phase = phase
    this.phaseStart = start
    this.phaseDur = duration
  }

  private startThinking(start: number) {
    const [min, max] = this.options.think
    const dur = this.forced === 'think' ? 3000 : min + this.rand() * (max - min)
    if (this.forced === 'think') this.forced = null
    this.enter('thinking', start, dur)
    this.emit()
  }

  private startMove(start: number, mode: 'move' | 'spin') {
    const cur = this.route[this.idx]!
    const next = this.route[(this.idx + 1) % this.route.length]!
    this.nextHeading = headingBetween(cur, next)
    const target = HEADING_ANGLE[this.nextHeading]
    this.turn = ((target - this.angle + 540) % 360) - 180
    const base = RULES.CELL_TRAVEL_MS[this.speed]
    this.spinDir = this.rand() < 0.5 ? -1 : 1
    this.enter(mode === 'spin' ? 'spinning' : 'moving', start, mode === 'spin' ? base * 1.6 + 500 : base)
    this.emit()
  }

  private decide(endTime: number) {
    const cur = this.route[this.idx]!
    const next = this.route[(this.idx + 1) % this.route.length]!
    const nextHeading = headingBetween(cur, next)
    const best = relativeMove(this.heading, nextHeading)
    const oracleSpeed = SPEEDS[Math.floor(this.rand() * SPEEDS.length)]!
    const isFork = this.route[this.idx]!.x === 10 && this.route[this.idx]!.y === 8

    const r = this.rand()
    let moveOutcome: MoveOutcome = 'optimal'
    let speedOutcome: SpeedOutcome = 'correct'
    if (this.forced === 'crash' || (this.forced === null && r < 0.07)) moveOutcome = 'crash'
    else if (this.forced === null && r < 0.09) moveOutcome = 'timeout'
    else if (this.forced === null && r < 0.2 && isFork) moveOutcome = 'suboptimal'
    if (this.forced === 'spin' || (moveOutcome === 'optimal' && this.forced === null && r > 0.92)) speedOutcome = 'too_fast'
    else if (moveOutcome === 'optimal' && r > 0.84) speedOutcome = 'too_slow'
    this.forced = null

    let answerMove: RelativeMove | null = best
    let answerSpeed: SpeedMode | null = oracleSpeed
    if (moveOutcome === 'crash') answerMove = MOVES.find((m) => m !== best) ?? best
    if (moveOutcome === 'suboptimal') answerMove = MOVES.find((m) => m !== best) ?? best
    if (moveOutcome === 'timeout') {
      answerMove = null
      answerSpeed = null
    }
    if (answerSpeed && speedOutcome === 'too_fast') {
      answerSpeed = oracleSpeed === 'slow' ? 'cruise' : 'boost'
      if (answerSpeed === oracleSpeed) speedOutcome = 'correct'
    }
    if (answerSpeed && speedOutcome === 'too_slow') {
      answerSpeed = 'slow'
      if (oracleSpeed === 'slow') speedOutcome = 'correct'
    }

    const errored = moveOutcome === 'crash' || moveOutcome === 'timeout' || speedOutcome === 'too_fast'
    const hit = moveOutcome === 'optimal' && speedOutcome === 'correct'
    const penaltyMs =
      moveOutcome === 'crash'
        ? RULES.CRASH_PENALTY_MS
        : moveOutcome === 'timeout'
          ? RULES.INVALID_PENALTY_MS
          : speedOutcome === 'too_fast'
            ? RULES.SPIN_PENALTY_MS
            : 0

    const index = this.decisions
    const record: DecisionRecord = {
      id: `${this.engine}-${index}`,
      engine: this.engine,
      index,
      lap: this.lap,
      cell: cur,
      heading: this.heading,
      observation: {
        decisionIndex: index,
        lap: this.lap,
        totalLaps: TOTAL_LAPS,
        heading: this.heading,
        currentSpeed: this.speed,
        difficulty: 'normal',
      },
      oracle: {
        bestMove: best,
        validMoves: [best],
        speedByMove: { [best]: oracleSpeed },
        routeLengthByMove: { [best]: 1 },
        isJunction: isFork,
      },
      result: {
        engine: this.engine,
        mode: 'mock',
        model: `demo-${this.engine}`,
        status: moveOutcome === 'timeout' ? 'timeout' : 'ok',
        answer: { move: answerMove, speed: answerSpeed },
      },
      latencyMs: this.phaseDur,
      moveOutcome,
      speedOutcome: moveOutcome === 'timeout' ? 'not_graded' : speedOutcome,
      hit,
      error: errored,
      appliedMove: best,
      appliedSpeed: oracleSpeed,
      penaltyMs,
      raceTimeAtStartMs: Math.round(this.phaseStart - this.startedAt),
    }
    this.lastRecord = record
    this.decisions += 1
    this.thinkingMs += this.phaseDur
    this.penaltyMs += penaltyMs
    this.speed = oracleSpeed
    this.nextMode = moveOutcome === 'crash' ? 'crash' : speedOutcome === 'too_fast' ? 'spin' : 'move'

    if (this.nextMode === 'crash') {
      this.crashSide = this.rand() < 0.5 ? -1 : 1
      this.nextHeading = nextHeading
      this.enter('crashed', endTime, 1200)
      this.emit()
    } else {
      this.startMove(endTime, this.nextMode === 'spin' ? 'spin' : 'move')
    }
  }

  private arrive(endTime: number) {
    this.movingMs += this.phaseDur
    this.angle += this.turn
    this.turn = 0
    this.heading = this.nextHeading
    this.idx += 1
    if (this.idx >= this.route.length) {
      this.idx = 0
      const race = endTime - this.startedAt
      this.lapTimes.push(Math.round(race - this.lapStartRace))
      this.lapStartRace = race
      if (this.lap >= TOTAL_LAPS) {
        this.enterFinished(endTime)
        return
      }
      this.lap += 1
      this.hazards = DEMO_HAZARD_SETS[(this.lap - 1) % DEMO_HAZARD_SETS.length]!
      this.route = this.rand() < 0.5 ? DEMO_ROUTE_DETOUR : DEMO_ROUTE_SHORT
    }
    this.startThinking(endTime)
  }

  private enterFinished(t: number) {
    this.finishedAtRace = t - this.startedAt
    const cur = DEMO_TRACK.start.cell
    this.route = DEMO_ROUTE_SHORT
    this.idx = Math.max(0, DEMO_ROUTE_SHORT.findIndex((c) => c.x === cur.x && c.y === cur.y))
    this.enter('finished', t, 6000)
    this.emit()
  }

  private advance() {
    if (this.paused) return
    const t = this.clock()
    for (let guard = 0; guard < 60; guard++) {
      const end = this.phaseStart + this.phaseDur
      if (t < end) return
      switch (this.phase) {
        case 'idle':
          this.startThinking(end)
          break
        case 'thinking':
          this.decide(end)
          break
        case 'crashed':
          // Towed back onto the best route, then continue.
          this.startMove(end, 'move')
          break
        case 'moving':
        case 'spinning':
          this.arrive(end)
          break
        case 'finished':
          this.reset()
          return
      }
    }
    this.phaseStart = t
  }

  // ── outputs ──

  private pose(t: number): CarPose {
    const cur = this.route[this.idx]!
    const cx = cur.x + 0.5
    const cy = cur.y + 0.5
    const u = clamp01((t - this.phaseStart) / this.phaseDur)
    const next = this.route[(this.idx + 1) % this.route.length]!
    if (this.phase === 'moving' || this.phase === 'spinning') {
      let angle = this.angle + this.turn * smooth(clamp01(u / 0.45))
      if (this.phase === 'spinning') angle += this.spinDir * 360 * easeOut(u)
      return { x: cx + (next.x - cur.x) * u, y: cy + (next.y - cur.y) * u, angleDeg: angle }
    }
    if (this.phase === 'crashed') {
      const fx = next.x - cur.x
      const fy = next.y - cur.y
      const lurch = easeOut(clamp01(u * 3)) * (1 - smooth(clamp01((u - 0.8) / 0.2)))
      const d = 0.3 * lurch * this.crashSide
      return { x: cx - fy * d + fx * 0.12 * lurch, y: cy + fx * d + fy * 0.12 * lurch, angleDeg: this.angle + this.crashSide * 38 * lurch }
    }
    return { x: cx, y: cy, angleDeg: this.angle }
  }

  readonly getFrame = (): LiveFrame => {
    this.advance()
    const t = this.paused ? this.pausedAt - this.pausedTotal : this.clock()
    return {
      pose: this.pose(t),
      phase: this.phase,
      raceTimeMs: this.raceTime(t),
      thinkingElapsedMs: this.phase === 'thinking' ? t - this.phaseStart : null,
    }
  }

  snapshot = (): LaneSnapshot => {
    const t = this.clock()
    const cur = this.route[this.idx]!
    const race = this.raceTime(t)
    return {
      engine: this.engine,
      status: this.paused ? 'paused' : this.phase === 'finished' ? 'finished' : this.phase === 'idle' ? 'idle' : 'running',
      phase: this.phase,
      lap: this.lap,
      totalLaps: TOTAL_LAPS,
      cell: cur,
      heading: this.heading,
      speed: this.speed,
      raceTimeMs: race,
      thinkingTimeMs: this.thinkingMs,
      movingTimeMs: this.movingMs,
      penaltyTimeMs: this.penaltyMs,
      decisions: this.decisions,
      thinkingSinceMs: this.phase === 'thinking' ? this.phaseStart - this.startedAt : null,
      lapTimesMs: [...this.lapTimes],
      progress:
        this.phase === 'finished' ? 1 : ((this.lap - 1) * this.route.length + this.idx) / (TOTAL_LAPS * this.route.length),
      hazards: this.hazards,
      lastRecord: this.lastRecord,
    }
  }

  private emit() {
    if (this.listeners.size === 0) return
    const s = this.snapshot()
    for (const l of this.listeners) l(s)
  }
}

// ─────────────────────────────── Demo component ───────────────────────────────

const BUTTON =
  'rounded-md bg-panel-2 px-3 py-1.5 text-xs font-medium text-ink ring-1 ring-line transition-colors hover:bg-line focus-visible:outline-2 focus-visible:outline-info'

export function TrackViewDemo() {
  const [lanes] = useState(() => ({
    gpt: new FakeLane('gpt', { think: [700, 2400], seed: 11 }),
    jev: new FakeLane('jev', { think: [120, 420], seed: 29 }),
  }))
  const [gpt, setGpt] = useState(() => lanes.gpt.snapshot())
  const [jev, setJev] = useState(() => lanes.jev.snapshot())
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    const offGpt = lanes.gpt.subscribe(setGpt)
    const offJev = lanes.jev.subscribe(setJev)
    return () => {
      offGpt()
      offJev()
    }
  }, [lanes])

  const both = (fn: (lane: FakeLane) => void) => {
    fn(lanes.gpt)
    fn(lanes.jev)
  }

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4 text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Demo del circuito</h2>
          <p className="text-xs text-ink-dim">
            Carriles simulados sobre «{DEMO_TRACK.name}» — solo para revisión visual de TrackView.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              both((l) => l.setPaused(!paused))
              setPaused(!paused)
            }}
          >
            {paused ? 'Reanudar' : 'Pausar'}
          </button>
          <button type="button" className={BUTTON} onClick={() => both((l) => l.force('think'))}>
            Pensar 3 s
          </button>
          <button type="button" className={BUTTON} onClick={() => both((l) => l.force('crash'))}>
            Forzar choque
          </button>
          <button type="button" className={BUTTON} onClick={() => both((l) => l.force('spin'))}>
            Forzar trompo
          </button>
          <button type="button" className={BUTTON} onClick={() => both((l) => l.force('finish'))}>
            Meta
          </button>
          <button type="button" className={BUTTON} onClick={() => both((l) => l.restart())}>
            Reiniciar
          </button>
        </div>
      </header>
      <div className="grid gap-4 lg:grid-cols-2">
        <TrackView
          track={DEMO_TRACK}
          snapshot={gpt}
          getFrame={lanes.gpt.getFrame}
          accent="var(--color-gpt)"
          label="GPT · mock"
        />
        <TrackView
          track={DEMO_TRACK}
          snapshot={jev}
          getFrame={lanes.jev.getFrame}
          accent="var(--color-jev)"
          label="Jev · mock"
        />
      </div>
    </div>
  )
}
