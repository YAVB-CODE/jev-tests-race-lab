import { useMemo } from 'react'
import type { JSX } from 'react'
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts'
import type { ScatterShapeProps, TooltipContentProps } from 'recharts'
import type { EngineId } from '../../../shared/contracts.ts'
import type { EngineMetrics } from '../../../metrics/index.ts'
import { fmtPercent, fmtScore } from '../../../metrics/index.ts'
import { ENGINE_IDS, LANE_NAME, LANE_STYLE } from '../lanes.ts'
import { ChartCard, ChartLegend, TooltipBox } from './shared.tsx'
import { AXIS_LINE, AXIS_TICK, GRID_STROKE, PCT_TICKS, SURFACE, pctTick } from './helpers.tsx'

interface BinPoint {
  engine: EngineId
  /** Mean stated confidence in the bin. */
  x: number
  /** Share of optimal moves in the bin. */
  y: number
  /** Decisions in the bin (bubble area). */
  z: number
  lo: number
  hi: number
}

const MIN_HIT_RADIUS = 14

function bubble(engine: EngineId) {
  const color = LANE_STYLE[engine].color
  return function Bubble(props: ScatterShapeProps) {
    const { cx, cy, size } = props
    if (typeof cx !== 'number' || typeof cy !== 'number') return <g />
    const r = Math.sqrt((typeof size === 'number' ? size : 80) / Math.PI)
    return (
      <g>
        {/* transparent, larger hit target (>= 24px) */}
        <circle cx={cx} cy={cy} r={Math.max(r + 4, MIN_HIT_RADIUS)} fill="transparent" />
        <circle cx={cx} cy={cy} r={r} fill={color} fillOpacity={0.85} stroke={SURFACE} strokeWidth={2} />
      </g>
    )
  }
}

const SHAPES: Record<EngineId, (props: ScatterShapeProps) => JSX.Element> = { gpt: bubble('gpt'), jev: bubble('jev') }

function renderTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as BinPoint | undefined
  if (!d) return null
  return (
    <TooltipBox
      title={`${LANE_NAME[d.engine]} · confianza ${Math.round(d.lo * 100)}–${Math.round(d.hi * 100)}%`}
      rows={[
        { color: LANE_STYLE[d.engine].color, label: 'precisión real', value: fmtPercent(d.y) },
        { color: LANE_STYLE[d.engine].color, label: 'confianza media', value: fmtPercent(d.x) },
        { color: LANE_STYLE[d.engine].color, label: 'decisiones', value: String(d.z) },
      ]}
    />
  )
}

export function ReliabilityChart({ metrics, className }: { metrics: Record<EngineId, EngineMetrics>; className?: string }) {
  const points = useMemo(() => {
    const out = {} as Record<EngineId, BinPoint[]>
    for (const id of ENGINE_IDS) {
      out[id] = metrics[id].calibration.bins.flatMap((b) =>
        b.count > 0 && b.avgConfidence !== null && b.accuracy !== null
          ? [{ engine: id, x: b.avgConfidence, y: b.accuracy, z: b.count, lo: b.lo, hi: b.hi }]
          : [],
      )
    }
    return out
  }, [metrics])

  const maxCount = Math.max(1, ...ENGINE_IDS.flatMap((id) => points[id].map((p) => p.z)))
  const empty = ENGINE_IDS.every((id) => points[id].length === 0)
  const missing = ENGINE_IDS.filter((id) => metrics[id].calibration.count === 0)

  const tableRows = ENGINE_IDS.flatMap((id) =>
    metrics[id].calibration.bins
      .filter((b) => b.count > 0)
      .map((b) => [
        `${LANE_NAME[id]} · ${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`,
        b.count,
        fmtPercent(b.avgConfidence),
        fmtPercent(b.accuracy),
      ]),
  )

  return (
    <ChartCard
      className={className}
      title="Diagrama de confiabilidad"
      subtitle="Confianza declarada vs. precisión real del movimiento. Sobre la diagonal = calibrado; por debajo = sobreconfiado. El tamaño indica cuántas decisiones hay."
      legend={
        <ChartLegend
          items={ENGINE_IDS.map((id) => {
            const c = metrics[id].calibration
            return {
              key: id,
              label: LANE_NAME[id],
              color: LANE_STYLE[id].color,
              kind: 'swatch',
              note: c.count > 0 ? `ECE ${fmtScore(c.ece)} · Brier ${fmtScore(c.brier)}` : 'sin confianza',
            }
          })}
        />
      }
      empty={empty}
      emptyText="Aún no hay decisiones con confianza declarada. Aparecerán aquí cuando el modelo reporte probabilidades."
      table={{ head: ['Carril · intervalo', 'n', 'Confianza', 'Precisión'], rows: tableRows }}
      minHeightClass="min-h-72"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 10, right: 18, bottom: 6, left: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} strokeOpacity={0.7} />
          <XAxis
            type="number"
            dataKey="x"
            name="Confianza"
            domain={[0, 1]}
            ticks={PCT_TICKS}
            tickFormatter={pctTick}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={AXIS_LINE}
            height={34}
            label={{ value: 'Confianza declarada', position: 'insideBottom', offset: 0, fill: 'var(--color-ink-faint)', fontSize: 10 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="Precisión"
            domain={[0, 1]}
            ticks={PCT_TICKS}
            tickFormatter={pctTick}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <ZAxis type="number" dataKey="z" domain={[0, maxCount]} range={[70, 520]} />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ]}
            stroke="var(--color-ink-faint)"
            strokeWidth={1.5}
            ifOverflow="visible"
            label={{ value: 'Calibración perfecta', position: 'insideTopLeft', fill: 'var(--color-ink-faint)', fontSize: 10 }}
          />
          <Tooltip content={renderTooltip} isAnimationActive={false} cursor={false} />
          {ENGINE_IDS.map((id) => (
            <Scatter
              key={id}
              name={LANE_NAME[id]}
              data={points[id]}
              fill={LANE_STYLE[id].color}
              shape={SHAPES[id]}
              isAnimationActive={false}
            />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
      {missing.length > 0 && (
        <p className="pointer-events-none absolute right-5 bottom-10 rounded bg-panel/80 px-1.5 py-0.5 text-[10px] text-ink-faint">
          {missing.map((id) => LANE_NAME[id]).join(' y ')}: sin confianza reportada
        </p>
      )}
    </ChartCard>
  )
}
