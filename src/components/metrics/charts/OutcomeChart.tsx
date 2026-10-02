import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { LabelProps, TooltipContentProps } from 'recharts'
import type { EngineId, MoveOutcome, SpeedOutcome } from '../../../shared/contracts.ts'
import type { EngineMetrics } from '../../../metrics/index.ts'
import { MOVE_OUTCOMES, SPEED_OUTCOMES, fmtPercent } from '../../../metrics/index.ts'
import {
  ENGINE_IDS,
  LANE_NAME,
  LANE_STYLE,
  MOVE_OUTCOME_COLOR,
  MOVE_OUTCOME_LABEL,
  ON_FILL_DARK,
  ON_FILL_LIGHT,
  SPEED_OUTCOME_COLOR,
  SPEED_OUTCOME_LABEL,
} from '../lanes.ts'
import { Segmented } from '../ui.tsx'
import { ChartCard, ChartLegend, TooltipBox } from './shared.tsx'
import { AXIS_LINE, AXIS_TICK, GRID_STROKE, PCT_TICKS, SURFACE, pctTick, stackEndShape } from './helpers.tsx'
import type { TooltipRow } from './shared.tsx'

type Kind = 'move' | 'speed'

const Y_WIDTH = 56

interface Series {
  key: string
  label: string
  color: string
  /** Text color used for the inline label (legible on the fill). */
  onFill: string
}

const MOVE_SERIES: Series[] = MOVE_OUTCOMES.map((k: MoveOutcome) => ({
  key: k,
  label: MOVE_OUTCOME_LABEL[k],
  color: MOVE_OUTCOME_COLOR[k],
  onFill: k === 'crash' || k === 'error' ? ON_FILL_LIGHT : ON_FILL_DARK,
}))

const SPEED_SERIES: Series[] = SPEED_OUTCOMES.map((k: SpeedOutcome) => ({
  key: k,
  label: SPEED_OUTCOME_LABEL[k],
  color: SPEED_OUTCOME_COLOR[k],
  onFill: k === 'too_fast' || k === 'not_graded' ? ON_FILL_LIGHT : ON_FILL_DARK,
}))

interface Row {
  engine: EngineId
  lane: string
  total: number
  /** key → share (0..1) */
  [key: string]: number | string
}

/** Inline percentage, only when the segment is wide enough for the text to fit with padding. */
function segmentLabel(onFill: string) {
  return function SegmentLabel(props: LabelProps) {
    const x = Number(props.x)
    const y = Number(props.y)
    const w = Number(props.width)
    const h = Number(props.height)
    const v = Number(props.value)
    if (!Number.isFinite(x + y + w + h + v) || w < 38 || v <= 0) return <g />
    return (
      <text x={x + w / 2} y={y + h / 2} dy="0.34em" textAnchor="middle" fill={onFill} fontSize={11} fontFamily="var(--font-mono)" fontWeight={600}>
        {Math.round(v * 100)}%
      </text>
    )
  }
}

export function OutcomeChart({ metrics, className }: { metrics: Record<EngineId, EngineMetrics>; className?: string }) {
  const [kind, setKind] = useState<Kind>('move')
  const series = kind === 'move' ? MOVE_SERIES : SPEED_SERIES

  const rows = useMemo<Row[]>(
    () =>
      ENGINE_IDS.map((id) => {
        const m = metrics[id]
        const counts: Record<string, number> = kind === 'move' ? m.moveOutcomes : m.speedOutcomes
        const total = m.decisions
        const row: Row = { engine: id, lane: LANE_NAME[id], total }
        for (const s of series) row[s.key] = total > 0 ? (counts[s.key] ?? 0) / total : 0
        return row
      }),
    [metrics, kind, series],
  )

  const labels = useMemo(() => series.map((s) => segmentLabel(s.onFill)), [series])
  const shapes = useMemo(() => series.map((_, i) => stackEndShape(series.map((s) => s.key), i)), [series])
  const empty = rows.every((r) => r.total === 0)

  const renderTooltip = ({ active, payload }: TooltipContentProps) => {
    if (!active || !payload?.length) return null
    const row = payload[0]?.payload as Row | undefined
    if (!row) return null
    const lines: TooltipRow[] = series
      .filter((s) => Number(row[s.key]) > 0)
      .map((s) => ({
        color: s.color,
        label: s.label,
        value: `${Math.round(Number(row[s.key]) * row.total)} · ${fmtPercent(Number(row[s.key]))}`,
        swatch: true,
      }))
    return <TooltipBox title={`${row.lane} · ${row.total} decisiones`} rows={lines} />
  }

  return (
    <ChartCard
      className={className}
      title="Distribución de resultados"
      subtitle={kind === 'move' ? 'Qué pasó con el movimiento elegido, sobre el total de decisiones.' : 'Qué pasó con la velocidad elegida, sobre el total de decisiones.'}
      controls={
        <Segmented
          label="Tipo de resultado"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'move', label: 'Movimiento' },
            { value: 'speed', label: 'Velocidad' },
          ]}
        />
      }
      legend={<ChartLegend items={series.map((s) => ({ key: s.key, label: s.label, color: s.color, kind: 'swatch' }))} />}
      empty={empty}
      emptyText="La distribución aparecerá cuando se califiquen las primeras decisiones."
      minHeightClass="min-h-44"
      table={{
        head: ['Carril', ...series.map((s) => s.label)],
        rows: rows.map((r) => [
          r.lane,
          ...series.map((s) => (r.total > 0 ? `${Math.round(Number(r[s.key]) * r.total)} (${fmtPercent(Number(r[s.key]), 0)})` : null)),
        ]),
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 0 }} barCategoryGap={18}>
          <CartesianGrid stroke={GRID_STROKE} strokeOpacity={0.7} horizontal={false} />
          <XAxis type="number" domain={[0, 1]} ticks={PCT_TICKS} tickFormatter={pctTick} tick={AXIS_TICK} tickLine={false} axisLine={AXIS_LINE} height={26} />
          <YAxis
            type="category"
            dataKey="lane"
            axisLine={false}
            tickLine={false}
            width={Y_WIDTH}
            tickSize={0}
            tickMargin={0}
            tick={(p: { x?: number | string; y?: number | string; payload?: { value: string } }) => {
              const x = Number(p.x)
              const y = Number(p.y)
              const row = rows.find((r) => r.lane === p.payload?.value)
              if (!row || !Number.isFinite(x + y)) return <g />
              return (
                <g transform={`translate(${x},${y})`}>
                  <circle cx={6 - Y_WIDTH} cy={0} r={4} fill={LANE_STYLE[row.engine].color} />
                  <text x={16 - Y_WIDTH} y={0} dy="0.34em" fill="var(--color-ink)" fontSize={12} fontWeight={600}>
                    {row.lane}
                  </text>
                </g>
              )
            }}
          />
          <Tooltip content={renderTooltip} isAnimationActive={false} cursor={{ fill: 'var(--color-ink)', fillOpacity: 0.04 }} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="outcome"
              fill={s.color}
              stroke={SURFACE}
              strokeWidth={2}
              barSize={22}
              shape={shapes[i]}
              isAnimationActive={false}
            >
              <LabelList dataKey={s.key} content={labels[i]} />
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
