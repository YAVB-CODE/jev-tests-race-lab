/** Visual QA page: renders every metrics component with seeded fixtures, with streaming and mode controls. */
import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import type { EngineId, EngineMode } from '../../shared/contracts.ts'
import { generateSampleLanes, truncateSampleLane } from '../../metrics/__fixtures__/sampleRecords.ts'
import { ChartsPanel } from './ChartsPanel.tsx'
import { ComparisonPanel } from './ComparisonPanel.tsx'
import { DecisionLog } from './DecisionLog.tsx'
import { ExportButtons } from './ExportButtons.tsx'
import { LaneMetrics } from './LaneMetrics.tsx'
import { LANE_NAME } from './lanes.ts'
import { Segmented } from './ui.tsx'

const BTN =
  'rounded-md border border-line bg-panel-2 px-3 py-1.5 text-xs text-ink transition-colors hover:border-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-info'

const MODE_OPTIONS = [
  { value: 'mock', label: 'SIMULADO' },
  { value: 'live', label: 'LIVE' },
] as const satisfies ReadonlyArray<{ value: EngineMode; label: string }>

export function MetricsDemo() {
  const [count, setCount] = useState(80)
  const [seed, setSeed] = useState(7)
  const [step, setStep] = useState(80)
  const [playing, setPlaying] = useState(false)
  const [modes, setModes] = useState<Record<EngineId, EngineMode>>({ gpt: 'mock', jev: 'mock' })

  const full = useMemo(() => generateSampleLanes({ count, seed, modes }), [count, seed, modes])
  const visible = Math.min(step, count)
  const lanes = useMemo(() => ({ gpt: truncateSampleLane(full.gpt, visible), jev: truncateSampleLane(full.jev, visible) }), [full, visible])

  // Playback stops by itself once every decision is shown (derived, no state sync needed).
  const running = playing && step < count
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setStep((s) => s + 1), 140)
    return () => window.clearInterval(id)
  }, [running])

  return (
    <div className="min-h-full bg-surface text-ink">
      <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
        <header className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-xl border border-line bg-panel p-4">
          <div className="mr-auto">
            <h1 className="text-lg font-semibold">Métricas · demo con datos de ejemplo</h1>
            <p className="mt-0.5 text-xs text-ink-dim">Perfiles ilustrativos generados con semilla; no son mediciones.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BTN}
              onClick={() => {
                if (step >= count) {
                  setStep(0)
                  setPlaying(true)
                } else {
                  setPlaying(!running)
                }
              }}
            >
              {running ? 'Pausar' : step >= count ? 'Repetir' : 'Reproducir'}
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                setPlaying(false)
                setStep(0)
              }}
            >
              Vaciar
            </button>
            <button type="button" className={BTN} onClick={() => setSeed((s) => s + 1)}>
              Nueva semilla ({seed})
            </button>
          </div>

          <label className="flex min-w-48 flex-col gap-1 text-[11px] text-ink-dim">
            <span>
              Decisiones mostradas:{' '}
              <span className="font-mono text-ink tabular-nums">
                {visible}/{count}
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={count}
              value={visible}
              onChange={(e) => {
                setPlaying(false)
                setStep(Number(e.target.value))
              }}
              className="accent-info"
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-ink-dim">
            <span>
              Total: <span className="font-mono text-ink tabular-nums">{count}</span>
            </span>
            <input
              type="range"
              min={20}
              max={600}
              step={20}
              value={count}
              onChange={(e) => {
                const next = Number(e.target.value)
                setCount(next)
                setStep((s) => Math.min(s, next))
              }}
              className="accent-info"
            />
          </label>

          {(['gpt', 'jev'] as const).map((id) => (
            <div key={id} className="flex flex-col gap-1 text-[11px] text-ink-dim">
              <span>Modo {LANE_NAME[id]}</span>
              <Segmented
                label={`Modo de ${LANE_NAME[id]}`}
                value={modes[id]}
                options={MODE_OPTIONS}
                onChange={(m) => setModes((prev) => ({ ...prev, [id]: m }))}
              />
            </div>
          ))}
        </header>

        <div className={clsx('grid gap-4', 'lg:grid-cols-2')}>
          <LaneMetrics lane={lanes.gpt} />
          <LaneMetrics lane={lanes.jev} />
        </div>

        <ComparisonPanel lanes={lanes} />
        <ChartsPanel lanes={lanes} />

        <div className="flex justify-end">
          <ExportButtons lanes={lanes} meta={{ source: 'MetricsDemo', seed, count }} />
        </div>
        <DecisionLog lanes={lanes} />
      </div>
    </div>
  )
}
