import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEngine } from '../engines/index.ts'
import { RaceRunner, getTrack } from '../sim/index.ts'
import type { DecisionEngine, EngineId, HealthResponse, IRaceRunner, LaneData, ModelsResponse } from '../shared/contracts.ts'
import { RULES } from '../shared/rules.ts'
import { createRaceStore } from './store.ts'
import type { RaceStore, RaceStoreDeps } from './store.ts'

/** Near-instant mock latency so a whole race fits in a few virtual seconds. */
const FAST_PROFILE = {
  latency: { medianMs: 5, sigma: 0.1, minMs: 1, maxMs: 20, spikeProbability: 0 },
  transientErrorRate: 0,
  invalidRate: 0,
}

const OFFLINE: HealthResponse = {
  ok: true,
  engines: { gpt: { live: false, model: 'gpt' }, jev: { live: false, model: 'jev' } },
}
const ONLINE: HealthResponse = {
  ok: true,
  engines: { gpt: { live: true, model: 'gpt-test' }, jev: { live: false, model: 'jev-test' } },
}

const MODELS: ModelsResponse = {
  engines: {
    gpt: { default: 'gpt-test', models: [{ id: 'gpt-test' }, { id: 'gpt-5-mini', reasoning: true }], source: 'provider' },
    jev: { default: 'jev-test', models: [{ id: 'jev-test' }, { id: 'jev-1.13' }], source: 'provider' },
  },
}

interface Harness extends RaceStore {
  /** Every runner ever built, in build order (gpt, jev, gpt, jev, …). */
  built: RaceRunner[]
  aborted: RaceRunner[]
  engines: DecisionEngine[]
}

function makeStore(health: HealthResponse = OFFLINE, extra: Partial<RaceStoreDeps> = {}): Harness {
  const built: RaceRunner[] = []
  const aborted: RaceRunner[] = []
  const engines: DecisionEngine[] = []
  const race = createRaceStore({
    fetchHealth: async () => health,
    fetchModels: async () => MODELS,
    createEngine: (id, mode, opts) => {
      const engine = createEngine(id, mode, { ...opts, profile: FAST_PROFILE })
      engines.push(engine)
      return engine
    },
    createRunner: (track, engine, config, events) => {
      const runner = new RaceRunner(track, engine, config, events, { now: () => Date.now() })
      const abort = runner.abort.bind(runner)
      runner.abort = () => {
        aborted.push(runner)
        abort()
      }
      built.push(runner)
      return runner
    },
    randomSeed: () => 4242,
    ...extra,
  })
  return { ...race, built, aborted, engines }
}

const state = (h: Harness) => h.store.getState()

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Advances virtual time until the race is over (or the safety cap is hit). */
async function runUntilFinished(h: Harness, capMs = 10 * 60_000): Promise<void> {
  for (let t = 0; t < capMs && state(h).raceStatus === 'running'; t += 250) await advance(250)
}

const BASE_CONFIG = { trackId: 'ovalo', laps: 1, difficulty: 'normal' } as const

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('init', () => {
  it('builds one idle runner per lane and loads the health', async () => {
    const h = makeStore(ONLINE)
    expect(state(h).ready).toBe(false)
    const ready = state(h).init()
    // idle runners exist synchronously, before the health answers
    expect(state(h).ready).toBe(true)
    expect(h.built).toHaveLength(2)
    expect(state(h).lanes.gpt.snapshot?.status).toBe('idle')
    expect(state(h).lanes.jev.snapshot?.status).toBe('idle')
    expect(state(h).lanes.gpt.label).toBe('GPT · simulado')
    expect(state(h).lanes.jev.mode).toBe('mock')
    await ready
    expect(state(h).health).toEqual(ONLINE)
    expect(state(h).liveAvailable).toEqual({ gpt: true, jev: false })
    expect(state(h).raceStatus).toBe('idle')
  })

  it('is idempotent: calling it twice (StrictMode) never creates a second pair of runners', async () => {
    const h = makeStore()
    await Promise.all([state(h).init(), state(h).init()])
    await state(h).init()
    expect(h.built).toHaveLength(2)
    expect(h.aborted).toHaveLength(0)
    expect(h.getRunner('gpt')).toBe(h.built[0])
    expect(h.getRunner('jev')).toBe(h.built[1])
  })

  it('falls back to "no live engine" when the health request fails', async () => {
    const h = makeStore(OFFLINE, {
      fetchHealth: async () => {
        throw new Error('boom')
      },
    })
    await state(h).init()
    expect(state(h).liveAvailable).toEqual({ gpt: false, jev: false })
  })

  it('has the documented defaults', () => {
    const h = makeStore()
    expect(state(h).config).toEqual({
      trackId: 'bifurcaciones',
      laps: 2,
      seed: 4242,
      difficulty: 'normal',
      decisionTimeoutMs: RULES.DEFAULT_DECISION_TIMEOUT_MS,
    })
    expect(state(h).modes).toEqual({ gpt: 'mock', jev: 'mock' })
  })
})

describe('full race (mock engines, 1 lap, ovalo)', () => {
  it('finishes for both lanes, accumulating records immutably', async () => {
    const h = makeStore()
    await state(h).init()
    state(h).setConfig(BASE_CONFIG)

    // track every distinct `records` array each lane ever exposed
    const seen: Record<EngineId, Set<LaneData['records']>> = { gpt: new Set(), jev: new Set() }
    h.store.subscribe((s) => {
      seen.gpt.add(s.lanes.gpt.records)
      seen.jev.add(s.lanes.jev.records)
    })

    state(h).start()
    expect(state(h).raceStatus).toBe('running')
    // both lanes started at the same moment
    expect(state(h).lanes.gpt.snapshot?.status).toBe('running')
    expect(state(h).lanes.jev.snapshot?.status).toBe('running')

    await runUntilFinished(h)

    const { lanes } = state(h)
    expect(state(h).raceStatus).toBe('finished')
    for (const id of ['gpt', 'jev'] as const) {
      const lane = lanes[id]
      expect(lane.snapshot?.status).toBe('finished')
      expect(lane.snapshot?.progress).toBe(1)
      expect(lane.snapshot?.lapTimesMs).toHaveLength(1)
      expect(lane.records.length).toBeGreaterThanOrEqual(getTrack('ovalo').lapLength)
      expect(lane.records.length).toBe(lane.snapshot?.decisions)
      expect(lane.records.every((r, i) => r.engine === id && r.index === i)).toBe(true)
      // one new array per appended record (never mutated in place)
      expect(seen[id].size).toBe(lane.records.length + 1)
    }
    // the store copy matches the runner's own log
    expect(lanes.gpt.records).toEqual([...(h.getRunner('gpt') as RaceRunner).getRecords()])
  })

  it('goes back to idle (empty lanes) with reset(), aborting and rebuilding the runners', async () => {
    const h = makeStore()
    await state(h).init()
    state(h).setConfig(BASE_CONFIG)
    state(h).start()
    await advance(3000)
    expect(state(h).lanes.gpt.records.length + state(h).lanes.jev.records.length).toBeGreaterThan(0)

    const [oldGpt, oldJev] = h.built.slice(-2)
    const recordsBefore = state(h).lanes.jev.records.length
    state(h).reset()

    expect(oldGpt.getSnapshot().status).toBe('aborted')
    expect(oldJev.getSnapshot().status).toBe('aborted')
    expect(h.getRunner('gpt')).not.toBe(oldGpt)
    expect(h.getRunner('jev')).not.toBe(oldJev)
    expect(state(h).raceStatus).toBe('idle')
    for (const id of ['gpt', 'jev'] as const) {
      expect(state(h).lanes[id].records).toEqual([])
      expect(state(h).lanes[id].snapshot?.status).toBe('idle')
    }

    // the old runners are dead: time passing changes nothing in the store
    await advance(20_000)
    expect(state(h).lanes.jev.records.length).toBe(0)
    expect(recordsBefore).toBeGreaterThan(0)
    expect(state(h).raceStatus).toBe('idle')
    // never more than one live runner per lane
    expect(h.getRunner('gpt')?.getSnapshot().status).toBe('idle')
  })

  it('start() from finished resets first and runs a fresh race', async () => {
    const h = makeStore()
    await state(h).init()
    state(h).setConfig(BASE_CONFIG)
    state(h).start()
    await runUntilFinished(h)
    expect(state(h).raceStatus).toBe('finished')
    const firstRunRecords = state(h).lanes.gpt.records

    state(h).start()
    expect(state(h).raceStatus).toBe('running')
    expect(state(h).lanes.gpt.records).toEqual([])
    await runUntilFinished(h)
    expect(state(h).raceStatus).toBe('finished')
    expect(state(h).lanes.gpt.records).not.toBe(firstRunRecords)
    // same seed + same config → the same race
    expect(state(h).lanes.gpt.records.length).toBe(firstRunRecords.length)
  })

  it('pause() freezes both lanes and resume() continues the race', async () => {
    const h = makeStore()
    await state(h).init()
    state(h).setConfig(BASE_CONFIG)
    state(h).start()
    await advance(2000)

    state(h).pause()
    expect(state(h).raceStatus).toBe('paused')
    expect(state(h).lanes.gpt.snapshot?.status).toBe('paused')
    expect(state(h).lanes.jev.snapshot?.status).toBe('paused')
    const frozen = state(h).lanes.jev.records.length
    await advance(30_000)
    expect(state(h).lanes.jev.records.length).toBe(frozen)
    expect(state(h).raceStatus).toBe('paused')

    state(h).resume()
    expect(state(h).raceStatus).toBe('running')
    await runUntilFinished(h)
    expect(state(h).raceStatus).toBe('finished')
  })
})

describe('configuration', () => {
  it('rebuilds idle runners on setConfig and gives both lanes the same config', async () => {
    const h = makeStore()
    await state(h).init()
    const before = [h.getRunner('gpt'), h.getRunner('jev')]
    state(h).setConfig({ trackId: 'tecnico', laps: 3, seed: 7, difficulty: 'hard', decisionTimeoutMs: 4000 })
    expect(state(h).config).toEqual({ trackId: 'tecnico', laps: 3, seed: 7, difficulty: 'hard', decisionTimeoutMs: 4000 })
    expect(h.aborted).toContain(before[0] as IRaceRunner)
    expect(h.aborted).toContain(before[1] as IRaceRunner)
    expect(h.getRunner('gpt')).not.toBe(before[0])
    expect(state(h).lanes.gpt.snapshot?.totalLaps).toBe(3)
    expect(state(h).lanes.jev.snapshot?.totalLaps).toBe(3)
    expect(state(h).lanes.gpt.snapshot?.cell).toEqual(state(h).lanes.jev.snapshot?.cell)
    expect(state(h).lanes.gpt.snapshot?.hazards).toEqual(state(h).lanes.jev.snapshot?.hazards)
  })

  it('clamps values and ignores unknown tracks / no-op changes', async () => {
    const h = makeStore()
    await state(h).init()
    state(h).setConfig({ laps: 99, decisionTimeoutMs: 10 })
    expect(state(h).config.laps).toBe(10)
    expect(state(h).config.decisionTimeoutMs).toBe(1000)
    state(h).setConfig({ laps: 0 })
    expect(state(h).config.laps).toBe(1)
    state(h).setConfig({ laps: Number.NaN })
    expect(state(h).config.laps).toBe(1)
    state(h).setConfig({ trackId: 'no-existe' })
    expect(state(h).config.trackId).toBe('bifurcaciones')

    const runner = h.getRunner('gpt')
    state(h).setConfig({ laps: 1 }) // unchanged → no rebuild
    expect(h.getRunner('gpt')).toBe(runner)
  })

  it('randomizeSeed() uses the injected generator', async () => {
    let next = 100
    const h = makeStore(OFFLINE, { randomSeed: () => next++ })
    await state(h).init()
    expect(state(h).config.seed).toBe(100)
    state(h).randomizeSeed()
    expect(state(h).config.seed).toBe(101)
  })

  it('ignores config / mode changes while the race is running or paused', async () => {
    const h = makeStore(ONLINE)
    await state(h).init()
    state(h).setConfig(BASE_CONFIG)
    state(h).start()
    const runner = h.getRunner('gpt')
    state(h).setConfig({ laps: 5 })
    state(h).setMode('gpt', 'live')
    state(h).randomizeSeed()
    expect(state(h).config.laps).toBe(1)
    expect(state(h).config.seed).toBe(4242)
    expect(state(h).modes.gpt).toBe('mock')
    expect(h.getRunner('gpt')).toBe(runner)

    state(h).pause()
    state(h).setConfig({ laps: 5 })
    expect(state(h).config.laps).toBe(1)
    expect(h.getRunner('gpt')).toBe(runner)
  })

  it('only allows live mode for engines the health reports as live', async () => {
    const h = makeStore(ONLINE)
    await state(h).init()

    state(h).setMode('jev', 'live') // jev is not live
    expect(state(h).modes.jev).toBe('mock')

    state(h).setMode('gpt', 'live')
    expect(state(h).modes.gpt).toBe('live')
    expect(state(h).lanes.gpt.mode).toBe('live')
    expect(state(h).lanes.gpt.label).toBe('GPT · gpt-test')
    expect(state(h).lanes.jev.mode).toBe('mock')

    state(h).setMode('gpt', 'mock')
    expect(state(h).lanes.gpt.mode).toBe('mock')
  })

  it('refuses live mode before the health is known', () => {
    const h = makeStore(ONLINE)
    state(h).setMode('gpt', 'live')
    expect(state(h).modes.gpt).toBe('mock')
  })

  it('start() without init() builds the runners itself', async () => {
    const h = makeStore()
    state(h).setConfig(BASE_CONFIG)
    state(h).start()
    expect(h.built.length).toBeGreaterThanOrEqual(2)
    await runUntilFinished(h)
    expect(state(h).raceStatus).toBe('finished')
  })
})

describe('refreshHealth', () => {
  /** fetchHealth answers with whatever `current.health` holds at call time (the server hot-reloads .env). */
  function switchable(initial: HealthResponse) {
    const current = { health: initial }
    const h = makeStore(initial, { fetchHealth: async () => current.health })
    return { h, current }
  }
  const withJev = (model: string, provider = 'OpenCode Zen'): HealthResponse => ({
    ok: true,
    engines: { gpt: { live: true, model: 'gpt-test' }, jev: { live: true, model, provider } },
  })

  it('rebuilds idle lanes so the label shows the new Jev model', async () => {
    const { h, current } = switchable(withJev('jev-1.13-free'))
    await state(h).init()
    state(h).setMode('jev', 'live')
    expect(state(h).lanes.jev.label).toContain('jev-1.13-free')

    current.health = withJev('jev-1.13')
    await state(h).refreshHealth()
    expect(state(h).health?.engines.jev.model).toBe('jev-1.13')
    expect(state(h).lanes.jev).toMatchObject({ mode: 'live', label: expect.stringContaining('jev-1.13') })
    expect(state(h).lanes.jev.label).not.toContain('free')
  })

  it('does nothing when the health did not change', async () => {
    const { h } = switchable(withJev('jev-1.13'))
    await state(h).init()
    const runnersBefore = h.built.length
    await state(h).refreshHealth()
    expect(h.built.length).toBe(runnersBefore)
  })

  it('falls back to mock when a live key disappears', async () => {
    const { h, current } = switchable(withJev('jev-1.13'))
    await state(h).init()
    state(h).setMode('jev', 'live')
    current.health = { ok: true, engines: { gpt: { live: true, model: 'gpt-test' }, jev: { live: false, model: 'jev-1.13-free' } } }
    await state(h).refreshHealth()
    expect(state(h).liveAvailable.jev).toBe(false)
    expect(state(h).lanes.jev.mode).toBe('mock')
  })

  it('never interrupts a running race, but updates the chips', async () => {
    const { h, current } = switchable(withJev('jev-1.13-free'))
    await state(h).init()
    state(h).setConfig(BASE_CONFIG)
    state(h).start()
    const runnersBefore = h.built.length
    const abortedBefore = h.aborted.length
    current.health = withJev('jev-1.13')
    await state(h).refreshHealth()
    expect(state(h).raceStatus).toBe('running')
    expect(h.built.length).toBe(runnersBefore)
    expect(h.aborted.length).toBe(abortedBefore)
    expect(state(h).health?.engines.jev.model).toBe('jev-1.13')
  })
})

describe('model selection', () => {
  const LIVE_BOTH: HealthResponse = {
    ok: true,
    engines: { gpt: { live: true, model: 'gpt-test' }, jev: { live: true, model: 'jev-test' } },
  }

  it('loads the catalogue on init', async () => {
    const h = makeStore(LIVE_BOTH)
    await state(h).init()
    await advance(0)
    expect(state(h).models?.engines.jev.models.map((m) => m.id)).toEqual(['jev-test', 'jev-1.13'])
    expect(state(h).selectedModels).toEqual({ gpt: null, jev: null })
  })

  it('setModel pins the lane model in the engine label and back to the default with null', async () => {
    const h = makeStore(LIVE_BOTH)
    await state(h).init()
    state(h).setMode('jev', 'live')
    state(h).setModel('jev', 'jev-1.13')
    expect(state(h).selectedModels.jev).toBe('jev-1.13')
    expect(state(h).lanes.jev.label).toContain('jev-1.13')
    expect(h.engines.at(-1)?.label).toContain('jev-1.13')
    state(h).setModel('jev', 'jev-test') // the default is stored as null (follows .env)
    expect(state(h).selectedModels.jev).toBeNull()
    expect(state(h).lanes.jev.label).toContain('jev-test')
  })

  it('ignores model changes while racing', async () => {
    const h = makeStore(LIVE_BOTH)
    await state(h).init()
    state(h).setConfig(BASE_CONFIG)
    state(h).start()
    state(h).setModel('gpt', 'gpt-5-mini')
    expect(state(h).selectedModels.gpt).toBeNull()
  })

  it('drops a selection the server no longer lists', async () => {
    let catalogue = MODELS
    const h = makeStore(LIVE_BOTH, { fetchModels: async () => catalogue })
    await state(h).init()
    await advance(0)
    state(h).setModel('jev', 'jev-1.13')
    catalogue = { engines: { ...MODELS.engines, jev: { default: 'jev-test', models: [{ id: 'jev-test' }], source: 'provider' } } }
    await state(h).loadModels(true)
    expect(state(h).selectedModels.jev).toBeNull()
    expect(state(h).lanes.jev.label).not.toContain('jev-1.13')
  })
})
