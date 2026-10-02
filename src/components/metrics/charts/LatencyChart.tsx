import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import type { EngineId, LaneData } from '../../../shared/contracts.ts'
import type { EngineMetrics } from '../../../metrics/index.ts'
import { fmtMs } from '../../../metrics/index.ts'
import { ENGINE_IDS, LANE_NAME, LANE_STYLE } from '../lanes.ts'
import { Segmented } from '../ui.tsx'
import { ChartCard, ChartLegend, TooltipBox } from './shared.tsx'
import { AXIS_LINE, AXIS_TICK, GRID_STROKE, SURFACE, msTick, strideSample } from './helpers.tsx'
import type { TooltipRow } from './shared.tsx'

interface Row {
  n: number
  gpt?: number
  jev?: number
}

type Scale = 'linear' | 'log'

/** Decade ticks (10, 100, 1000, …) covering [min, max]. */
function decadeTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(Math.max(1, min)))
  const hi = Math.max(lo + 1, Math.ceil(Math.log10(Math.max(1, max))))
  const out: number[] = []
  for (let e = lo; e <= hi; e++) out.push(10 ** e)
  return out
}

function renderTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  const rows: TooltipRow[] = payload
    .filter((p) => typeof p.value === 'number')
    .map((p) => ({
      color: String(p.color),
      label: LANE_NAME[p.dataKey as EngineId],
      value: fmtMs(p.value as number),
    }))
  return <TooltipBox title={`Decisión #${label}`} rows={rows} />
}

export function LatencyChart({ lanes, metrics, className }: { lanes: Record<EngineId, LaneData>; metrics: Record<EngineId, EngineMetrics>; className?: string }) {
  const [scale, setScale] = useState<Scale>('log')
  const { gpt, jev } = lanes

  // `records.length` is a dependency because the store may append in place (same array identity).
  const gptLen = gpt.records.length
  const jevLen = jev.records.length
  const rows = useMemo(() => {
    void gptLen
    void jevLen
    const len = Math.max(gpt.records.length, jev.records.length)
    const out: Row[] = []
    for (let i = 0; i < len; i++) {
      out.push({ n: i + 1, gpt: gpt.records[i]?.latencyMs, jev: jev.records[i]?.latencyMs })
    }
    return strideSample(out)
  }, [gpt.records, gptLen, jev.records, jevLen])

  const log = useMemo(() => {
    let min = Infinity
    let max = 1
    for (const r of rows) {
      for (const v of [r.gpt, r.jev]) {
        if (typeof v !== 'number') continue
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    const ticks = decadeTicks(Number.isFinite(min) ? min : 1, max)
    return { ticks, domain: [ticks[0], ticks[ticks.length - 1]] as [number, number] }
  }, [rows])

  const isLog = scale === 'log'
  const empty = rows.length === 0

  return (
    <ChartCard
      className={className}
      title="Latencia por decisión"
      subtitle="Tiempo de decisión de extremo a extremo; incluye los timeouts."
      controls={
        <Segmented
          label="Escala del eje de latencia"
          value={scale}
          onChange={setScale}
          options={[
            { value: 'linear', label: 'Lineal' },
            { value: 'log', label: 'Log' },
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
            note: metrics[id].latency.count > 0 ? `p50 ${fmtMs(metrics[id].latency.p50)}` : undefined,
          }))}
        />
      }
      empty={empty}
      emptyText="Las latencias aparecerán aquí a medida que los carros tomen decisiones."
      table={{
        head: ['Carril', 'n', 'Media', 'p50', 'p90', 'p95', 'Mín.', 'Máx.', 'σ'],
        rows: ENGINE_IDS.map((id) => {
          const l = metrics[id].latency
          const has = l.count > 0
          return [
            LANE_NAME[id],
            l.count,
            has ? fmtMs(l.mean) : null,
            has ? fmtMs(l.p50) : null,
            has ? fmtMs(l.p90) : null,
            has ? fmtMs(l.p95) : null,
            has ? fmtMs(l.min) : null,
            has ? fmtMs(l.max) : null,
            has ? fmtMs(l.stdDev) : null,
          ]
        }),
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 14, bottom: 4, left: 0 }}>
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
          <YAxis
            scale={isLog ? 'log' : 'linear'}
            domain={isLog ? log.domain : [0, 'auto']}
            ticks={isLog ? log.ticks : undefined}
            allowDataOverflow={isLog}
            tickFormatter={msTick}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={58}
          />
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
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
