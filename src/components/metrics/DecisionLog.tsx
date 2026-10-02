import clsx from 'clsx'
import { Fragment, useMemo, useState } from 'react'
import type { DecisionLogProps, DecisionRecord, EngineId } from '../../shared/contracts.ts'
import { DASH, fmtMs, fmtPercent } from '../../metrics/index.ts'
import {
  LANE_NAME,
  LANE_STYLE,
  MOVE_ARROW,
  MOVE_LABEL,
  MOVE_OUTCOME_LABEL,
  SPEED_LABEL,
  SPEED_OUTCOME_LABEL,
} from './lanes.ts'
import { LaneDot, Segmented, ToggleChip } from './ui.tsx'

/** Maximum rows rendered at once (newest first). */
export const MAX_LOG_ROWS = 300

type LaneFilter = 'all' | EngineId

type Verdict = 'hit' | 'partial' | 'error'

function verdictOf(r: DecisionRecord): Verdict {
  return r.hit ? 'hit' : r.error ? 'error' : 'partial'
}

const VERDICT_LABEL: Record<Verdict, string> = { hit: 'Acierto', partial: 'Parcial', error: 'Error' }
const VERDICT_CLASS: Record<Verdict, string> = {
  hit: 'border-ok/40 bg-ok/10 text-ok',
  partial: 'border-warn/40 bg-warn/10 text-warn',
  error: 'border-bad/40 bg-bad/10 text-bad',
}
const VERDICT_ICON: Record<Verdict, string> = { hit: '✓', partial: '~', error: '✗' }

/** Race-clock instant at which the decision resolved: merges both lanes chronologically. */
function finishedAt(r: DecisionRecord): number {
  return r.raceTimeAtStartMs + r.latencyMs
}

function outcomeText(r: DecisionRecord): string {
  const parts: string[] = []
  if (r.moveOutcome !== 'optimal') parts.push(MOVE_OUTCOME_LABEL[r.moveOutcome].toLowerCase())
  if (r.speedOutcome === 'too_fast' || r.speedOutcome === 'too_slow') parts.push(SPEED_OUTCOME_LABEL[r.speedOutcome].toLowerCase())
  return parts.length > 0 ? parts.join(' · ') : 'óptimo'
}

/** Filter one lane and keep its newest `limit` rows (records are chronological). */
function newestMatching(records: readonly DecisionRecord[], limit: number, errorsOnly: boolean, junctionsOnly: boolean): DecisionRecord[] {
  const out: DecisionRecord[] = []
  for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
    const r = records[i]
    if (errorsOnly && !r.error) continue
    if (junctionsOnly && !r.oracle.isJunction) continue
    out.push(r)
  }
  return out
}

/** Merge two newest-first arrays into one newest-first array of at most `limit` rows. */
function mergeNewestFirst(a: DecisionRecord[], b: DecisionRecord[], limit: number): DecisionRecord[] {
  const out: DecisionRecord[] = []
  let i = 0
  let j = 0
  while (out.length < limit && (i < a.length || j < b.length)) {
    if (j >= b.length || (i < a.length && finishedAt(a[i]) >= finishedAt(b[j]))) out.push(a[i++])
    else out.push(b[j++])
  }
  return out
}

function Json({ title, value }: { title: string; value: unknown }) {
  const text = useMemo(() => {
    if (value === undefined) return '—'
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }, [value])
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-medium text-ink-dim">{title}</div>
      <pre className="max-h-56 overflow-auto rounded-md border border-line bg-surface p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre text-ink-dim">
        {text}
      </pre>
    </div>
  )
}

function Detail({ r }: { r: DecisionRecord }) {
  return (
    <div className="space-y-3 border-t border-line bg-panel-2/40 px-4 py-3">
      {r.result.errorMessage && (
        <p className="rounded-md border border-bad/30 bg-bad/10 px-2.5 py-1.5 font-mono text-[11px] text-bad">{r.result.errorMessage}</p>
      )}
      <p className="font-mono text-[11px] text-ink-faint">
        {r.id} · {r.result.model} · estado {r.result.status} · penalización {fmtMs(r.penaltyMs)} · aplicó {r.appliedMove}/{r.appliedSpeed}
        {r.result.providerLatencyMs !== undefined && ` · proveedor ${fmtMs(r.result.providerLatencyMs)}`}
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        <Json title="Observación" value={r.observation} />
        <Json title="Oráculo (verdad)" value={r.oracle} />
        <Json title="Solicitud cruda" value={r.result.raw?.request} />
        <Json title="Respuesta cruda" value={r.result.raw?.response} />
      </div>
      <Json title="Respuesta interpretada" value={r.result.answer} />
    </div>
  )
}

function DecisionCell({ r }: { r: DecisionRecord }) {
  const { move, speed } = r.result.answer
  if (move === null) return <span className="text-ink-faint">{r.result.status === 'ok' ? DASH : `sin respuesta (${r.result.status})`}</span>
  return (
    <span>
      <span aria-hidden className="mr-1 text-ink-dim">
        {MOVE_ARROW[move]}
      </span>
      {MOVE_LABEL[move]}
      <span className="text-ink-faint"> · </span>
      {speed ? SPEED_LABEL[speed] : DASH}
    </span>
  )
}

function CorrectCell({ r }: { r: DecisionRecord }) {
  const best = r.oracle.bestMove
  const speed = r.oracle.speedByMove[best]
  return (
    <span className="text-ink-dim">
      <span aria-hidden className="mr-1">
        {MOVE_ARROW[best]}
      </span>
      {MOVE_LABEL[best]}
      <span className="text-ink-faint"> · </span>
      {speed ? SPEED_LABEL[speed] : DASH}
      {r.oracle.isJunction && (
        <span title="Bifurcación: más de un movimiento válido" className="ml-1.5 rounded border border-line px-1 text-[10px] text-ink-faint">
          BIF
        </span>
      )}
    </span>
  )
}

const COLUMNS = ['#', 'Carril', 'Vuelta', 'Decisión', 'Correcto', 'Resultado', 'Confianza', 'Latencia'] as const

/** Merged, newest-first log of every graded decision, with filters and expandable raw payloads. */
export function DecisionLog({ lanes }: DecisionLogProps) {
  const [laneFilter, setLaneFilter] = useState<LaneFilter>('all')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [junctionsOnly, setJunctionsOnly] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  const { gpt, jev } = lanes
  const gptLen = gpt.records.length
  const jevLen = jev.records.length

  // Lengths are dependencies on purpose: the store may append in place (same array identity).
  const rows = useMemo(() => {
    void gptLen
    void jevLen
    const g = laneFilter === 'jev' ? [] : newestMatching(gpt.records, MAX_LOG_ROWS, errorsOnly, junctionsOnly)
    const j = laneFilter === 'gpt' ? [] : newestMatching(jev.records, MAX_LOG_ROWS, errorsOnly, junctionsOnly)
    return mergeNewestFirst(g, j, MAX_LOG_ROWS)
  }, [laneFilter, errorsOnly, junctionsOnly, gpt.records, gptLen, jev.records, jevLen])

  const total = (laneFilter === 'jev' ? 0 : gptLen) + (laneFilter === 'gpt' ? 0 : jevLen)
  const filtered = errorsOnly || junctionsOnly

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <section aria-label="Registro de decisiones" className="overflow-hidden rounded-xl border border-line bg-panel">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Registro de decisiones</h3>
          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-ink-dim">
            {rows.length === 0
              ? 'Sin decisiones'
              : `${rows.length}${rows.length >= MAX_LOG_ROWS ? ` más recientes${filtered ? '' : ` de ${total}`}` : filtered ? ' coincidencias' : ' decisiones'}`}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented
            label="Carril"
            value={laneFilter}
            onChange={setLaneFilter}
            options={[
              { value: 'all', label: 'Todos' },
              { value: 'gpt', label: 'GPT' },
              { value: 'jev', label: 'Jev' },
            ]}
          />
          <ToggleChip checked={errorsOnly} onChange={setErrorsOnly}>
            Solo errores
          </ToggleChip>
          <ToggleChip checked={junctionsOnly} onChange={setJunctionsOnly}>
            Solo bifurcaciones
          </ToggleChip>
        </div>
      </header>

      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full min-w-[56rem] border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-panel-2 text-[11px] text-ink-dim shadow-[0_1px_0_var(--color-line)]">
            <tr>
              {COLUMNS.map((c, i) => (
                <th key={c} scope="col" className={clsx('px-3 py-2 font-medium', i === 0 || i >= 6 ? 'text-right' : 'text-left')}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-10 text-center text-ink-faint">
                  {total === 0 ? 'Las decisiones aparecerán aquí en cuanto los carros empiecen a correr.' : 'Ninguna decisión coincide con los filtros.'}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const verdict = verdictOf(r)
              const expanded = open.has(r.id)
              const conf = r.result.answer.moveConfidence
              return (
                <Fragment key={r.id}>
                  <tr
                    onClick={() => toggle(r.id)}
                    className={clsx(
                      'cursor-pointer border-b border-line/50 transition-colors hover:bg-panel-2/70',
                      expanded && 'bg-panel-2/50',
                    )}
                  >
                    <td className="px-1.5 py-1 text-right">
                      {/* The click bubbles up to the row; the button gives keyboard and screen-reader access. */}
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Ocultar' : 'Ver'} detalle de la decisión ${r.index + 1} de ${LANE_NAME[r.engine]}`}
                        className="rounded px-1.5 py-0.5 font-mono tabular-nums text-ink-dim hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                      >
                        <span aria-hidden className="mr-1 text-[9px] text-ink-faint">
                          {expanded ? '▾' : '▸'}
                        </span>
                        {r.index + 1}
                      </button>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="inline-flex items-center gap-1.5">
                        <LaneDot engine={r.engine} />
                        <span className={clsx('font-medium', LANE_STYLE[r.engine].text)}>{LANE_NAME[r.engine]}</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono tabular-nums text-ink-dim">{r.lap}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-ink">
                      <DecisionCell r={r} />
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <CorrectCell r={r} />
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        <span className={clsx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-none font-semibold', VERDICT_CLASS[verdict])}>
                          <span aria-hidden>{VERDICT_ICON[verdict]}</span>
                          {VERDICT_LABEL[verdict]}
                        </span>
                        <span className="text-ink-dim">{outcomeText(r)}</span>
                      </span>
                    </td>
                    <td className={clsx('px-3 py-1.5 text-right font-mono tabular-nums', conf !== undefined && conf < 0.5 ? 'text-warn' : 'text-ink-dim')}>
                      {conf === undefined ? DASH : fmtPercent(conf, 0)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap tabular-nums text-ink-dim">{fmtMs(r.latencyMs)}</td>
                  </tr>
                  {expanded && (
                    <tr className="border-b border-line/50">
                      <td colSpan={COLUMNS.length} className="p-0">
                        <Detail r={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
