/**
 * Jev Race Lab — shared contracts.
 *
 * FROZEN INTERFACE. Every module (sim, engines, server, UI, metrics) talks to the
 * others only through these types. Do not change them without the lead's approval;
 * if you need a change, implement around it and report it.
 *
 * Coordinates: grid cells, x grows to the East (right), y grows to the South (down).
 * Headings are absolute compass directions. Moves are relative to the car's heading.
 */

// ─────────────────────────────── Geometry ───────────────────────────────

export type Heading = 'N' | 'E' | 'S' | 'W'
export type RelativeMove = 'forward' | 'left' | 'right'
export type SpeedMode = 'slow' | 'cruise' | 'boost'

export const HEADINGS: readonly Heading[] = ['N', 'E', 'S', 'W']
export const RELATIVE_MOVES: readonly RelativeMove[] = ['forward', 'left', 'right']
export const SPEED_MODES: readonly SpeedMode[] = ['slow', 'cruise', 'boost']

export interface Cell {
  x: number
  y: number
}

// ──────────────────────────────── Track ─────────────────────────────────

export interface TrackTile {
  x: number
  y: number
  /** Absolute directions towards the adjacent road tiles this tile is connected to (2 = road, 3 = fork/merge). */
  exits: Heading[]
  kind: 'road' | 'start' | 'checkpoint'
  /** Index into TrackDefinition.checkpoints when kind === 'checkpoint'. */
  checkpointIndex?: number
}

export interface TrackDefinition {
  id: string
  /** Display name (Spanish). */
  name: string
  /** One-line description (Spanish). */
  description: string
  width: number
  height: number
  /** Only road tiles; every other cell of the grid is off-track. */
  tiles: TrackTile[]
  start: { cell: Cell; heading: Heading }
  /** Ordered checkpoints; the start/finish cell closes the lap after the last one. */
  checkpoints: Cell[]
  /** Length in cells of the shortest valid lap. */
  lapLength: number
  hasForks: boolean
}

export type HazardKind = 'oil' | 'cones'

/** Dynamic per-lap obstacles. `cones` block a cell (entering it is a crash); `oil` requires slow speed. */
export interface Hazard {
  cell: Cell
  kind: HazardKind
}

// ───────────────────────────── Observation ──────────────────────────────
// What the AI sees. BOTH engines receive the exact same Observation object.
// Fairness invariant: the oracle answer must always be derivable from the Observation alone.

export type Difficulty = 'easy' | 'normal' | 'hard'

export interface OptionView {
  move: RelativeMove
  /** Taking this move keeps the car on the track, in race direction (not off-track, not wrong-way). */
  onTrack: boolean
  /** The route behind this move contains cones before it rejoins the main line → taking it is a crash. */
  blocked?: boolean
  /** Hazard in the cell the car would enter. */
  nextCellHazard?: HazardKind | 'none'
  /** Cells the car can drive straight after entering (entered cell included) before it must turn. Capped at RULES.STRAIGHT_RUN_CAP. */
  straightRun?: number
  /** 1-based index of the first oil cell along this route within RULES.SPEED.LOOKAHEAD cells, or null if none. */
  firstOilAt?: number | null
  /** Short English description, e.g. "track continues straight for 3 cells, then curves right; oil at cell 2". */
  summary?: string
  /** Route length in cells to the next checkpoint through this move (null = unreachable). Easy only. */
  distanceToCheckpoint?: number | null
}

export interface LocalMap {
  /** Egocentric ASCII grid: the car is drawn at the bottom-center facing UP (rows[0] is farthest ahead). */
  rows: string[]
  /** Meaning of every character used in `rows`. */
  legend: Record<string, string>
  note: string
}

export interface Observation {
  /** 0-based index of this decision in the race. */
  decisionIndex: number
  /** 1-based current lap. */
  lap: number
  totalLaps: number
  /** Absolute heading of the car. */
  heading: Heading
  currentSpeed: SpeedMode
  difficulty: Difficulty
  /** Always 3 entries (forward, left, right) when present. */
  options?: OptionView[]
  localMap?: LocalMap
  /** Egocentric offset (in cells) to the next checkpoint: ahead > 0 = in front, right > 0 = to the right. */
  nextCheckpoint?: { ahead: number; right: number }
}

// ─────────────────────────────── Oracle ─────────────────────────────────

/** Ground truth computed by the simulator from the full track state. Never sent to live models. */
export interface OracleAnswer {
  /** Shortest valid route to the next checkpoint (ties broken: forward > left > right). */
  bestMove: RelativeMove
  /** On track, in race direction, not blocked by cones. */
  validMoves: RelativeMove[]
  /** Correct speed for each valid move (see RULES.SPEED). */
  speedByMove: Partial<Record<RelativeMove, SpeedMode>>
  /** Route length to the next checkpoint for each valid move. */
  routeLengthByMove: Partial<Record<RelativeMove, number>>
  /** More than one valid move (a fork) — a harder decision. */
  isJunction: boolean
}

// ─────────────────────────────── Engines ────────────────────────────────

export type EngineId = 'gpt' | 'jev'
export type EngineMode = 'live' | 'mock'
export type DecisionStatus = 'ok' | 'invalid' | 'error' | 'timeout'

export interface DecisionAnswer {
  /** null when the engine output could not be parsed into a valid option. */
  move: RelativeMove | null
  speed: SpeedMode | null
  /** Full distributions when the engine provides them (Jev natively; GPT self-reported). */
  moveProbabilities?: Partial<Record<RelativeMove, number>>
  speedProbabilities?: Partial<Record<SpeedMode, number>>
  /** Probability (0..1) the engine assigns to its chosen move. Used for calibration metrics. */
  moveConfidence?: number
  speedConfidence?: number
  /** Jev's native `confidence` statistic for Choice answers (derived from the distribution, not a probability). */
  nativeMoveConfidence?: number
  nativeSpeedConfidence?: number
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface DecisionResult {
  engine: EngineId
  mode: EngineMode
  /** Model that answered, e.g. "gpt-4.1-mini", "jev-1.13", "mock-gpt". */
  model: string
  status: DecisionStatus
  answer: DecisionAnswer
  errorMessage?: string
  /** Upstream call latency measured by the server (live) or simulated latency (mock), in ms. */
  providerLatencyMs?: number
  usage?: TokenUsage
  costUsd?: number
  /** true when usage / cost are estimates (mock engines). */
  estimated?: boolean
  /** Raw payloads for the decision log (request sent upstream, response received). */
  raw?: { request?: unknown; response?: unknown }
}

export interface EngineContext {
  /** Aborted by the runner on timeout / race abort. */
  signal: AbortSignal
  /** Ground truth — ONLY mock engines may read it. Remote engines must never send it anywhere. */
  oracle: OracleAnswer
  /** Seeded RNG in [0, 1) for reproducible mocks. */
  random: () => number
}

export interface DecisionEngine {
  readonly id: EngineId
  readonly mode: EngineMode
  /** UI label, e.g. "GPT · gpt-4.1-mini". */
  readonly label: string
  decide(observation: Observation, ctx: EngineContext): Promise<DecisionResult>
}

// ─────────────────────────────── Records ────────────────────────────────

export type MoveOutcome = 'optimal' | 'suboptimal' | 'crash' | 'invalid' | 'timeout' | 'error'
export type SpeedOutcome = 'correct' | 'too_slow' | 'too_fast' | 'not_graded'

/** One graded decision. Produced by the RaceRunner, consumed by metrics and UI. */
export interface DecisionRecord {
  /** `${engine}-${index}` */
  id: string
  engine: EngineId
  index: number
  lap: number
  cell: Cell
  heading: Heading
  observation: Observation
  oracle: OracleAnswer
  result: DecisionResult
  /** End-to-end wall-clock latency measured by the runner around engine.decide(), in ms. */
  latencyMs: number
  moveOutcome: MoveOutcome
  speedOutcome: SpeedOutcome
  /** Acierto: moveOutcome === 'optimal' && speedOutcome === 'correct'. */
  hit: boolean
  /** Error: moveOutcome ∈ {crash, invalid, timeout, error} || speedOutcome === 'too_fast'. */
  error: boolean
  /** Move actually executed (oracle fallback after crash / invalid / timeout / error). */
  appliedMove: RelativeMove
  appliedSpeed: SpeedMode
  penaltyMs: number
  /** Race clock (ms) when the decision was requested. */
  raceTimeAtStartMs: number
}

// ─────────────────────────────── Runner ─────────────────────────────────

export type LaneStatus = 'idle' | 'running' | 'paused' | 'finished' | 'aborted'
export type CarPhase = 'idle' | 'thinking' | 'moving' | 'crashed' | 'spinning' | 'finished'

/** Continuous pose in grid units: the center of cell (x, y) is (x + 0.5, y + 0.5). angleDeg: 0 = North, clockwise. */
export interface CarPose {
  x: number
  y: number
  angleDeg: number
}

export interface RaceConfig {
  trackId: string
  laps: number
  seed: number
  difficulty: Difficulty
  decisionTimeoutMs: number
}

export interface LaneSnapshot {
  engine: EngineId
  status: LaneStatus
  phase: CarPhase
  /** 1-based; equals totalLaps when finished. */
  lap: number
  totalLaps: number
  cell: Cell
  heading: Heading
  speed: SpeedMode
  /** Race clock = moving + thinking + penalty time (excludes paused time). */
  raceTimeMs: number
  thinkingTimeMs: number
  movingTimeMs: number
  penaltyTimeMs: number
  decisions: number
  /** Race clock when the pending decision started, or null when not thinking. */
  thinkingSinceMs: number | null
  lapTimesMs: number[]
  /** 0..1 overall race progress. */
  progress: number
  /** Hazards active on the current lap. */
  hazards: Hazard[]
  lastRecord: DecisionRecord | null
}

/** Per-animation-frame state, cheap to read inside requestAnimationFrame. */
export interface LiveFrame {
  pose: CarPose
  phase: CarPhase
  raceTimeMs: number
  /** ms elapsed in the pending decision, or null when not thinking. */
  thinkingElapsedMs: number | null
}

export interface RaceRunnerEvents {
  /** Fired on every phase / lap / status change (low frequency — safe to put in React state). */
  onSnapshot?(snapshot: LaneSnapshot): void
  onDecision?(record: DecisionRecord): void
  onFinish?(snapshot: LaneSnapshot): void
}

/** Implemented by `RaceRunner` in src/sim (constructor: track, engine, config, events?). */
export interface IRaceRunner {
  start(): void
  pause(): void
  resume(): void
  abort(): void
  getSnapshot(): LaneSnapshot
  getFrame(): LiveFrame
}

// ──────────────────────────── Backend HTTP ──────────────────────────────

/** POST /api/decide */
export interface DecideRequest {
  engine: EngineId
  observation: Observation
  /** Model id picked in the UI (see GET /api/models). Omitted → the server's default from .env. */
  model?: string
}
/** Always HTTP 200 for model-level failures (status 'invalid' | 'error' inside); non-200 only for bad requests. */
export type DecideResponse = DecisionResult

/** GET /api/health */
export interface HealthResponse {
  ok: true
  /** `provider`: gateway serving the model, for display (e.g. 'OpenAI', 'OpenCode Zen'). */
  engines: Record<EngineId, { live: boolean; model: string; provider?: string }>
}

export interface ModelOption {
  id: string
  /** USD per million tokens, when known. Jev bills input only. */
  inputPerMTok?: number
  outputPerMTok?: number
  /** Where the price comes from: .env, the built-in table (may be outdated) or a free model. */
  priceSource?: 'env' | 'table' | 'free'
  /** GPT reasoning model (gpt-5*, o-series): slower, spends hidden reasoning tokens. */
  reasoning?: boolean
}

export interface EngineModels {
  /** Server default (OPENAI_MODEL / JEV_MODEL). */
  default: string
  provider?: string
  models: ModelOption[]
  /** 'provider' = listed by the provider's /v1/models; 'fallback' = built-in list (no key, or the listing failed). */
  source: 'provider' | 'fallback'
  error?: string
}

/** GET /api/models (?refresh=1 bypasses the server cache) */
export interface ModelsResponse {
  engines: Record<EngineId, EngineModels>
}

// ───────────────────────────── UI props ─────────────────────────────────

/** src/components/track/TrackView.tsx */
export interface TrackViewProps {
  track: TrackDefinition
  snapshot: LaneSnapshot
  /** Called every animation frame (wraps runner.getFrame()). */
  getFrame: () => LiveFrame
  /** CSS color of the lane (var(--color-gpt) / var(--color-jev)). */
  accent: string
  label: string
}

export interface LaneData {
  engine: EngineId
  label: string
  mode: EngineMode
  records: DecisionRecord[]
  snapshot: LaneSnapshot | null
}

/** src/components/metrics/LaneMetrics.tsx — KPI tiles for one lane. */
export interface LaneMetricsProps {
  lane: LaneData
}

/** src/components/metrics/ComparisonPanel.tsx, ChartsPanel.tsx */
export interface ComparisonProps {
  lanes: Record<EngineId, LaneData>
}

/** src/components/metrics/DecisionLog.tsx */
export interface DecisionLogProps {
  lanes: Record<EngineId, LaneData>
}
