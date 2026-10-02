import clsx from 'clsx'
import type { ComponentProps } from 'react'
import type { ComparisonProps } from '../../shared/contracts.ts'
import { exportRunCsv, exportRunJson } from './export.ts'
import type { RunExportMeta } from './export.ts'

const BUTTON =
  'rounded-md border border-line bg-panel-2 px-3 py-1.5 text-xs text-ink transition-colors hover:border-ink-faint hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-info disabled:cursor-not-allowed disabled:opacity-40'

export interface ExportButtonsProps extends ComparisonProps {
  /** Extra run metadata stored in the JSON export (track, seed, difficulty, …). */
  meta?: RunExportMeta
  className?: string
}

/** "Exportar JSON" / "Exportar CSV" buttons wired to exportRunJson / exportRunCsv. */
export function ExportButtons({ lanes, meta, className }: ExportButtonsProps) {
  const empty = lanes.gpt.records.length + lanes.jev.records.length === 0
  const common: Pick<ComponentProps<'button'>, 'type' | 'disabled'> = { type: 'button', disabled: empty }
  return (
    <div className={clsx('flex flex-wrap items-center gap-2', className)}>
      <button {...common} className={BUTTON} title="Métricas calculadas, comparación y todas las decisiones" onClick={() => exportRunJson(lanes, meta)}>
        Exportar JSON
      </button>
      <button {...common} className={BUTTON} title="Una fila por decisión (ambos carriles)" onClick={() => exportRunCsv(lanes)}>
        Exportar CSV
      </button>
    </div>
  )
}
