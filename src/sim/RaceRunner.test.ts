import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DecisionEngine,
  DecisionRecord,
  DecisionResult,
  EngineContext,
  EngineId,
  LaneSnapshot,
  Observation,
  RaceConfig,
  RelativeMove,
  SpeedMode,
} from '../shared/contracts.ts'
import { RULES } from '../shared/rules.ts'
import { RaceRunner } from './RaceRunner.ts'
import { getTrack } from './tracks/index.ts'

const ok = (move: RelativeMove, speed: SpeedMode): DecisionResult => ({
  engine: 'jev',
  mode: 'mock',
  model: 'test-model',
  status: 'ok',
  answer: { move, speed },
})

function makeEngine(
  decide: (obs: Observation, ctx: EngineContext) => Promise<DecisionResult>,
  id: EngineId = 'jev',
): DecisionEngine {
  return { id, mode: 'mock', label: `test-${id}`, decide }
}

/** Answers like the oracle after `latencyMs`, rejecting promptly on abort. */
function perfectEngine(latencyMs = 25, id: EngineId = 'jev'): DecisionEngine {
  return makeEngine(
    (_obs, ctx) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(ok(ctx.oracle.bestMove, ctx.oracle.speedByMove[ctx.oracle.bestMove]!)), latencyMs)
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new DOMException('Aborted', 'AbortError'))
        })
      }),
    id,
  )
}

const config = (over: Partial<RaceConfig> = {}): RaceConfig => ({
  trackId: 'ovalo',
  laps: 1,
  seed: 42,
  difficulty: 'normal',
  decisionTimeoutMs: 1000,
  ...over,
})

const clock = { now: () => Date.now() }

async function runToEnd(runner: RaceRunner, stepMs = 500, maxMs = 30 * 60_000): Promise<void> {
  for (let t = 0; t < maxMs && runner.getSnapshot().status === 'running'; t += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs)
  }
}

function expectClockBalanced(s: LaneSnapshot): void {
  expect(s.thinkingTimeMs + s.movingTimeMs + s.penaltyTimeMs).toBeCloseTo(s.raceTimeMs, 6)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RaceRunner', () => {
  it('a perfect engine completes N laps with 100% hits and a consistent clock', async () => {
    const track = getTrack('bifurcaciones')
    const snapshots: LaneSnapshot[] = []
    const records: DecisionRecord[] = []
    const onFinish = vi.fn()
    const runner = new RaceRunner(
      track,
      perfectEngine(25),
      config({ trackId: track.id, laps: 2 }),
      { onSnapshot: (s) => snapshots.push(s), onDecision: (r) => records.push(r), onFinish },
      clock,
    )
    expect(runner.getSnapshot().status).toBe('idle')
    runner.start()
    await runToEnd(runner)

    const s = runner.getSnapshot()
    expect(s.status).toBe('finished')
    expect(s.phase).toBe('finished')
    expect(s.progress).toBe(1)
    expect(s.lap).toBe(2)
    expect(s.lapTimesMs).toHaveLength(2)
    expect(records.length).toBe(s.decisions)
    expect(records.every((r) => r.hit && !r.error && r.penaltyMs === 0)).toBe(true)
    expect(records.map((r) => r.id)).toEqual(records.map((_, i) => `jev-${i}`))
    expect(records.every((r) => r.latencyMs === 25)).toBe(true)
    expect(records.length).toBeGreaterThanOrEqual(2 * track.lapLength)
    expect(s.penaltyTimeMs).toBe(0)
    expect(s.thinkingTimeMs).toBe(25 * records.length)
    expect(s.movingTimeMs).toBe(records.reduce((sum, r) => sum + RULES.CELL_TRAVEL_MS[r.appliedSpeed], 0))
    expectClockBalanced(s)
    expect(s.lapTimesMs[0] + s.lapTimesMs[1]).toBeCloseTo(s.raceTimeMs, 6)
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    // low-frequency snapshots: about one per phase change, never per frame
    expect(snapshots.length).toBeLessThanOrEqual(records.length * 2 + 4)
    // records are graded on the lap they were made in, and raceTimeAtStartMs increases
    expect(records.filter((r) => r.lap === 2).length).toBeGreaterThan(0)
    for (let i = 1; i < records.length; i++) expect(records[i].raceTimeAtStartMs).toBeGreaterThan(records[i - 1].raceTimeAtStartMs)
    // the clock stays frozen after finishing
    const t = runner.getFrame().raceTimeMs
    await vi.advanceTimersByTimeAsync(5000)
    expect(runner.getFrame().raceTimeMs).toBe(t)
  })

  it('an always-left engine crashes (towed onto the best route) but still finishes', async () => {
    const track = getTrack('ovalo')
    const engine = makeEngine(async () => ok('left', 'slow'))
    const runner = new RaceRunner(track, engine, config(), {}, clock)
    runner.start()
    // watch the first crash: car noses towards the invalid (left = North) side
    await vi.advanceTimersByTimeAsync(1)
    const first = runner.getRecords()[0]
    expect(first.moveOutcome).toBe('crash')
    expect(first.appliedMove).toBe('forward')
    expect(first.appliedSpeed).toBe('slow')
    expect(first.penaltyMs).toBe(RULES.CRASH_PENALTY_MS)
    await vi.advanceTimersByTimeAsync(1000)
    const frame = runner.getFrame()
    expect(frame.phase).toBe('crashed')
    expect(frame.pose.y).toBeCloseTo(track.start.cell.y + 0.5 - 0.4, 5)
    expect(frame.pose.angleDeg).toBeCloseTo(0, 5) // heading E (90) turned 90 left
    await runToEnd(runner)

    const s = runner.getSnapshot()
    expect(s.status).toBe('finished')
    const recs = runner.getRecords()
    const crashes = recs.filter((r) => r.moveOutcome === 'crash')
    // the oval is clockwise: "left" is never valid, so every single decision crashes
    expect(crashes).toHaveLength(track.lapLength)
    expect(recs).toHaveLength(track.lapLength)
    expect(s.penaltyTimeMs).toBe(crashes.length * RULES.CRASH_PENALTY_MS)
    expectClockBalanced(s)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('late timers (throttled tab) do not inflate the race clock', async () => {
    const lateBy = 300
    const runner = new RaceRunner(getTrack('ovalo'), perfectEngine(25), config(), {}, {
      now: () => Date.now(),
      setTimer: (cb, ms) => setTimeout(cb, ms + lateBy),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    })
    runner.start()
    let last = 0
    while (runner.getSnapshot().status === 'running') {
      await vi.advanceTimersByTimeAsync(40)
      const t = runner.getFrame().raceTimeMs
      expect(t).toBeGreaterThanOrEqual(last)
      last = t
    }
    const s = runner.getSnapshot()
    const recs = runner.getRecords()
    expect(recs.every((r) => r.hit)).toBe(true)
    expect(s.thinkingTimeMs).toBe(25 * recs.length)
    expect(s.movingTimeMs).toBe(recs.reduce((sum, r) => sum + RULES.CELL_TRAVEL_MS[r.appliedSpeed], 0))
    expect(s.raceTimeMs).toBe(s.thinkingTimeMs + s.movingTimeMs)
  })

  it('a never-resolving engine produces timeouts and the autopilot finishes the race', async () => {
    const signals: AbortSignal[] = []
    const engine = makeEngine((_obs, ctx) => {
      signals.push(ctx.signal)
      return new Promise<DecisionResult>(() => {}) // ignores abort on purpose
    })
    const track = getTrack('ovalo')
    const runner = new RaceRunner(track, engine, config({ decisionTimeoutMs: 100 }), {}, clock)
    runner.start()
    await runToEnd(runner)
    const s = runner.getSnapshot()
    const recs = runner.getRecords()
    expect(s.status).toBe('finished')
    expect(recs).toHaveLength(track.lapLength)
    expect(recs.every((r) => r.moveOutcome === 'timeout' && r.result.status === 'timeout')).toBe(true)
    expect(recs.every((r) => r.latencyMs === 100 && r.penaltyMs === RULES.INVALID_PENALTY_MS)).toBe(true)
    expect(signals.every((sig) => sig.aborted)).toBe(true)
    expect(s.thinkingTimeMs).toBe(100 * recs.length)
    expect(s.penaltyTimeMs).toBe(RULES.INVALID_PENALTY_MS * recs.length)
    expect(s.movingTimeMs).toBe(RULES.CELL_TRAVEL_MS.slow * recs.length)
    expectClockBalanced(s)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('engine exceptions (sync or async) become status "error"', async () => {
    let n = 0
    const engine = makeEngine((_obs, ctx) => {
      n++
      if (n === 1) throw new Error('boom')
      if (n === 2) return Promise.reject(new Error('network down'))
      return Promise.resolve(ok(ctx.oracle.bestMove, ctx.oracle.speedByMove[ctx.oracle.bestMove]!))
    })
    const runner = new RaceRunner(getTrack('ovalo'), engine, config(), {}, clock)
    runner.start()
    await runToEnd(runner)
    const [a, b, c] = runner.getRecords()
    expect(a.moveOutcome).toBe('error')
    expect(a.result.errorMessage).toBe('boom')
    expect(b.moveOutcome).toBe('error')
    expect(b.result.errorMessage).toBe('network down')
    expect(c.hit).toBe(true)
    expect(runner.getSnapshot().status).toBe('finished')
  })

  it('a too-fast answer spins the car 360° and drives on at the correct speed', async () => {
    const engine = makeEngine(async (_obs, ctx) => ok(ctx.oracle.bestMove, 'boost'))
    const runner = new RaceRunner(getTrack('tecnico'), engine, config({ trackId: 'tecnico' }), {}, clock)
    runner.start()
    let spins = 0
    let sawSpin = false
    while (runner.getSnapshot().status === 'running') {
      await vi.advanceTimersByTimeAsync(50)
      if (runner.getFrame().phase === 'spinning') sawSpin = true
    }
    for (const r of runner.getRecords()) {
      if (r.speedOutcome === 'too_fast') {
        spins++
        expect(r.penaltyMs).toBe(RULES.SPIN_PENALTY_MS)
        expect(r.appliedSpeed).toBe(r.oracle.speedByMove[r.appliedMove])
      } else expect(r.speedOutcome).toBe('correct')
    }
    expect(spins).toBeGreaterThan(5)
    expect(sawSpin).toBe(true)
    expect(runner.getSnapshot().penaltyTimeMs).toBe(spins * RULES.SPIN_PENALTY_MS)
  })

  it('pause freezes clock and motion; a decision settled while paused is held until resume', async () => {
    const runner = new RaceRunner(getTrack('ovalo'), perfectEngine(200), config({ decisionTimeoutMs: 1000 }), {}, clock)
    runner.start()
    await vi.advanceTimersByTimeAsync(100)
    runner.pause()
    const frozen = runner.getFrame()
    expect(runner.getSnapshot().status).toBe('paused')
    expect(frozen.phase).toBe('thinking')
    expect(frozen.thinkingElapsedMs).toBe(100)
    await vi.advanceTimersByTimeAsync(60_000) // engine resolves at wall 200 ms, no timeout while paused
    expect(runner.getFrame()).toEqual(frozen)
    expect(runner.getRecords()).toHaveLength(0)
    runner.resume()
    const rec = runner.getRecords()[0]
    expect(rec.moveOutcome).toBe('optimal')
    expect(rec.latencyMs).toBe(200) // real engine latency, not the pause
    expect(runner.getFrame().phase).toBe('moving')
    expect(runner.getFrame().raceTimeMs).toBe(100)

    // pause mid-move: pose stays put, then continues seamlessly
    await vi.advanceTimersByTimeAsync(100)
    runner.pause()
    const mid = runner.getFrame()
    expect(mid.phase).toBe('moving')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runner.getFrame().pose).toEqual(mid.pose)
    runner.resume()
    await vi.advanceTimersByTimeAsync(16)
    const after = runner.getFrame()
    expect(after.pose.x).toBeGreaterThan(mid.pose.x)
    expect(after.raceTimeMs).toBe(mid.raceTimeMs + 16)
    await runToEnd(runner)
    const s = runner.getSnapshot()
    expect(s.status).toBe('finished')
    expectClockBalanced(s)
  })

  it('timeouts are measured on the race clock (paused time does not count)', async () => {
    const engine = makeEngine(() => new Promise<DecisionResult>(() => {}))
    const runner = new RaceRunner(getTrack('ovalo'), engine, config({ decisionTimeoutMs: 300 }), {}, clock)
    runner.start()
    await vi.advanceTimersByTimeAsync(200)
    runner.pause()
    await vi.advanceTimersByTimeAsync(5000)
    runner.resume()
    await vi.advanceTimersByTimeAsync(99)
    expect(runner.getRecords()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(runner.getRecords()[0].moveOutcome).toBe('timeout')
    runner.abort()
  })

  it('abort cancels the in-flight decision and every timer', async () => {
    const signals: AbortSignal[] = []
    const engine = makeEngine((_obs, ctx) => {
      signals.push(ctx.signal)
      return new Promise<DecisionResult>(() => {})
    })
    const onSnapshot = vi.fn()
    const runner = new RaceRunner(getTrack('ovalo'), engine, config(), { onSnapshot }, clock)
    runner.start()
    await vi.advanceTimersByTimeAsync(50)
    runner.abort()
    const s = runner.getSnapshot()
    expect(s.status).toBe('aborted')
    expect(signals[0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(onSnapshot.mock.calls.at(-1)![0].status).toBe('aborted')
    const frame = runner.getFrame()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runner.getFrame()).toEqual(frame)
    expect(runner.getRecords()).toHaveLength(0)
    runner.resume()
    runner.start()
    expect(runner.getSnapshot().status).toBe('aborted')
  })

  it('abort while moving freezes the pose and ignores late engine answers', async () => {
    const runner = new RaceRunner(getTrack('ovalo'), perfectEngine(10), config(), {}, clock)
    runner.start()
    await vi.advanceTimersByTimeAsync(10 + 200)
    expect(runner.getFrame().phase).toBe('moving')
    runner.abort()
    const pose = runner.getFrame().pose
    await vi.advanceTimersByTimeAsync(5000)
    expect(runner.getFrame().pose).toEqual(pose)
    expect(vi.getTimerCount()).toBe(0)
    expectClockBalanced(runner.getSnapshot())
  })

  it('getFrame is smooth: continuous angles, interpolated positions, thinking only while stopped', async () => {
    const track = getTrack('tecnico')
    const runner = new RaceRunner(track, perfectEngine(30), config({ trackId: 'tecnico' }), {}, clock)
    runner.start()
    let prev = runner.getFrame()
    let maxAngleStep = 0
    let maxMoveStep = 0
    let turned = 0
    while (runner.getSnapshot().status === 'running') {
      await vi.advanceTimersByTimeAsync(16)
      const f = runner.getFrame()
      maxAngleStep = Math.max(maxAngleStep, Math.abs(f.pose.angleDeg - prev.pose.angleDeg))
      maxMoveStep = Math.max(maxMoveStep, Math.hypot(f.pose.x - prev.pose.x, f.pose.y - prev.pose.y))
      expect(f.thinkingElapsedMs === null).toBe(f.phase !== 'thinking')
      expect(f.pose.x).toBeGreaterThan(0)
      expect(f.pose.x).toBeLessThan(track.width)
      expect(f.pose.y).toBeGreaterThan(0)
      expect(f.pose.y).toBeLessThan(track.height)
      prev = f
    }
    turned = prev.pose.angleDeg - 90
    expect(maxAngleStep).toBeLessThan(12)
    expect(maxMoveStep).toBeLessThan(0.2)
    // a clockwise lap turns the car exactly +360° net, without 359→0 wrap-arounds
    expect(turned).toBe(360)
  })

  it('gives each lane a reproducible seeded random stream', async () => {
    const draws = (id: EngineId, seed: number) => {
      const seen: number[] = []
      const engine = makeEngine(async (_obs, ctx) => {
        seen.push(ctx.random())
        return ok(ctx.oracle.bestMove, ctx.oracle.speedByMove[ctx.oracle.bestMove]!)
      }, id)
      const runner = new RaceRunner(getTrack('ovalo'), engine, config({ seed }), {}, clock)
      runner.start()
      return { runner, seen }
    }
    const a = draws('gpt', 5)
    const b = draws('gpt', 5)
    const c = draws('jev', 5)
    await vi.advanceTimersByTimeAsync(3000)
    a.runner.abort()
    b.runner.abort()
    c.runner.abort()
    expect(a.seen.length).toBeGreaterThan(3)
    expect(a.seen).toEqual(b.seen.slice(0, a.seen.length))
    expect(a.seen[0]).not.toBe(c.seen[0])
  })

  it('both lanes see identical observations and hazards for the same seed', async () => {
    const seen: Record<EngineId, Observation[]> = { gpt: [], jev: [] }
    const mk = (id: EngineId) =>
      new RaceRunner(
        getTrack('bifurcaciones'),
        makeEngine(async (obs, ctx) => {
          seen[id].push(obs)
          return ok(ctx.oracle.bestMove, ctx.oracle.speedByMove[ctx.oracle.bestMove]!)
        }, id),
        config({ trackId: 'bifurcaciones', difficulty: 'hard', laps: 2 }),
        {},
        clock,
      )
    const gpt = mk('gpt')
    const jev = mk('jev')
    gpt.start()
    jev.start()
    await runToEnd(gpt)
    await runToEnd(jev)
    expect(seen.gpt.length).toBeGreaterThan(100)
    expect(seen.gpt).toEqual(seen.jev)
    expect(gpt.getSnapshot().hazards).toEqual(jev.getSnapshot().hazards)
  })
})
