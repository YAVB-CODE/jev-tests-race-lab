/**
 * App store (zustand).
 *
 * Reactive state holds only plain data (config, modes, health, per-lane records / snapshot). The RaceRunner
 * instances live OUTSIDE of it, in a closure-level map, and are reached with `getRunner(engine)`.
 *
 * Invariants
 *  - At most one runner per lane exists at any time: every rebuild aborts the previous pair first, and the
 *    events of an aborted pair are ignored (generation guard), so a late callback can never touch new state.
 *  - `init()` is idempotent (React StrictMode runs effects twice).
 *  - Both lanes always get the same track / seed / config, and `start()` starts them back to back in the same tick.
 *  - Records are appended IMMUTABLY (a new array per record): the metrics components memoize on array identity.
 */
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { StoreApi } from 'zustand/vanilla'
import { ENGINE_NAMES, createEngine, fetchHealth, fetchModels } from '../engines/index.ts'
import type { CreateEngineOptions } from '../engines/index.ts'
import { RaceRunner, getTrack } from '../sim/index.ts'
import type { RaceRunnerOptions } from '../sim/index.ts'
import type {
  DecisionEngine,
  Difficulty,
  EngineId,
  EngineMode,
  HealthResponse,
  IRaceRunner,
  LaneData,
  LaneStatus,
  ModelsResponse,
  RaceConfig,
  RaceRunnerEvents,
  TrackDefinition,
} from '../shared/contracts.ts'
import { RULES } from '../shared/rules.ts'

export type RaceStatus = 'idle' | 'running' | 'paused' | 'finished'

export const ENGINE_IDS: readonly EngineId[] = ['gpt', 'jev']

export const LAP_LIMITS = { min: 1, max: 10 } as const
export const TIMEOUT_LIMITS_MS = { min: 1000, max: 60_000 } as const
export const SEED_MAX = 999_999

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard']

export interface RaceState {
  /** true once the first pair of idle runners exists (after `init()` ran). */
  ready: boolean
  config: RaceConfig
  /** Mode requested for each lane. 'live' is only accepted when `liveAvailable[engine]`. */
  modes: Record<EngineId, EngineMode>
  /** Last /api/health answer (null while it is loading). */
  health: HealthResponse | null
  /** Last /api/models answer: models selectable per engine (null while loading / backend down). */
  models: ModelsResponse | null
  /** Model picked in the UI per lane; null = the server default (health.engines[id].model). */
  selectedModels: Record<EngineId, string | null>
  liveAvailable: Record<EngineId, boolean>
  raceStatus: RaceStatus
  lanes: Record<EngineId, LaneData>

  /** Builds the idle runners and loads the health. Idempotent. */
  init(): Promise<void>
  /**
   * Re-reads /api/health (the server hot-reloads .env). When an engine's model / provider / availability
   * changed and no race is in progress, the idle runners are rebuilt so lane labels show the new model;
   * a lane in 'live' mode whose key disappeared falls back to 'mock'. Never interrupts a running race.
   */
  refreshHealth(): Promise<void>
  /** Loads the selectable models (`force` re-lists them on the server). Drops selections that are no longer listed. */
  loadModels(force?: boolean): Promise<void>
  /** Picks the model of a lane (null = server default). Ignored while racing; rebuilds the idle runners. */
  setModel(engine: EngineId, model: string | null): void
  /** Changes the race config (ignored while a race is running / paused) and rebuilds the idle runners. */
  setConfig(partial: Partial<RaceConfig>): void
  /** Changes a lane's mode (ignored while racing, and 'live' is ignored when the engine is not live). */
  setMode(engine: EngineId, mode: EngineMode): void
  randomizeSeed(): void
  /** From idle starts; from finished resets first. Both lanes start at the same moment. */
  start(): void
  pause(): void
  resume(): void
  /** Aborts both runners and rebuilds idle ones (records are cleared). */
  reset(): void
}

/** Everything the store needs from the outside world — injectable for tests. */
export interface RaceStoreDeps {
  fetchHealth: () => Promise<HealthResponse>
  fetchModels: (force?: boolean) => Promise<ModelsResponse | null>
  createEngine: (id: EngineId, mode: EngineMode, opts?: CreateEngineOptions) => DecisionEngine
  getTrack: (id: string) => TrackDefinition
  createRunner: (
    track: TrackDefinition,
    engine: DecisionEngine,
    config: RaceConfig,
    events: RaceRunnerEvents,
  ) => IRaceRunner
  /** Random seed in [0, SEED_MAX] for new races. */
  randomSeed: () => number
  /** Passed to the default runner factory (clock / timers). Ignored when `createRunner` is overridden. */
  runnerOptions?: RaceRunnerOptions
}

export interface RaceStore {
  store: StoreApi<RaceState>
  /** The runner of a lane (null before `init()`). Never reactive: use it for `getFrame()` / `getRecords()`. */
  getRunner: (engine: EngineId) => IRaceRunner | null
}

const defaultRandomSeed = (): number => Math.floor(Math.random() * (SEED_MAX + 1))

export function defaultDeps(overrides: Partial<RaceStoreDeps> = {}): RaceStoreDeps {
  const runnerOptions = overrides.runnerOptions
  return {
    fetchHealth: () => fetchHealth(),
    fetchModels: (force) => fetchModels(force),
    createEngine,
    getTrack,
    createRunner: (track, engine, config, events) => new RaceRunner(track, engine, config, events, runnerOptions),
    randomSeed: defaultRandomSeed,
    ...overrides,
  }
}

const isDone = (status: LaneStatus | undefined): boolean => status === 'finished' || status === 'aborted'

const clampInt = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)))

/** Normalizes a (merged) config; unknown / invalid fields keep the previous value. */
function sanitizeConfig(prev: RaceConfig, patch: Partial<RaceConfig>, deps: RaceStoreDeps): RaceConfig {
  const next: RaceConfig = { ...prev }
  if (patch.trackId !== undefined && patch.trackId !== prev.trackId) {
    try {
      deps.getTrack(patch.trackId)
      next.trackId = patch.trackId
    } catch {
      // unknown track: keep the previous one
    }
  }
  if (patch.laps !== undefined && Number.isFinite(patch.laps)) next.laps = clampInt(patch.laps, LAP_LIMITS.min, LAP_LIMITS.max)
  if (patch.seed !== undefined && Number.isFinite(patch.seed)) next.seed = clampInt(patch.seed, 0, 2 ** 31 - 1)
  if (patch.difficulty !== undefined && DIFFICULTIES.includes(patch.difficulty)) next.difficulty = patch.difficulty
  if (patch.decisionTimeoutMs !== undefined && Number.isFinite(patch.decisionTimeoutMs)) {
    next.decisionTimeoutMs = clampInt(patch.decisionTimeoutMs, TIMEOUT_LIMITS_MS.min, TIMEOUT_LIMITS_MS.max)
  }
  return next
}

const sameConfig = (a: RaceConfig, b: RaceConfig): boolean =>
  a.trackId === b.trackId &&
  a.laps === b.laps &&
  a.seed === b.seed &&
  a.difficulty === b.difficulty &&
  a.decisionTimeoutMs === b.decisionTimeoutMs

export function createRaceStore(overrides: Partial<RaceStoreDeps> = {}): RaceStore {
  const deps = defaultDeps(overrides)
  const runners = new Map<EngineId, IRaceRunner>()
  /** Bumped on every rebuild: events from older runners are dropped. */
  let generation = 0
  let initPromise: Promise<void> | null = null

  const store = createStore<RaceState>()((set, get) => {
    const canConfigure = (): boolean => {
      const { raceStatus } = get()
      return raceStatus === 'idle' || raceStatus === 'finished'
    }

    const maybeFinish = (): void => {
      const { raceStatus } = get()
      if (raceStatus !== 'running' && raceStatus !== 'paused') return
      if (ENGINE_IDS.every((id) => isDone(runners.get(id)?.getSnapshot().status))) set({ raceStatus: 'finished' })
    }

    const eventsFor = (id: EngineId, gen: number): RaceRunnerEvents => ({
      onSnapshot: (snapshot) => {
        if (gen !== generation) return
        set((state) => ({ lanes: { ...state.lanes, [id]: { ...state.lanes[id], snapshot } } }))
      },
      onDecision: (record) => {
        if (gen !== generation) return
        set((state) => ({
          lanes: { ...state.lanes, [id]: { ...state.lanes[id], records: [...state.lanes[id].records, record] } },
        }))
      },
      onFinish: () => {
        if (gen !== generation) return
        maybeFinish()
      },
    })

    /**
     * Aborts the current runners and builds a fresh idle pair. `patch` (new config / modes) is applied in the
     * same `set` as the new lanes, so the UI never renders a new track against the snapshots of the old one.
     */
    const rebuild = (patch: Partial<Pick<RaceState, 'config' | 'modes' | 'selectedModels'>> = {}): void => {
      generation += 1
      const gen = generation
      for (const runner of runners.values()) runner.abort()
      runners.clear()

      const { health } = get()
      const config = patch.config ?? get().config
      const modes = patch.modes ?? get().modes
      const selectedModels = patch.selectedModels ?? get().selectedModels
      const track = deps.getTrack(config.trackId)
      const lanes = {} as Record<EngineId, LaneData>
      for (const id of ENGINE_IDS) {
        // The lane's model is pinned for the whole race: editing .env mid-race does not switch it.
        const model = selectedModels[id] ?? health?.engines[id].model
        const engine = deps.createEngine(id, modes[id], { model })
        const runner = deps.createRunner(track, engine, { ...config }, eventsFor(id, gen))
        runners.set(id, runner)
        lanes[id] = { engine: id, label: engine.label, mode: modes[id], records: [], snapshot: runner.getSnapshot() }
      }
      set({ ...patch, lanes, raceStatus: 'idle', ready: true })
    }

    const idleLane = (id: EngineId): LaneData => ({
      engine: id,
      label: ENGINE_NAMES[id],
      mode: 'mock',
      records: [],
      snapshot: null,
    })

    return {
      ready: false,
      config: {
        trackId: 'bifurcaciones',
        laps: 2,
        seed: deps.randomSeed(),
        difficulty: 'normal',
        decisionTimeoutMs: RULES.DEFAULT_DECISION_TIMEOUT_MS,
      },
      modes: { gpt: 'mock', jev: 'mock' },
      health: null,
      models: null,
      selectedModels: { gpt: null, jev: null },
      liveAvailable: { gpt: false, jev: false },
      raceStatus: 'idle',
      lanes: { gpt: idleLane('gpt'), jev: idleLane('jev') },

      init: () => {
        if (initPromise) return initPromise
        rebuild()
        initPromise = (async () => {
          let health: HealthResponse | null = null
          try {
            health = await deps.fetchHealth()
          } catch {
            health = null
          }
          const live = (id: EngineId): boolean => health?.engines[id]?.live === true
          set({ health, liveAvailable: { gpt: live('gpt'), jev: live('jev') } })
          void get().loadModels()
        })()
        return initPromise
      },

      refreshHealth: async () => {
        let health: HealthResponse | null
        try {
          health = await deps.fetchHealth()
        } catch {
          return
        }
        const state = get()
        const before = state.health
        const live = (id: EngineId): boolean => health?.engines[id]?.live === true
        const engineChanged = (id: EngineId): boolean => {
          const a = before?.engines[id]
          const b = health?.engines[id]
          return a?.live !== b?.live || a?.model !== b?.model || a?.provider !== b?.provider
        }
        set({ health, liveAvailable: { gpt: live('gpt'), jev: live('jev') } })
        if (!ENGINE_IDS.some(engineChanged)) return
        // A key / provider / default change on the server can change the catalogue too.
        void get().loadModels(true)
        if (state.raceStatus === 'running' || state.raceStatus === 'paused') return
        if (state.raceStatus === 'finished') return // keep the results on screen; the next start() rebuilds
        const modes = { ...state.modes }
        for (const id of ENGINE_IDS) if (modes[id] === 'live' && !live(id)) modes[id] = 'mock'
        rebuild({ modes })
      },

      loadModels: async (force = false) => {
        const models = await deps.fetchModels(force)
        if (!models) return
        const state = get()
        const selectedModels = { ...state.selectedModels }
        for (const id of ENGINE_IDS) {
          const picked = selectedModels[id]
          if (picked && !models.engines[id].models.some((m) => m.id === picked)) selectedModels[id] = null
        }
        const changed = ENGINE_IDS.some((id) => selectedModels[id] !== state.selectedModels[id])
        set({ models, selectedModels })
        if (changed && canConfigure() && state.raceStatus !== 'finished') rebuild({ selectedModels })
      },

      setModel: (engine, model) => {
        const state = get()
        if (!canConfigure()) return
        const next = model === state.health?.engines[engine].model ? null : model
        if (state.selectedModels[engine] === next) return
        rebuild({ selectedModels: { ...state.selectedModels, [engine]: next } })
      },

      setConfig: (partial) => {
        if (!canConfigure()) return
        const { config } = get()
        const next = sanitizeConfig(config, partial, deps)
        if (sameConfig(config, next)) return
        rebuild({ config: next })
      },

      setMode: (engine, mode) => {
        const state = get()
        if (!canConfigure()) return
        if (mode === 'live' && !state.liveAvailable[engine]) return
        if (state.modes[engine] === mode) return
        rebuild({ modes: { ...state.modes, [engine]: mode } })
      },

      randomizeSeed: () => {
        get().setConfig({ seed: deps.randomSeed() })
      },

      start: () => {
        const { raceStatus } = get()
        if (raceStatus === 'running' || raceStatus === 'paused') return
        if (raceStatus === 'finished' || runners.size === 0) rebuild()
        set({ raceStatus: 'running' })
        for (const runner of runners.values()) runner.start()
      },

      pause: () => {
        if (get().raceStatus !== 'running') return
        for (const runner of runners.values()) runner.pause()
        set({ raceStatus: 'paused' })
      },

      resume: () => {
        if (get().raceStatus !== 'paused') return
        set({ raceStatus: 'running' })
        for (const runner of runners.values()) runner.resume()
        maybeFinish()
      },

      reset: () => {
        rebuild()
      },
    }
  })

  return { store, getRunner: (engine) => runners.get(engine) ?? null }
}

/** The app-wide store. */
export const raceStore: RaceStore = createRaceStore()

export const getRunner = raceStore.getRunner

export function useRaceStore<T>(selector: (state: RaceState) => T): T {
  return useStore(raceStore.store, selector)
}
