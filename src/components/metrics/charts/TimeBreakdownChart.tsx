import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import type { EngineId } from '../../../shared/contracts.ts'
import type { EngineMetrics } from '../../../metrics/index.ts'
import { fmtClock, fmtPercent } from '../../../metrics/index.ts'
import { ENGINE_IDS, LANE_NAME, LANE_STYLE } from '../lanes.ts'
import { Segmented } from '../ui.tsx'
import { ChartCard, ChartLegend, TooltipBox } from './shared.tsx'
import { AXIS_LINE, AXIS_TICK, GRID_STROKE, SURFACE, pctTick, stackEndShape } from './helpers.tsx'
import type { TooltipRow } from './shared.tsx'

type Mode = 'abs' | 'share'

const Y_WIDTH = 164

type Part = 'movingMs' | 'thinkingMs' | 'penaltyMs'

const PARTS: Array<{ key: Part; label: string; color: string }> = [
  { key: 'movingMs', label: 'Movimiento', color: 'var(--color-ink-faint)' },
  { key: 'thinkingMs', label: 'Pensando', color: 'var(--color-warn)' },
  { key: 'penaltyMs', label: 'Penalizaciones', color: 'var(--color-bad)' },
]

interface Row {
  engine: EngineId
  lane: string
  raceMs: number
  thinkingShare: number
  /** Plotted values (ms or share, depending on the mode). */
  movingMs: number
  thinkingMs: number
  penaltyMs: number
  /** Always absolute (for the tooltip). */
  abs: Record<Part, number>
}

/** Y tick: lane dot + name on the first line, total race time and thinking share below. */
function LaneTick({ x, y, payload, rows }: { x?: number | string; y?: number | string; payload?: { value: string }; rows: Row[] }) {
  const row = rows.find((r) => r.lane === payload?.value)
  if (!row || typeof x !== 'number' || typeof y !== 'number') return <g />
  return (
    <g transform={`translate(${x},${y})`}>
      <circle cx={6 - Y_WIDTH} cy={-7} r={4} fill={LANE_STYLE[row.engine].color} />
      <text x={16 - Y_WIDTH} y={-7} dy="0.34em" fill="var(--color-ink)" fontSize={12} fontWeight={600}>
        {row.lane}
      </text>
      <text x={16 - Y_WIDTH} y={9} dy="0.34em" fill="var(--color-ink-faint)" fontSize={10} fontFamily="var(--font-mono)">
        {row.raceMs > 0 ? `${fmtClock(row.raceMs)} · ${fmtPercent(row.thinkingShare, 0)} pensando` : 'sin datos'}
      </text>
    </g>
  )
}

function renderTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload as Row | undefined
  if (!row) return null
  const rows: TooltipRow[] = PARTS.map((p) => ({
    color: p.color,
    label: p.label,
    value: `${fmtClock(row.abs[p.key])}${row.raceMs > 0 ? ` · ${fmtPercent(row.abs[p.key] / row.raceMs, 0)}` : ''}`,
    swatch: true,
  }))
  return <TooltipBox title={`${row.lane} · total ${fmtClock(row.raceMs)}`} rows={rows} />
}

export function TimeBreakdownChart({ metrics, className }: { metrics: Record<EngineId, EngineMetrics>; className?: string }) {
  const [mode, setMode] = useState<Mode>('abs')

  const rows = useMemo<Row[]>(
    () =>
      ENGINE_IDS.map((id) => {
        const t = metrics[id].time
        const abs = { movingMs: t.movingMs, thinkingMs: t.thinkingMs, penaltyMs: t.penaltyMs }
        const total = t.movingMs + t.thinkingMs + t.penaltyMs
        const scale = (v: number) => (mode === 'share' ? (total > 0 ? v / total : 0) : v)
        return {
          engine: id,
          lane: LANE_NAME[id],
          raceMs: t.raceMs,
          thinkingShare: t.thinkingShare,
          movingMs: scale(abs.movingMs),
          thinkingMs: scale(abs.thinkingMs),
          penaltyMs: scale(abs.penaltyMs),
          abs,
        }
      }),
    [metrics, mode],
  )

  const shapes = useMemo(() => PARTS.map((_, i) => stackEndShape(PARTS.map((p) => p.key), i)), [])
  const empty = rows.every((r) => r.raceMs <= 0)

  return (
    <ChartCard
      className={className}
      title="Desglose del tiempo de carrera"
      subtitle="Carrera = movimiento + espera de la IA + penalizaciones. Menos tiempo pensando = más tiempo corriendo."
      controls={
        <Segmented
          label="Unidad del desglose"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'abs', label: 'Tiempo' },
            { value: 'share', label: '% del total' },
          ]}
        />
      }
      legend={<ChartLegend items={PARTS.map((p) => ({ key: p.key, label: p.label, color: p.color, kind: 'swatch' }))} />}
      empty={empty}
      emptyText="El desglose aparecerá cuando los carros acumulen tiempo de carrera."
      minHeightClass="min-h-44"
      table={{
        head: ['Carril', 'Movimiento', 'Pensando', 'Penalizaciones', 'Total', '% pensando'],
        rows: rows.map((r) => [
          r.lane,
          fmtClock(r.abs.movingMs),
          fmtClock(r.abs.thinkingMs),
          fmtClock(r.abs.penaltyMs),
          fmtClock(r.raceMs),
          r.raceMs > 0 ? fmtPercent(r.thinkingShare) : null,
        ]),
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 0 }} barCategoryGap={18}>
          <CartesianGrid stroke={GRID_STROKE} strokeOpacity={0.7} horizontal={false} />
          <XAxis
            type="number"
            domain={mode === 'share' ? [0, 1] : [0, 'dataMax']}
            tickFormatter={mode === 'share' ? pctTick : (v: number) => fmtClock(v)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={AXIS_LINE}
            height={26}
          />
          <YAxis
            type="category"
            dataKey="lane"
            axisLine={false}
            tickLine={false}
            width={Y_WIDTH}
            tickSize={0}
            tickMargin={0}
            tick={(p: { x?: number | string; y?: number | string; payload?: { value: string } }) => <LaneTick {...p} rows={rows} />}
          />
          <Tooltip content={renderTooltip} isAnimationActive={false} cursor={{ fill: 'var(--color-ink)', fillOpacity: 0.04 }} />
          {PARTS.map((p, i) => (
            <Bar
              key={p.key}
              dataKey={p.key}
              name={p.label}
              stackId="time"
              fill={p.color}
              stroke={SURFACE}
              strokeWidth={2}
              barSize={22}
              shape={shapes[i]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
