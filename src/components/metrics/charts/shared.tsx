/** Building blocks shared by every chart: card chrome, legend, tooltip box, table twin, axis styling. */
import clsx from 'clsx'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { DASH } from '../../../metrics/index.ts'

// ─────────────────────────────── Card ───────────────────────────────

export interface TableTwin {
  head: string[]
  rows: ReactNode[][]
}

export function ChartCard({
  title,
  subtitle,
  controls,
  legend,
  empty,
  emptyText,
  table,
  minHeightClass = 'min-h-60',
  className,
  children,
}: {
  title: string
  subtitle?: string
  controls?: ReactNode
  legend?: ReactNode
  empty: boolean
  emptyText: string
  table: TableTwin
  minHeightClass?: string
  className?: string
  children: ReactNode
}) {
  const [showTable, setShowTable] = useState(false)
  return (
    <section className={clsx('flex min-w-0 flex-col rounded-xl border border-line bg-panel', className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-3.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[11px] leading-snug text-ink-dim">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {controls}
          <button
            type="button"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
            title="Alternar entre gráfica y tabla de datos"
            className={clsx(
              'rounded-md border px-2 py-1 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-info',
              showTable ? 'border-info/50 bg-info/10 text-ink' : 'border-line bg-panel text-ink-dim hover:text-ink',
            )}
          >
            Tabla
          </button>
        </div>
      </header>
      {legend && <div className="px-4 pt-2">{legend}</div>}
      <div className={clsx('relative mt-2 flex-1', minHeightClass)}>
        {/* Absolute inset gives Recharts a definite box even when the card is stretched by its grid row. */}
        <div className="absolute inset-x-2 top-0 bottom-3">
          {showTable ? (
            <div className="h-full overflow-auto px-2">
              <MiniTable {...table} />
            </div>
          ) : empty ? (
            <div className="grid h-full place-items-center px-6 text-center text-xs text-ink-faint">{emptyText}</div>
          ) : (
            children
          )}
        </div>
      </div>
    </section>
  )
}

function MiniTable({ head, rows }: TableTwin) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="border-b border-line text-ink-dim">
          {head.map((h, i) => (
            <th key={h} scope="col" className={clsx('px-2 py-1.5 font-medium', i === 0 ? 'text-left' : 'text-right')}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={head.length} className="px-2 py-6 text-center text-ink-faint">
              Sin datos todavía.
            </td>
          </tr>
        )}
        {rows.map((r, ri) => (
          <tr key={ri} className="border-b border-line/50 last:border-b-0">
            {r.map((c, ci) => (
              <td key={ci} className={clsx('px-2 py-1.5', ci === 0 ? 'text-left text-ink' : 'text-right font-mono tabular-nums text-ink-dim')}>
                {c ?? DASH}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ─────────────────────────────── Legend ───────────────────────────────

export interface LegendItem {
  key: string
  label: string
  color: string
  kind: 'line' | 'swatch'
  /** Secondary text after the label (e.g. the latest value). */
  note?: string
}

export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-1.5 text-[11px] text-ink-dim">
          {it.kind === 'line' ? (
            <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: it.color }} />
          ) : (
            <span aria-hidden className="size-2.5 rounded-sm" style={{ background: it.color }} />
          )}
          <span className="text-ink">{it.label}</span>
          {it.note && <span className="font-mono tabular-nums">{it.note}</span>}
        </li>
      ))}
    </ul>
  )
}

// ─────────────────────────────── Tooltip ───────────────────────────────

export interface TooltipRow {
  color: string
  label: string
  value: string
  /** Render the line key as a swatch (bars) instead of a stroke (lines). */
  swatch?: boolean
}

/** Values lead (strong), series names follow (secondary); rows are keyed with a short line / swatch. */
export function TooltipBox({ title, rows, footer }: { title?: ReactNode; rows: TooltipRow[]; footer?: ReactNode }) {
  return (
    <div className="pointer-events-none min-w-36 rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-xs shadow-xl shadow-black/40">
      {title && <div className="mb-1.5 font-mono text-[11px] text-ink-dim">{title}</div>}
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            {r.swatch ? (
              <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
            ) : (
              <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: r.color }} />
            )}
            <span className="font-mono font-semibold tabular-nums text-ink">{r.value}</span>
            <span className="text-ink-dim">{r.label}</span>
          </li>
        ))}
      </ul>
      {footer && <div className="mt-1.5 border-t border-line pt-1.5 text-[11px] text-ink-dim">{footer}</div>}
    </div>
  )
}
