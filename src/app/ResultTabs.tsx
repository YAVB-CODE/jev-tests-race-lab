import clsx from 'clsx'
import { useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChartsPanel, ComparisonPanel, DecisionLog } from '../components/metrics/index.ts'
import { useRaceStore } from './store.ts'

type TabId = 'comparison' | 'charts' | 'log'

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'comparison', label: 'Comparación' },
  { id: 'charts', label: 'Gráficas' },
  { id: 'log', label: 'Decisiones' },
]

/** Tabs below the split view. Only the active panel is mounted (the charts are the heavy part). */
export function ResultTabs() {
  const lanes = useRaceStore((s) => s.lanes)
  const [active, setActive] = useState<TabId>('comparison')
  const base = useId()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const total = lanes.gpt.records.length + lanes.jev.records.length

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + TABS.length) % TABS.length
    setActive(TABS[next].id)
    refs.current[next]?.focus()
  }

  return (
    <section aria-label="Resultados" className="min-w-0">
      <div role="tablist" aria-label="Resultados" className="mb-3 flex gap-1 border-b border-line">
        {TABS.map((tab, i) => {
          const selected = tab.id === active
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={clsx(
                '-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info',
                selected ? 'border-info font-semibold text-ink' : 'border-transparent text-ink-dim hover:text-ink',
              )}
            >
              {tab.label}
              {tab.id === 'log' && total > 0 && (
                <span className="rounded-full bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink-dim tabular-nums">{total}</span>
              )}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" id={`${base}-panel-${active}`} aria-labelledby={`${base}-tab-${active}`} tabIndex={0} className="outline-none">
        {active === 'comparison' && <ComparisonPanel lanes={lanes} />}
        {active === 'charts' && <ChartsPanel lanes={lanes} />}
        {active === 'log' && <DecisionLog lanes={lanes} />}
      </div>
    </section>
  )
}
