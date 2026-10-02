import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { EngineId, EngineMode } from '../../shared/contracts.ts'
import { LANE_STYLE } from './lanes.ts'

/** SIMULADO (warn) / LIVE (ok). */
export function ModeBadge({ mode, className }: { mode: EngineMode; className?: string }) {
  const live = mode === 'live'
  return (
    <span
      title={
        live
          ? 'Llamadas reales al proveedor: estas métricas sí miden la eficacia.'
          : 'Motor local con perfiles parametrizados: no es una medición.'
      }
      className={clsx(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none font-semibold tracking-wider',
        live ? 'border-ok/40 bg-ok/10 text-ok' : 'border-warn/40 bg-warn/10 text-warn',
        className,
      )}
    >
      <span aria-hidden className={clsx('size-1.5 rounded-full', live ? 'bg-ok' : 'bg-warn')} />
      {live ? 'LIVE' : 'SIMULADO'}
    </span>
  )
}

/** Small colored dot identifying a lane (non-text identity channel). */
export function LaneDot({ engine, className }: { engine: EngineId; className?: string }) {
  return <span aria-hidden className={clsx('inline-block size-2.5 shrink-0 rounded-full', LANE_STYLE[engine].bg, className)} />
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

/** Compact radio-style segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-md border border-line bg-panel">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={clsx(
              'px-2.5 py-1 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info',
              active ? 'bg-panel-2 font-medium text-ink' : 'text-ink-dim hover:bg-panel-2/60 hover:text-ink',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Checkbox styled as a chip. */
export function ToggleChip({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
}) {
  return (
    <label
      className={clsx(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors select-none',
        'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-info',
        checked ? 'border-info/50 bg-info/10 text-ink' : 'border-line bg-panel text-ink-dim hover:text-ink',
      )}
    >
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className={clsx('grid size-3 place-items-center rounded-sm border text-[9px] leading-none', checked ? 'border-info bg-info text-surface' : 'border-ink-faint')}
      >
        {checked ? '✓' : ''}
      </span>
      {children}
    </label>
  )
}
