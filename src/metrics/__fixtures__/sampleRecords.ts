/**
 * Seeded generator of realistic DecisionRecords + LaneSnapshot for both lanes.
 * Used by the unit tests and the MetricsDemo. The profiles are ILLUSTRATIVE (they are not measurements):
 *  - gpt: slower (log-normal ~1.2 s median), noticeably more errors, over-confident self-reported confidence.
 *  - jev: fast (~0.2 s), more accurate, confidence roughly calibrated.
 */
import type {
  DecisionRecord,
  DecisionStatus,
  EngineId,
  EngineMode,
  Heading,
  LaneData,
  LaneSnapshot,
  MoveOutcome,
  Observation,
  OptionView,
  OracleAnswer,
  RelativeMove,
  SpeedMode,
  SpeedOutcome,
} from '../../shared/contracts.ts'
import { RELATIVE_MOVES, SPEED_MODES } from '../../shared/contracts.ts'
import { RULES } from '../../shared/rules.ts'
import { createRng, gaussian, hashSeed, logNormal } from '../../shared/rng.ts'

interface Profile {
  model: string
  latencyMedianMs: number
  latencySigma: number
  providerShare: number
  pInvalid: number
  pTimeout: number
  pError: number
  /** P(optimal move) for a valid answer on a straight cell / at a junction (jev: replaced by its own confidence). */
  pOptimal: number
  pOptimalJunction: number
  /** Share of wrong answers that are real crashes (the rest are merely suboptimal, junctions only). */
  crashShare: number
  pSpeedCorrect: number
  pSpeedTooFast: number
  inputTokens: number
  outputTokens: number
  usdPerMTokIn: number
  usdPerMTokOut: number
}

const PROFILES: Record<EngineId, Profile> = {
  gpt: {
    model: 'mock-gpt',
    latencyMedianMs: 1250,
    latencySigma: 0.42,
    providerShare: 0.94,
    pInvalid: 0.04,
    pTimeout: 0.012,
    pError: 0.006,
    pOptimal: 0.78,
    pOptimalJunction: 0.58,
    crashShare: 0.45,
    pSpeedCorrect: 0.7,
    pSpeedTooFast: 0.14,
    inputTokens: 940,
    outputTokens: 62,
    usdPerMTokIn: 0.4,
    usdPerMTokOut: 1.6,
  },
  jev: {
    model: 'mock-jev',
    latencyMedianMs: 190,
    latencySigma: 0.3,
    providerShare: 0.88,
    pInvalid: 0.004,
    pTimeout: 0,
    pError: 0.002,
    pOptimal: 0.9, // unused: Jev's correctness follows its own confidence (calibrated)
    pOptimalJunction: 0.84,
    crashShare: 0.6,
    pSpeedCorrect: 0.88,
    pSpeedTooFast: 0.05,
    inputTokens: 780,
    outputTokens: 18,
    usdPerMTokIn: 0.15,
    usdPerMTokOut: 0.6,
  },
}

export interface SampleLaneOptions {
  engine: EngineId
  /** Number of decisions to generate. Default 80. */
  count?: number
  seed?: number
  /** Decisions per lap (a lap time is emitted for each full lap). Default 20. */
  decisionsPerLap?: number
  mode?: EngineMode
  decisionTimeoutMs?: number
}

export interface SampleLane {
  records: DecisionRecord[]
  snapshot: LaneSnapshot
}

const HEADINGS: Heading[] = ['N', 'E', 'S', 'W']
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]
}

function buildOracle(rand: () => number, isJunction: boolean): OracleAnswer {
  const validMoves: RelativeMove[] = isJunction
    ? (['forward', rand() < 0.5 ? 'left' : 'right'] as RelativeMove[])
    : [pick(rand, RELATIVE_MOVES)]
  const speedByMove: OracleAnswer['speedByMove'] = {}
  const routeLengthByMove: OracleAnswer['routeLengthByMove'] = {}
  const base = 3 + Math.floor(rand() * 6)
  validMoves.forEach((m, i) => {
    speedByMove[m] = pick(rand, SPEED_MODES)
    routeLengthByMove[m] = base + i * (1 + Math.floor(rand() * 3))
  })
  return { bestMove: validMoves[0], validMoves, speedByMove, routeLengthByMove, isJunction }
}

function buildObservation(
  rand: () => number,
  index: number,
  lap: number,
  totalLaps: number,
  heading: Heading,
  oracle: OracleAnswer,
): Observation {
  const options: OptionView[] = RELATIVE_MOVES.map((move) => {
    const valid = oracle.validMoves.includes(move)
    const straightRun = valid ? 1 + Math.floor(rand() * 5) : undefined
    return {
      move,
      onTrack: valid,
      blocked: false,
      nextCellHazard: 'none',
      straightRun,
      firstOilAt: null,
      summary: valid ? `track continues for ${straightRun} cells` : 'off track',
      distanceToCheckpoint: oracle.routeLengthByMove[move] ?? null,
    }
  })
  return {
    decisionIndex: index,
    lap,
    totalLaps,
    heading,
    currentSpeed: 'cruise',
    difficulty: 'easy',
    options,
  }
}

function probabilitiesFor<T extends string>(keys: readonly T[], chosen: T, conf: number, rand: () => number): Partial<Record<T, number>> {
  const others = keys.filter((k) => k !== chosen)
  const weights = others.map(() => 0.2 + rand())
  const total = weights.reduce((a, b) => a + b, 0)
  const out: Partial<Record<T, number>> = { [chosen]: conf } as Partial<Record<T, number>>
  others.forEach((k, i) => {
    out[k] = ((1 - conf) * weights[i]) / total
  })
  return out
}

/** Generate one lane of graded decisions plus its final snapshot. Deterministic for a given seed. */
export function generateSampleLane(opts: SampleLaneOptions): SampleLane {
  const { engine } = opts
  const count = opts.count ?? 80
  const perLap = Math.max(1, opts.decisionsPerLap ?? 20)
  const mode: EngineMode = opts.mode ?? 'mock'
  const timeoutMs = opts.decisionTimeoutMs ?? RULES.DEFAULT_DECISION_TIMEOUT_MS
  const p = PROFILES[engine]
  const rand = createRng(hashSeed(opts.seed ?? 7, 'sample', engine))
  const totalLaps = Math.max(1, Math.ceil(count / perLap))

  const records: DecisionRecord[] = []
  let clock = 0
  let thinking = 0
  let moving = 0
  let penalty = 0
  let lapStart = 0
  const lapTimes: number[] = []

  for (let i = 0; i < count; i++) {
    const lap = Math.floor(i / perLap) + 1
    const heading = HEADINGS[Math.floor(i / 3) % 4]
    const isJunction = rand() < 0.28
    const oracle = buildOracle(rand, isJunction)
    const observation = buildObservation(rand, i, lap, totalLaps, heading, oracle)

    // ── Engine answer ──
    let status: DecisionStatus = 'ok'
    const roll = rand()
    if (roll < p.pTimeout) status = 'timeout'
    else if (roll < p.pTimeout + p.pError) status = 'error'
    else if (roll < p.pTimeout + p.pError + p.pInvalid) status = 'invalid'

    let latencyMs = logNormal(rand, p.latencyMedianMs, p.latencySigma)
    if (status === 'timeout') latencyMs = timeoutMs
    else if (status === 'error') latencyMs = Math.min(latencyMs * 0.6, timeoutMs)
    latencyMs = Math.round(Math.min(latencyMs, timeoutMs))

    let move: RelativeMove | null = null
    let speed: SpeedMode | null = null
    let moveOutcome: MoveOutcome
    let speedOutcome: SpeedOutcome = 'not_graded'
    let moveConfidence: number | undefined
    let speedConfidence: number | undefined
    let moveProbabilities: Partial<Record<RelativeMove, number>> | undefined
    let speedProbabilities: Partial<Record<SpeedMode, number>> | undefined

    if (status !== 'ok') {
      moveOutcome = status === 'invalid' ? 'invalid' : status
    } else {
      const bestMove = oracle.bestMove
      const correctSpeed = oracle.speedByMove[bestMove] ?? 'cruise'
      let optimal: boolean
      if (engine === 'jev') {
        // Calibrated: P(correct | confidence) ≈ confidence.
        // Mostly confident, with a tail of uncertain answers (more frequent at junctions).
        const uncertain = rand() < (isJunction ? 0.28 : 0.1)
        moveConfidence = uncertain ? 0.3 + rand() * 0.45 : 0.85 + rand() * 0.14
        optimal = rand() < moveConfidence
      } else {
        optimal = rand() < (isJunction ? p.pOptimalJunction : p.pOptimal)
        // Over-confident: self-reported confidence is high regardless of correctness.
        moveConfidence = clamp01(0.9 - (optimal ? 0 : 0.06) + gaussian(rand) * 0.08)
      }

      if (optimal) {
        move = bestMove
        moveOutcome = 'optimal'
      } else if (isJunction && rand() > p.crashShare) {
        move = oracle.validMoves.find((m) => m !== bestMove) ?? bestMove
        moveOutcome = 'suboptimal'
      } else {
        move = pick(
          rand,
          RELATIVE_MOVES.filter((m) => !oracle.validMoves.includes(m)),
        )
        moveOutcome = 'crash'
      }

      const sRoll = rand()
      if (sRoll < p.pSpeedCorrect) {
        speed = correctSpeed
        speedOutcome = 'correct'
      } else if (sRoll < p.pSpeedCorrect + p.pSpeedTooFast && correctSpeed !== 'boost') {
        speed = correctSpeed === 'slow' ? 'cruise' : 'boost'
        speedOutcome = 'too_fast'
      } else if (correctSpeed !== 'slow') {
        speed = correctSpeed === 'boost' ? 'cruise' : 'slow'
        speedOutcome = 'too_slow'
      } else {
        speed = correctSpeed
        speedOutcome = 'correct'
      }
      speedConfidence = clamp01(moveConfidence - 0.05 + gaussian(rand) * 0.05)
      moveProbabilities = probabilitiesFor(RELATIVE_MOVES, move, moveConfidence, rand)
      speedProbabilities = probabilitiesFor(SPEED_MODES, speed, speedConfidence, rand)
    }

    const hit = moveOutcome === 'optimal' && speedOutcome === 'correct'
    const error =
      moveOutcome === 'crash' ||
      moveOutcome === 'invalid' ||
      moveOutcome === 'timeout' ||
      moveOutcome === 'error' ||
      speedOutcome === 'too_fast'

    const failed = moveOutcome === 'crash' || moveOutcome === 'invalid' || moveOutcome === 'timeout' || moveOutcome === 'error'
    const appliedMove: RelativeMove = failed || move === null ? oracle.bestMove : move
    const appliedSpeed: SpeedMode = failed || speed === null ? 'slow' : speed
    let penaltyMs = 0
    if (moveOutcome === 'crash') penaltyMs += RULES.CRASH_PENALTY_MS
    if (moveOutcome === 'invalid' || moveOutcome === 'timeout' || moveOutcome === 'error') penaltyMs += RULES.INVALID_PENALTY_MS
    if (speedOutcome === 'too_fast') penaltyMs += RULES.SPIN_PENALTY_MS

    const inputTokens = Math.round(p.inputTokens * (0.92 + rand() * 0.16))
    const outputTokens = status === 'ok' ? Math.round(p.outputTokens * (0.85 + rand() * 0.3)) : Math.round(p.outputTokens * 0.2)
    const costUsd = (inputTokens * p.usdPerMTokIn + outputTokens * p.usdPerMTokOut) / 1_000_000
    const providerLatencyMs = Math.round(latencyMs * p.providerShare)

    const request = { engine, observation }
    const record: DecisionRecord = {
      id: `${engine}-${i}`,
      engine,
      index: i,
      lap,
      cell: { x: (i * 3) % 12, y: Math.floor((i * 3) / 12) % 8 },
      heading,
      observation,
      oracle,
      result: {
        engine,
        mode,
        model: p.model,
        status,
        answer: { move, speed, moveConfidence, speedConfidence, moveProbabilities, speedProbabilities },
        errorMessage:
          status === 'ok' ? undefined : status === 'timeout' ? `Timeout after ${timeoutMs} ms` : status === 'invalid' ? 'Output outside the allowed set' : 'Upstream error',
        providerLatencyMs,
        usage: { inputTokens, outputTokens },
        costUsd,
        estimated: mode === 'mock',
        raw: {
          request,
          response: status === 'ok' ? { move, speed, moveProbabilities, speedProbabilities } : { error: status },
        },
      },
      latencyMs,
      moveOutcome,
      speedOutcome,
      hit,
      error,
      appliedMove,
      appliedSpeed,
      penaltyMs,
      raceTimeAtStartMs: Math.round(clock),
    }
    records.push(record)

    const travel = RULES.CELL_TRAVEL_MS[appliedSpeed]
    thinking += latencyMs
    moving += travel
    penalty += penaltyMs
    clock += latencyMs + travel + penaltyMs

    if ((i + 1) % perLap === 0) {
      lapTimes.push(Math.round(clock - lapStart))
      lapStart = clock
    }
  }

  const last = records[records.length - 1] ?? null
  const snapshot: LaneSnapshot = {
    engine,
    status: 'finished',
    phase: 'finished',
    lap: totalLaps,
    totalLaps,
    cell: last?.cell ?? { x: 0, y: 0 },
    heading: last?.heading ?? 'N',
    speed: last?.appliedSpeed ?? 'cruise',
    raceTimeMs: Math.round(clock),
    thinkingTimeMs: Math.round(thinking),
    movingTimeMs: Math.round(moving),
    penaltyTimeMs: Math.round(penalty),
    decisions: records.length,
    thinkingSinceMs: null,
    lapTimesMs: lapTimes,
    progress: 1,
    hazards: [],
    lastRecord: last,
  }
  return { records, snapshot }
}

export interface SampleLanesOptions {
  count?: number
  seed?: number
  decisionsPerLap?: number
  modes?: Partial<Record<EngineId, EngineMode>>
}

const LABELS: Record<EngineId, string> = { gpt: 'GPT · gpt-4.1-mini', jev: 'Jev · System One' }

/** Both lanes, shaped as the UI receives them (LaneData). */
export function generateSampleLanes(opts: SampleLanesOptions = {}): Record<EngineId, LaneData> {
  const build = (engine: EngineId): LaneData => {
    const mode = opts.modes?.[engine] ?? 'mock'
    const { records, snapshot } = generateSampleLane({
      engine,
      mode,
      count: opts.count,
      seed: opts.seed,
      decisionsPerLap: opts.decisionsPerLap,
    })
    return { engine, label: LABELS[engine], mode, records, snapshot }
  }
  return { gpt: build('gpt'), jev: build('jev') }
}

/**
 * A lane as it looks mid-race: the first `n` records and a snapshot recomputed from them.
 * Handy to simulate streaming in the demo and in tests.
 */
export function truncateSampleLane(lane: LaneData, n: number): LaneData {
  const records = lane.records.slice(0, Math.max(0, n))
  if (!lane.snapshot) return { ...lane, records }
  let thinking = 0
  let moving = 0
  let penalty = 0
  const lapTimes: number[] = []
  const perLap = lane.snapshot.totalLaps > 0 ? Math.ceil(lane.records.length / lane.snapshot.totalLaps) : records.length || 1
  let lapStart = 0
  let clock = 0
  records.forEach((r, i) => {
    const travel = RULES.CELL_TRAVEL_MS[r.appliedSpeed]
    thinking += r.latencyMs
    moving += travel
    penalty += r.penaltyMs
    clock += r.latencyMs + travel + r.penaltyMs
    if ((i + 1) % perLap === 0) {
      lapTimes.push(Math.round(clock - lapStart))
      lapStart = clock
    }
  })
  const last = records[records.length - 1] ?? null
  const done = records.length >= lane.records.length
  const snapshot: LaneSnapshot = {
    ...lane.snapshot,
    status: done ? 'finished' : 'running',
    phase: done ? 'finished' : 'thinking',
    lap: last ? last.lap : 1,
    raceTimeMs: Math.round(clock),
    thinkingTimeMs: Math.round(thinking),
    movingTimeMs: Math.round(moving),
    penaltyTimeMs: Math.round(penalty),
    decisions: records.length,
    lapTimesMs: lapTimes,
    progress: lane.records.length > 0 ? records.length / lane.records.length : 0,
    lastRecord: last,
  }
  return { ...lane, records, snapshot }
}
