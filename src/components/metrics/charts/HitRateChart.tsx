import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import type { EngineId, LaneData } from '../../../shared/contracts.ts'
import { cumulativeHitRate, fmtPercent, rollingHitRate } from '../../../metrics/index.ts'
import type { EngineMetrics, SeriesPoint } from '../../../metrics/index.ts'
import { ENGINE_IDS, LANE_NAME, LANE_STYLE } from '../lanes.ts'
import { Segmented } from '../ui.tsx'
import { ChartCard, ChartLegend, TooltipBox } from './shared.tsx'
import { AXIS_LINE, AXIS_TICK, GRID_STROKE, PCT_TICKS, SURFACE, pctTick, strideSample } from './helpers.tsx'
import type { TooltipRow } from './shared.tsx'

type Mode = 'cumulative' | 'rolling'
const ROLLING_WINDOW = 10

interface Row {
  n: number
  gpt?: number
  jev?: number
}

function merge(series: Record<EngineId, SeriesPoint[]>): Row[] {
  const len = Math.max(series.gpt.length, series.jev.length)
  const out: Row[] = []
  for (let i = 0; i < len; i++) out.push({ n: i + 1, gpt: series.gpt[i]?.value, jev: series.jev[i]?.value })
  return out
}

function renderTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  const rows: TooltipRow[] = payload
    .filter((p) => typeof p.value === 'number')
    .map((p) => ({ color: String(p.color), label: LANE_NAME[p.dataKey as EngineId], value: fmtPercent(p.value as number) }))
  return <TooltipBox title={`Decisión #${label}`} rows={rows} />
}

export function HitRateChart({ lanes, metrics, className }: { lanes: Record<EngineId, LaneData>; metrics: Record<EngineId, EngineMetrics>; className?: string }) {
  const [mode, setMode] = useState<Mode>('cumulative')
  const { gpt, jev } = lanes

  // `records.length` is a dependency because the store may append in place (same array identity).
  const gptLen = gpt.records.length
  const jevLen = jev.records.length
  const full = useMemo(() => {
    void gptLen
    void jevLen
    const pick = (records: LaneData['records']) => (mode === 'cumulative' ? cumulativeHitRate(records) : rollingHitRate(records, ROLLING_WINDOW))
    return { gpt: pick(gpt.records), jev: pick(jev.records) }
  }, [mode, gpt.records, gptLen, jev.records, jevLen])

  const rows = useMemo(() => strideSample(merge(full)), [full])
  const last = { gpt: full.gpt[full.gpt.length - 1], jev: full.jev[full.jev.length - 1] }

  return (
    <ChartCard
      className={className}
      title="Aciertos a lo largo de la carrera"
      subtitle="Acierto = movimiento óptimo y velocidad correcta."
      controls={
        <Segmented
          label="Tipo de serie de aciertos"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'cumulative', label: 'Acumulada' },
            { value: 'rolling', label: `Últimas ${ROLLING_WINDOW}` },
          ]}
        />
      }
      legend={
        <ChartLegend
          items={ENGINE_IDS.map((id) => ({
            key: id,
            label: LANE_NAME[id],
            color: LANE_STYLE[id].color,
            kind: 'line',
            note: last[id] ? fmtPercent(last[id].value) : undefined,
          }))}
        />
      }
      empty={rows.length === 0}
      emptyText="La precisión aparecerá aquí cuando se califiquen las primeras decisiones."
      table={{
        head: ['Carril', 'Decisiones', mode === 'cumulative' ? 'Acumulada' : `Últimas ${ROLLING_WINDOW}`, 'Aciertos'],
        rows: ENGINE_IDS.map((id) => [
          LANE_NAME[id],
          metrics[id].decisions,
          last[id] ? fmtPercent(last[id].value) : null,
          metrics[id].decisions ? `${metrics[id].hits}` : null,
        ]),
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 10, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} strokeOpacity={0.7} vertical={false} />
          <XAxis
            dataKey="n"
            type="number"
            domain={[1, 'dataMax']}
            allowDecimals={false}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={AXIS_LINE}
            minTickGap={24}
            label={{ value: 'Decisión #', position: 'insideBottomRight', offset: -2, fill: 'var(--color-ink-faint)', fontSize: 10 }}
            height={32}
          />
          <YAxis domain={[0, 1]} ticks={PCT_TICKS} tickFormatter={pctTick} tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} />
          <Tooltip content={renderTooltip} isAnimationActive={false} cursor={{ stroke: 'var(--color-ink-faint)', strokeWidth: 1 }} />
          {ENGINE_IDS.map((id) => (
            <Line
              key={id}
              dataKey={id}
              name={LANE_NAME[id]}
              type="linear"
              stroke={LANE_STYLE[id].color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, fill: LANE_STYLE[id].color, stroke: SURFACE, strokeWidth: 2 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
          {ENGINE_IDS.map((id) =>
            last[id] ? (
              <ReferenceDot
                key={`end-${id}`}
                x={last[id].n}
                y={last[id].value}
                r={4}
                fill={LANE_STYLE[id].color}
                stroke={SURFACE}
                strokeWidth={2}
                ifOverflow="visible"
              />
            ) : null,
          )}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
