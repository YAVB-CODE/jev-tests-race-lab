import clsx from 'clsx'
import { Fragment, useMemo } from 'react'
import type { ComparisonProps, EngineId } from '../../shared/contracts.ts'
import { DASH, GROUP_LABELS, compareHeadline, compareLanes } from '../../metrics/index.ts'
import type { ComparisonGroup, ComparisonRow, Winner } from '../../metrics/index.ts'
import { useBothMetrics } from './hooks.ts'
import { LANE_NAME, LANE_STYLE } from './lanes.ts'
import { LaneDot, ModeBadge } from './ui.tsx'

export const SIMULATED_DISCLAIMER = 'Resultados simulados: no son una medición. Usa modo LIVE para validar.'

const GROUP_ORDER: readonly ComparisonGroup[] = ['precision', 'speed', 'race', 'calibration', 'cost']

function Headline({ text }: { text: string }) {
  // "Jev decide 6.3× …" → color the lane name that leads the sentence.
  const m = /^(GPT|Jev)\b(.*)$/.exec(text)
  if (!m) return <>{text}</>
  const engine: EngineId = m[1] === 'GPT' ? 'gpt' : 'jev'
  return (
    <>
      <span className={LANE_STYLE[engine].text}>{m[1]}</span>
      {m[2]}
    </>
  )
}

function ValueCell({ text, engine, winner }: { text: string; engine: EngineId; winner: Winner }) {
  const wins = winner === engine
  return (
    <td
      className={clsx(
        'px-3 py-1.5 text-right font-mono text-xs whitespace-nowrap tabular-nums',
        wins ? clsx('font-semibold text-ink', LANE_STYLE[engine].bgSoft) : 'text-ink-dim',
      )}
    >
      {wins && (
        <span aria-label="mejor" className={clsx('mr-1.5 text-[10px]', LANE_STYLE[engine].text)}>
          ✓
        </span>
      )}
      {text}
    </td>
  )
}

function AdvantageCell({ row }: { row: ComparisonRow }) {
  if (row.better === 'gpt' || row.better === 'jev') {
    const s = LANE_STYLE[row.better]
    return (
      <td className="px-3 py-1.5 text-xs whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5">
          <LaneDot engine={row.better} />
          <span className={clsx('font-semibold', s.text)}>{LANE_NAME[row.better]}</span>
          {row.deltaText && <span className="font-mono tabular-nums text-ink-dim">{row.deltaText}</span>}
        </span>
      </td>
    )
  }
  return (
    <td className="px-3 py-1.5 text-xs whitespace-nowrap text-ink-faint">{row.better === 'tie' ? 'Empate' : DASH}</td>
  )
}

/** Metric-by-metric comparison table with a winner per row and a one-line headline. */
export function ComparisonPanel({ lanes }: ComparisonProps) {
  const metrics = useBothMetrics(lanes)
  const rows = useMemo(() => compareLanes(metrics.gpt, metrics.jev), [metrics])
  const headline = useMemo(() => compareHeadline(rows), [rows])
  const simulated = lanes.gpt.mode === 'mock' || lanes.jev.mode === 'mock'

  const wins = useMemo(() => {
    let gpt = 0
    let jev = 0
    let tie = 0
    for (const r of rows) {
      if (r.better === 'gpt') gpt += 1
      else if (r.better === 'jev') jev += 1
      else if (r.better === 'tie') tie += 1
    }
    return { gpt, jev, tie }
  }, [rows])

  const grouped = useMemo(
    () => GROUP_ORDER.map((g) => ({ group: g, rows: rows.filter((r) => r.group === g) })).filter((g) => g.rows.length > 0),
    [rows],
  )

  return (
    <section aria-label="Comparación GPT vs Jev" className="overflow-hidden rounded-xl border border-line bg-panel">
      {simulated && (
        <div role="note" className="flex items-start gap-2 border-b border-warn/40 bg-warn/10 px-4 py-2.5 text-xs text-warn">
          <span aria-hidden className="mt-px font-bold">
            !
          </span>
          <span className="font-medium">{SIMULATED_DISCLAIMER}</span>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-[11px] tracking-wide text-ink-faint uppercase">Resumen</div>
          <p className="mt-0.5 text-lg leading-snug font-semibold text-ink">
            <Headline text={headline} />
          </p>
        </div>
        <dl className="flex shrink-0 items-center gap-4 font-mono text-xs tabular-nums">
          {(['gpt', 'jev'] as const).map((id) => (
            <div key={id} className="flex items-center gap-1.5">
              <LaneDot engine={id} />
              <dt className="text-ink-dim">{LANE_NAME[id]} gana</dt>
              <dd className="font-semibold text-ink">{wins[id]}</dd>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <dt className="text-ink-dim">Empates</dt>
            <dd className="font-semibold text-ink">{wins.tie}</dd>
          </div>
        </dl>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line text-[11px] text-ink-dim">
              <th scope="col" className="px-3 py-2 font-medium">
                Métrica
              </th>
              {(['gpt', 'jev'] as const).map((id) => (
                <th key={id} scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="inline-flex items-center justify-end gap-1.5">
                    <LaneDot engine={id} />
                    <span className="text-ink">{LANE_NAME[id]}</span>
                    <span className="hidden sm:inline-flex">
                      <ModeBadge mode={lanes[id].mode} />
                    </span>
                  </span>
                </th>
              ))}
              <th scope="col" className="px-3 py-2 font-medium">
                Ventaja
              </th>
            </tr>
          </thead>
          <tbody>
            {grouped.map(({ group, rows: groupRows }) => (
              <Fragment key={group}>
                <tr className="bg-panel-2/60">
                  <th colSpan={4} scope="colgroup" className="px-3 py-1.5 text-left text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
                    {GROUP_LABELS[group]}
                  </th>
                </tr>
                {groupRows.map((r) => (
                  <tr key={r.key} className="border-b border-line/60 last:border-b-0">
                    <th scope="row" title={r.hint} className="cursor-help px-3 py-1.5 text-xs font-normal text-ink">
                      {r.label}
                      {r.lowerIsBetter !== null && (
                        <span aria-hidden className="ml-1.5 text-[10px] text-ink-faint">
                          {r.lowerIsBetter ? '↓' : '↑'}
                        </span>
                      )}
                    </th>
                    <ValueCell text={r.gptText} engine="gpt" winner={r.better} />
                    <ValueCell text={r.jevText} engine="jev" winner={r.better} />
                    <AdvantageCell row={r} />
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-4 py-2 text-[11px] text-ink-faint">
        ↓ menor es mejor · ↑ mayor es mejor. Tiempo de carrera y costo total solo se comparan cuando ambos carriles llevan las mismas decisiones.
      </p>
    </section>
  )
}
