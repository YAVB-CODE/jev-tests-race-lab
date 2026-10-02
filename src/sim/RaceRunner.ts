/**
 * Drives one lane: at every cell the car stops, asks its engine for a decision (with timeout), the
 * decision is graded against the oracle, penalties are applied and the car moves to the next cell.
 *
 * Time model: the race clock only advances while running (pause freezes it). All phase timers are
 * expressed in race time and re-armed on resume, so pausing never causes timeouts or skipped motion.
 * getFrame() is pure and cheap (meant for requestAnimationFrame in the UI).
 */
import type {
  CarPhase,
  CarPose,
  Cell,
  DecisionEngine,
  DecisionRecord,
  DecisionResult,
  Hazard,
  Heading,
  IRaceRunner,
  LaneSnapshot,
  LaneStatus,
  LiveFrame,
  Observation,
  OracleAnswer,
  RaceConfig,
  RaceRunnerEvents,
  RelativeMove,
  SpeedMode,
  TrackDefinition,
} from '../shared/contracts.ts'
import { RELATIVE_MOVES } from '../shared/contracts.ts'
import { RULES } from '../shared/rules.ts'
import { createRng, hashSeed } from '../shared/rng.ts'
import { analyzeCell, createContext } from './analysis.ts'
import { DIR_VECTORS, cellCenter, cellKey, headingAngle, moveDelta, neighbor, sameCell, turn } from './geometry.ts'
import { gradeDecision } from './grading.ts'
import { getRaceGraph } from './graph.ts'
import { generateHazards } from './hazards.ts'
import { observationFromAnalysis } from './observation.ts'
import { oracleFromAnalysis } from './oracle.ts'

export interface RaceRunnerOptions {
  /** Monotonic wall clock in ms (default: performance.now). Used for the race clock and latency. */
  now?: () => number
  /** Timer primitives (default: global setTimeout / clearTimeout, looked up at call time). */
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** Fraction of a cell the car noses towards the invalid direction when it crashes. */
const CRASH_NOSE = 0.4
/** Bezier handle length (in cells) used to round the corner when the car turns. */
const TURN_HANDLE = 0.35

type Motion =
  | { kind: 'none' }
  | { kind: 'move'; from: Cell; to: Cell; h0: Heading; h1: Heading; delta: number; extraMs: number }
  | { kind: 'crash'; dir: Heading; delta: number }
  | { kind: 'spin' }

type Settlement =
  | { kind: 'result'; result: DecisionResult }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }

interface PendingDecision {
  token: number
  controller: AbortController
  startedWall: number
  startedRace: number
  index: number
  lap: number
  cell: Cell
  heading: Heading
  observation: Observation
  oracle: OracleAnswer
  /** Settled while paused: processed on resume (with the wall time it settled at). */
  held: { settlement: Settlement; at: number } | null
}

interface PlannedMove {
  move: RelativeMove
  speed: SpeedMode
  extraMs: number
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)
const smooth = (t: number): number => t * t * (3 - 2 * t)

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return typeof err === 'string' ? err : 'Engine failed'
}

export class RaceRunner implements IRaceRunner {
  private readonly track: TrackDefinition
  private readonly engine: DecisionEngine
  private readonly config: RaceConfig
  private readonly events: RaceRunnerEvents
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimerFn: (handle: unknown) => void
  private readonly random: () => number
  private readonly laps: number
  private readonly timeoutMs: number

  private status: LaneStatus = 'idle'
  private phase: CarPhase = 'idle'
  private phaseStart = 0
  private phaseDuration = 0
  private motion: Motion = { kind: 'none' }
  private angleBase: number
  private frozenPose: CarPose | null = null

  // Race clock: raceBase ms accumulated, plus wall time since wallBase while running.
  private raceBase = 0
  private wallBase = 0

  private cell: Cell
  private heading: Heading
  private speed: SpeedMode = 'slow'
  private lap = 1
  private lapStart = 0
  private lapTimes: number[] = []
  private stepsThisLap = 0
  private lapProgress = 0
  private hazards: Hazard[]

  private thinkingMs = 0
  private movingMs = 0
  private penaltyMs = 0
  private records: DecisionRecord[] = []
  private lastRecord: DecisionRecord | null = null

  private token = 0
  private pending: PendingDecision | null = null
  private planned: PlannedMove | null = null
  private timerHandle: unknown = null
  private timerDue = 0
  private timerAction: (() => void) | null = null

  constructor(
    track: TrackDefinition,
    engine: DecisionEngine,
    config: RaceConfig,
    events: RaceRunnerEvents = {},
    options: RaceRunnerOptions = {},
  ) {
    this.track = track
    this.engine = engine
    this.config = config
    this.events = events
    this.now = options.now ?? (() => performance.now())
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimerFn = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.laps = Math.max(1, Math.floor(config.laps))
    this.timeoutMs =
      Number.isFinite(config.decisionTimeoutMs) && config.decisionTimeoutMs > 0
        ? config.decisionTimeoutMs
        : RULES.DEFAULT_DECISION_TIMEOUT_MS
    this.random = createRng(hashSeed(config.seed, engine.id, 'engine'))
    getRaceGraph(track) // validates / warms the cache before the race starts
    this.cell = { ...track.start.cell }
    this.heading = track.start.heading
    this.angleBase = headingAngle(this.heading)
    this.hazards = generateHazards(track, config.seed, 1)
  }

  // ───────────────────────────── Public API ─────────────────────────────

  start(): void {
    if (this.status !== 'idle') return
    this.status = 'running'
    this.wallBase = this.now()
    this.raceBase = 0
    this.lapStart = 0
    this.beginThinking()
  }

  pause(): void {
    if (this.status !== 'running') return
    this.raceBase = this.raceNow()
    this.status = 'paused'
    this.disarmTimer()
    this.emitSnapshot()
  }

  resume(): void {
    if (this.status !== 'paused') return
    this.wallBase = this.now()
    this.status = 'running'
    const held = this.pending?.held
    if (held) {
      this.resolveDecision(held.settlement, held.at)
      return
    }
    if (this.timerAction) this.armTimer()
    this.emitSnapshot()
  }

  abort(): void {
    if (this.status === 'finished' || this.status === 'aborted') return
    const race = this.raceNow()
    this.frozenPose = this.poseAt(race)
    this.closePhase(race)
    this.raceBase = race
    this.status = 'aborted'
    this.phase = 'idle'
    this.phaseStart = race
    this.motion = { kind: 'none' }
    this.cancelTimer()
    this.dropPending()
    this.emitSnapshot()
  }

  getFrame(): LiveFrame {
    const race = this.raceNow()
    return {
      pose: this.frozenPose ?? this.poseAt(race),
      phase: this.phase,
      raceTimeMs: race,
      thinkingElapsedMs: this.phase === 'thinking' ? race - this.phaseStart : null,
    }
  }

  getSnapshot(): LaneSnapshot {
    const race = this.raceNow()
    const live = this.phaseBuckets(race)
    return {
      engine: this.engine.id,
      status: this.status,
      phase: this.phase,
      lap: this.lap,
      totalLaps: this.laps,
      cell: { ...this.cell },
      heading: this.heading,
      speed: this.speed,
      raceTimeMs: race,
      thinkingTimeMs: this.thinkingMs + live.thinking,
      movingTimeMs: this.movingMs + live.moving,
      penaltyTimeMs: this.penaltyMs + live.penalty,
      decisions: this.records.length,
      thinkingSinceMs: this.phase === 'thinking' ? this.phaseStart : null,
      lapTimesMs: [...this.lapTimes],
      progress: this.status === 'finished' ? 1 : Math.min(1, (this.lap - 1 + this.lapProgress) / this.laps),
      hazards: this.hazards.map((h) => ({ cell: { ...h.cell }, kind: h.kind })),
      lastRecord: this.lastRecord,
    }
  }

  /** Every graded decision so far, in order. */
  getRecords(): readonly DecisionRecord[] {
    return this.records
  }

  // ───────────────────────────── Clock & timers ─────────────────────────────

  private rawRaceNow(): number {
    return this.status === 'running' ? this.raceBase + (this.now() - this.wallBase) : this.raceBase
  }

  /**
   * Race clock. It never runs past the pending timer's due time: timer lateness (e.g. a throttled
   * background tab) is not race time, so lap times stay comparable between lanes.
   */
  private raceNow(): number {
    const raw = this.rawRaceNow()
    return this.timerAction !== null && raw > this.timerDue ? this.timerDue : raw
  }

  /** Drops wall time spent beyond `due` from the race clock. */
  private rebase(due: number): void {
    const late = this.rawRaceNow() - due
    if (late > 0) this.wallBase += late
  }

  /** Runs `action` when the race clock reaches `dueRace` (suspended while paused). */
  private schedule(dueRace: number, action: () => void): void {
    this.cancelTimer()
    this.timerDue = dueRace
    this.timerAction = action
    if (this.status === 'running') this.armTimer()
  }

  private armTimer(): void {
    this.disarmTimer()
    const delay = Math.max(0, this.timerDue - this.raceNow())
    this.timerHandle = this.setTimer(() => {
      this.timerHandle = null
      const action = this.timerAction
      if (!action || this.status !== 'running') return
      this.rebase(this.timerDue)
      this.timerAction = null
      action()
    }, delay)
  }

  /** Stops the wall timer but keeps the pending action (pause). */
  private disarmTimer(): void {
    if (this.timerHandle !== null) {
      this.clearTimerFn(this.timerHandle)
      this.timerHandle = null
    }
  }

  private cancelTimer(): void {
    this.disarmTimer()
    this.timerAction = null
  }

  // ───────────────────────────── Phases ─────────────────────────────

  private phaseBuckets(race: number): { thinking: number; moving: number; penalty: number } {
    const elapsed = Math.max(0, race - this.phaseStart)
    if (this.status === 'aborted' || this.status === 'finished') return { thinking: 0, moving: 0, penalty: 0 }
    switch (this.phase) {
      case 'thinking':
        return { thinking: elapsed, moving: 0, penalty: 0 }
      case 'crashed':
      case 'spinning':
        return { thinking: 0, moving: 0, penalty: elapsed }
      case 'moving': {
        const extra = this.motion.kind === 'move' ? Math.min(elapsed, this.motion.extraMs) : 0
        return { thinking: 0, moving: elapsed - extra, penalty: extra }
      }
      default:
        return { thinking: 0, moving: 0, penalty: 0 }
    }
  }

  private closePhase(race: number): void {
    const b = this.phaseBuckets(race)
    this.thinkingMs += b.thinking
    this.movingMs += b.moving
    this.penaltyMs += b.penalty
  }

  private enterPhase(phase: CarPhase, durationMs: number, motion: Motion): number {
    const race = this.raceNow()
    this.closePhase(race)
    this.phase = phase
    this.phaseStart = race
    this.phaseDuration = durationMs
    this.motion = motion
    return race
  }

  private beginThinking(): void {
    const race = this.enterPhase('thinking', 0, { kind: 'none' })
    const ctx = createContext(this.track, this.hazards)
    const analysis = analyzeCell(ctx, this.cell, this.heading)
    const oracle = oracleFromAnalysis(analysis)
    const index = this.records.length
    const observation = observationFromAnalysis(
      ctx,
      analysis,
      {
        cell: this.cell,
        heading: this.heading,
        lap: this.lap,
        totalLaps: this.laps,
        decisionIndex: index,
        currentSpeed: this.speed,
      },
      this.config.difficulty,
    )
    const token = ++this.token
    const controller = new AbortController()
    this.pending = {
      token,
      controller,
      startedWall: this.now(),
      startedRace: race,
      index,
      lap: this.lap,
      cell: { ...this.cell },
      heading: this.heading,
      observation,
      oracle,
      held: null,
    }
    this.schedule(race + this.timeoutMs, () => this.settle(token, { kind: 'timeout' }))
    this.emitSnapshot()
    if (this.pending?.token !== token) return // a listener aborted the race

    let promise: Promise<DecisionResult>
    try {
      promise = Promise.resolve(this.engine.decide(observation, { signal: controller.signal, oracle, random: this.random }))
    } catch (err) {
      this.settle(token, { kind: 'error', message: errorMessage(err) })
      return
    }
    promise.then(
      (result) => this.settle(token, { kind: 'result', result }),
      (err: unknown) => this.settle(token, { kind: 'error', message: errorMessage(err) }),
    )
  }

  private settle(token: number, settlement: Settlement): void {
    const pending = this.pending
    if (!pending || pending.token !== token) return
    const at = this.now()
    const deadline = pending.startedRace + this.timeoutMs
    if (this.status === 'running' && settlement.kind !== 'timeout' && this.rawRaceNow() >= deadline) {
      // The deadline passed while the timeout timer was still queued: it is a timeout.
      this.rebase(deadline)
      settlement = { kind: 'timeout' }
    }
    if (this.status === 'paused') {
      pending.held ??= { settlement, at }
      return
    }
    if (this.status !== 'running') return
    this.resolveDecision(settlement, at)
  }

  private resolveDecision(settlement: Settlement, settledWall: number): void {
    const p = this.pending!
    this.pending = null
    this.cancelTimer()
    const latencyMs = Math.max(0, settledWall - p.startedWall)
    if (settlement.kind === 'timeout') p.controller.abort()

    const result = this.toResult(settlement)
    const grade = gradeDecision(p.oracle, result)
    const record: DecisionRecord = {
      id: `${this.engine.id}-${p.index}`,
      engine: this.engine.id,
      index: p.index,
      lap: p.lap,
      cell: p.cell,
      heading: p.heading,
      observation: p.observation,
      oracle: p.oracle,
      result,
      latencyMs,
      ...grade,
      raceTimeAtStartMs: p.startedRace,
    }
    this.records.push(record)
    this.lastRecord = record

    const chosen = result.answer?.move
    if (grade.moveOutcome === 'crash' && chosen && (RELATIVE_MOVES as readonly string[]).includes(chosen)) {
      this.planned = { move: grade.appliedMove, speed: grade.appliedSpeed, extraMs: 0 }
      const dir = turn(this.heading, chosen)
      this.enterPhase('crashed', RULES.CRASH_PENALTY_MS, { kind: 'crash', dir, delta: moveDelta(chosen) })
      this.schedule(this.phaseStart + RULES.CRASH_PENALTY_MS, () => this.beginMove())
    } else if (grade.speedOutcome === 'too_fast') {
      this.planned = { move: grade.appliedMove, speed: grade.appliedSpeed, extraMs: 0 }
      this.enterPhase('spinning', RULES.SPIN_PENALTY_MS, { kind: 'spin' })
      this.schedule(this.phaseStart + RULES.SPIN_PENALTY_MS, () => {
        this.angleBase += 360
        this.beginMove()
      })
    } else {
      // invalid / timeout / error: autopilot crawls to the next cell (penalty included in the move).
      this.planned = { move: grade.appliedMove, speed: grade.appliedSpeed, extraMs: grade.penaltyMs }
      this.beginMove(false)
    }
    this.emit(() => this.events.onDecision?.(record))
    if (this.status !== 'aborted') this.emitSnapshot()
  }

  private toResult(settlement: Settlement): DecisionResult {
    const base = { engine: this.engine.id, mode: this.engine.mode, model: this.engine.label }
    if (settlement.kind === 'timeout') {
      return {
        ...base,
        status: 'timeout',
        answer: { move: null, speed: null },
        errorMessage: `No decision within ${this.timeoutMs} ms`,
      }
    }
    if (settlement.kind === 'error') {
      return { ...base, status: 'error', answer: { move: null, speed: null }, errorMessage: settlement.message }
    }
    const r = settlement.result
    if (!r || typeof r !== 'object') {
      return { ...base, status: 'invalid', answer: { move: null, speed: null }, errorMessage: 'Engine returned no result' }
    }
    return r.answer ? r : { ...r, answer: { move: null, speed: null } }
  }

  /** Starts the move to the next cell. `emit` = false when the caller emits the snapshot itself. */
  private beginMove(emit = true): void {
    const plan = this.planned ?? { move: 'forward', speed: 'slow', extraMs: 0 }
    this.planned = null
    const dir = turn(this.heading, plan.move)
    const to = neighbor(this.cell, dir)
    const duration = RULES.CELL_TRAVEL_MS[plan.speed] + plan.extraMs
    this.speed = plan.speed
    const start = this.enterPhase('moving', duration, {
      kind: 'move',
      from: { ...this.cell },
      to,
      h0: this.heading,
      h1: dir,
      delta: moveDelta(plan.move),
      extraMs: plan.extraMs,
    })
    this.schedule(start + duration, () => this.arrive())
    if (emit) this.emitSnapshot()
  }

  private arrive(): void {
    if (this.motion.kind !== 'move') return
    const { to, h1, delta } = this.motion
    const race = this.raceNow()
    this.closePhase(race)
    this.phase = 'idle' // transient: replaced by beginThinking() or finish() below
    this.phaseStart = race
    this.motion = { kind: 'none' }
    this.cell = to
    this.heading = h1
    this.angleBase += delta
    this.stepsThisLap++

    if (sameCell(to, this.track.start.cell)) {
      this.lapTimes.push(race - this.lapStart)
      if (this.lap >= this.laps) {
        this.finish(race)
        return
      }
      this.lap++
      this.lapStart = race
      this.stepsThisLap = 0
      this.lapProgress = 0
      this.hazards = generateHazards(this.track, this.config.seed, this.lap)
    } else {
      const remaining = getRaceGraph(this.track).distToFinish.get(cellKey(to)) ?? 0
      const fraction = this.stepsThisLap / (this.stepsThisLap + remaining)
      this.lapProgress = Math.min(0.999, Math.max(this.lapProgress, fraction))
    }
    this.beginThinking()
  }

  private finish(race: number): void {
    this.raceBase = race
    this.status = 'finished'
    this.phase = 'finished'
    this.phaseStart = race
    this.lapProgress = 1
    this.cancelTimer()
    this.emitSnapshot()
    const snapshot = this.getSnapshot()
    this.emit(() => this.events.onFinish?.(snapshot))
  }

  private dropPending(): void {
    if (!this.pending) return
    const { controller } = this.pending
    this.pending = null
    this.token++
    controller.abort()
  }

  // ───────────────────────────── Events ─────────────────────────────

  private emitSnapshot(): void {
    if (!this.events.onSnapshot) return
    const snapshot = this.getSnapshot()
    this.emit(() => this.events.onSnapshot?.(snapshot))
  }

  /** Listener errors must not corrupt the race state machine; rethrow them asynchronously. */
  private emit(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      queueMicrotask(() => {
        throw err
      })
    }
  }

  // ───────────────────────────── Pose ─────────────────────────────

  private poseAt(race: number): CarPose {
    const t = this.phaseDuration > 0 ? clamp01((race - this.phaseStart) / this.phaseDuration) : 0
    const motion = this.motion
    if (motion.kind === 'move') return this.movePose(motion, t)
    const c = cellCenter(this.cell)
    if (motion.kind === 'crash') {
      const e = t < 0.15 ? smooth(t / 0.15) : t > 0.8 ? smooth((1 - t) / 0.2) : 1
      const v = DIR_VECTORS[motion.dir]
      return { x: c.x + CRASH_NOSE * e * v.dx, y: c.y + CRASH_NOSE * e * v.dy, angleDeg: this.angleBase + motion.delta * e }
    }
    if (motion.kind === 'spin') return { x: c.x, y: c.y, angleDeg: this.angleBase + 360 * smooth(t) }
    return { x: c.x, y: c.y, angleDeg: this.angleBase }
  }

  private movePose(m: Extract<Motion, { kind: 'move' }>, t: number): CarPose {
    const p = 0.6 * t + 0.4 * smooth(t)
    const a = cellCenter(m.from)
    const b = cellCenter(m.to)
    if (m.delta === 0) return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, angleDeg: this.angleBase }
    // Position on a cubic Bezier tangent to the old heading at A and to the new heading at B.
    const v0 = DIR_VECTORS[m.h0]
    const v1 = DIR_VECTORS[m.h1]
    const p1x = a.x + TURN_HANDLE * v0.dx
    const p1y = a.y + TURN_HANDLE * v0.dy
    const p2x = b.x - TURN_HANDLE * v1.dx
    const p2y = b.y - TURN_HANDLE * v1.dy
    const u = 1 - p
    const x = u * u * u * a.x + 3 * u * u * p * p1x + 3 * u * p * p * p2x + p * p * p * b.x
    const y = u * u * u * a.y + 3 * u * u * p * p1y + 3 * u * p * p * p2y + p * p * p * b.y
    // Rotation eased over the whole move (smoother than following the curve's tangent exactly).
    return { x, y, angleDeg: this.angleBase + m.delta * smooth(t) }
  }
}
