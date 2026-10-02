import clsx from 'clsx'
import { useEffect, useRef } from 'react'
import { fmtClock } from '../metrics/index.ts'
import { LANE_NAME, LANE_STYLE } from '../components/metrics/lanes.ts'
import { LaneDot } from '../components/metrics/ui.tsx'
import type { EngineId } from '../shared/contracts.ts'
import { ENGINE_IDS, getRunner, useRaceStore } from './store.ts'

/** Race clock of one lane. Written straight into the DOM (no React state) while the lane is running. */
export function LaneClock({ engine, className }: { engine: EngineId; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const status = useRaceStore((s) => s.lanes[engine].snapshot?.status)
  const raceTimeMs = useRaceStore((s) => s.lanes[engine].snapshot?.raceTimeMs)

  useEffect(() => {
    const write = () => {
      if (ref.current) ref.current.textContent = fmtClock(getRunner(engine)?.getFrame().raceTimeMs ?? 0)
    }
    write()
    if (status !== 'running') return
    const id = window.setInterval(write, 100)
    return () => window.clearInterval(id)
  }, [engine, status, raceTimeMs])

  return <span ref={ref} className={clsx('font-mono tabular-nums', className)} title="Reloj de carrera" />
}

function RaceBarRow({ engine, leader }: { engine: EngineId; leader: boolean }) {
  const snapshot = useRaceStore((s) => s.lanes[engine].snapshot)
  const style = LANE_STYLE[engine]
  const progress = Math.round((snapshot?.progress ?? 0) * 100)
  const finished = snapshot?.status === 'finished'

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:flex-nowrap">
      <div className="order-1 flex w-24 shrink-0 items-center gap-2">
        <LaneDot engine={engine} />
        <span className={clsx('text-sm font-semibold', style.text)}>{LANE_NAME[engine]}</span>
        {leader && (
          <span className="rounded border border-line bg-panel-2 px-1 py-0.5 text-[9px] leading-none font-medium text-ink-dim uppercase" title="Va adelante en la carrera">
            Líder
          </span>
        )}
      </div>

      <div
        role="progressbar"
        aria-label={`Progreso de ${LANE_NAME[engine]}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        className="relative order-3 h-3 w-full overflow-hidden rounded-full bg-panel-2 ring-1 ring-line sm:order-2 sm:w-auto sm:flex-1"
      >
        <div
          className={clsx('h-full rounded-full transition-[width] duration-500 ease-out', style.bg)}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="order-2 ml-auto flex shrink-0 items-center justify-end gap-3 text-xs sm:order-3 sm:w-52">
        {finished ? (
          <span className="font-semibold text-ok">🏁 ¡Meta!</span>
        ) : (
          <span className="text-ink-dim">
            Vuelta{' '}
            <span className="font-mono text-ink tabular-nums">
              {snapshot?.lap ?? 1}/{snapshot?.totalLaps ?? 1}
            </span>
          </span>
        )}
        <span className="font-mono text-sm font-semibold tabular-nums text-ink">
          <LaneClock engine={engine} />
        </span>
        <span className="w-9 text-right font-mono text-ink-dim tabular-nums">{progress}%</span>
      </div>
    </div>
  )
}

/** Head-to-head progress of both lanes. */
export function RaceBar() {
  const gpt = useRaceStore((s) => s.lanes.gpt.snapshot?.progress ?? 0)
  const jev = useRaceStore((s) => s.lanes.jev.snapshot?.progress ?? 0)
  const diff = gpt - jev
  const leader: EngineId | null = Math.abs(diff) < 0.01 ? null : diff > 0 ? 'gpt' : 'jev'

  return (
    <section aria-label="Carrera cara a cara" className="space-y-2.5 rounded-xl border border-line bg-panel px-4 py-3.5">
      {ENGINE_IDS.map((id) => (
        <RaceBarRow key={id} engine={id} leader={leader === id} />
      ))}
    </section>
  )
}
