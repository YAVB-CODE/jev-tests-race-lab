import clsx from 'clsx'
import { useMemo } from 'react'
import { LANE_NAME, LANE_STYLE } from '../components/metrics/lanes.ts'
import { LaneDot, ModeBadge } from '../components/metrics/ui.tsx'
import { computeMetrics, fmtClock, fmtMs, fmtPercent } from '../metrics/index.ts'
import type { EngineMetrics } from '../metrics/index.ts'
import type { EngineId } from '../shared/contracts.ts'
import { ENGINE_IDS, useRaceStore } from './store.ts'

function LaneSummary({ engine, metrics, raceTimeMs, winner }: { engine: EngineId; metrics: EngineMetrics; raceTimeMs: number; winner: boolean }) {
  const mode = useRaceStore((s) => s.lanes[engine].mode)
  return (
    <div className={clsx('min-w-0 rounded-lg border px-3 py-2.5', winner ? clsx(LANE_STYLE[engine].border, LANE_STYLE[engine].bgSoft) : 'border-line bg-panel-2/60')}>
      <div className="flex flex-wrap items-center gap-2">
        <LaneDot engine={engine} />
        <span className={clsx('text-sm font-semibold', LANE_STYLE[engine].text)}>{LANE_NAME[engine]}</span>
        <ModeBadge mode={mode} />
        {winner && <span className="text-[11px] font-semibold text-warn">🏆 Ganador</span>}
        <span className="ml-auto font-mono text-sm font-semibold text-ink tabular-nums">{fmtClock(raceTimeMs)}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-dim">
        <b className="font-semibold text-ok">{metrics.hits}</b> {metrics.hits === 1 ? 'acierto' : 'aciertos'} ({fmtPercent(metrics.hitRate, 0)}) ·{' '}
        <b className="font-semibold text-bad">{metrics.errors}</b> {metrics.errors === 1 ? 'error' : 'errores'} · decisión promedio{' '}
        <b className="font-mono font-semibold text-ink">{fmtMs(metrics.latency.mean)}</b>
      </p>
    </div>
  )
}

/** Shown when both lanes crossed the finish line: winner by race time + one line per lane. */
export function FinishBanner() {
  const raceStatus = useRaceStore((s) => s.raceStatus)
  const lanes = useRaceStore((s) => s.lanes)

  const summary = useMemo(() => {
    if (raceStatus !== 'finished') return null
    const metrics = {} as Record<EngineId, EngineMetrics>
    const times = {} as Record<EngineId, number>
    for (const id of ENGINE_IDS) {
      metrics[id] = computeMetrics(lanes[id].records, lanes[id].snapshot)
      times[id] = lanes[id].snapshot?.raceTimeMs ?? Number.POSITIVE_INFINITY
    }
    const winner: EngineId | null = times.gpt === times.jev ? null : times.gpt < times.jev ? 'gpt' : 'jev'
    return { metrics, times, winner }
  }, [raceStatus, lanes])

  if (!summary) return null
  const { metrics, times, winner } = summary
  const loser: EngineId | null = winner === null ? null : winner === 'gpt' ? 'jev' : 'gpt'
  const simulated = lanes.gpt.mode === 'mock' || lanes.jev.mode === 'mock'

  return (
    <section role="status" aria-label="Resultado de la carrera" className="rounded-xl border border-warn/40 bg-linear-to-r from-warn/10 via-panel to-panel p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span aria-hidden className="text-2xl">
          🏁
        </span>
        <h2 className="text-lg leading-snug font-semibold text-ink">
          {winner ? (
            <>
              Ganó <span className={LANE_STYLE[winner].text}>{LANE_NAME[winner]}</span> por tiempo de carrera
            </>
          ) : (
            'Empate en tiempo de carrera'
          )}
        </h2>
        {winner && loser && (
          <span className="font-mono text-sm text-ink-dim tabular-nums">
            {fmtClock(times[winner])} vs {fmtClock(times[loser])} · {fmtMs(times[loser] - times[winner])} de ventaja
          </span>
        )}
      </div>
      <div className="mt-3 grid gap-2.5 min-[900px]:grid-cols-2">
        {ENGINE_IDS.map((id) => (
          <LaneSummary key={id} engine={id} metrics={metrics[id]} raceTimeMs={times[id]} winner={winner === id} />
        ))}
      </div>
      {simulated && <p className="mt-2.5 text-[11px] text-warn">Resultado simulado: sirve para la demo, no es una medición de eficacia.</p>}
    </section>
  )
}
