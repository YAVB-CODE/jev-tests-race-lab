import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { LaneMetricsProps } from '../../shared/contracts.ts'
import { DASH, fmtClock, fmtCompact, fmtMs, fmtNumber, fmtPercent, fmtScore, fmtUsd } from '../../metrics/index.ts'
import type { EngineMetrics } from '../../metrics/index.ts'
import { useLaneMetrics } from './hooks.ts'
import { LANE_STYLE } from './lanes.ts'
import { ModeBadge } from './ui.tsx'

interface TileProps {
  label: string
  value: ReactNode
  sub?: ReactNode
  hint: string
  tone?: 'ok' | 'bad' | 'warn'
}

const TONE: Record<NonNullable<TileProps['tone']>, string> = { ok: 'text-ok', bad: 'text-bad', warn: 'text-warn' }

function Tile({ label, value, sub, hint, tone }: TileProps) {
  return (
    <div title={hint} className="min-w-0 rounded-lg border border-line bg-panel-2 px-3 py-2.5">
      <div className="truncate text-[11px] leading-tight text-ink-dim">{label}</div>
      <div className={clsx('mt-1 truncate font-mono text-xl leading-none font-semibold tabular-nums', tone ? TONE[tone] : 'text-ink')}>{value}</div>
      <div className="mt-1.5 min-h-4 truncate font-mono text-[11px] leading-4 tabular-nums text-ink-faint">{sub ?? ' '}</div>
    </div>
  )
}

function ofTotal(count: number, total: number): string {
  return `${count} de ${total}`
}

function tiles(m: EngineMetrics, totalLaps: number | null): TileProps[] {
  const none = m.decisions === 0
  const calibrated = m.calibration.count > 0
  return [
    {
      label: 'Aciertos',
      value: none ? DASH : fmtPercent(m.hitRate),
      sub: none ? undefined : ofTotal(m.hits, m.decisions),
      hint: 'Aciertos: decisiones con movimiento óptimo y velocidad correcta. Se muestra el porcentaje y el conteo sobre las decisiones calificadas.',
      tone: none ? undefined : 'ok',
    },
    {
      label: 'Errores',
      value: none ? DASH : fmtPercent(m.errorRate),
      sub: none ? undefined : ofTotal(m.errors, m.decisions),
      hint: 'Errores: choques, respuestas inválidas, timeouts, fallos del motor y trompos por exceso de velocidad.',
      tone: m.errors > 0 ? 'bad' : undefined,
    },
    {
      label: 'Precisión de movimiento',
      value: fmtPercent(m.moveAccuracy),
      sub: none ? undefined : ofTotal(m.moveOptimal, m.decisions),
      hint: 'Movimientos óptimos (ruta más corta) sobre todas las decisiones. Una respuesta inválida o un timeout cuentan como fallo.',
    },
    {
      label: 'Precisión de velocidad',
      value: fmtPercent(m.speedAccuracy),
      sub: m.speedGraded > 0 ? ofTotal(m.speedCorrect, m.speedGraded) : undefined,
      hint: 'Velocidades correctas sobre las decisiones donde la velocidad fue calificada (se excluyen respuestas sin movimiento válido).',
    },
    {
      label: 'En bifurcaciones',
      value: fmtPercent(m.junctionAccuracy),
      sub: m.junctionDecisions > 0 ? ofTotal(m.junctionOptimal, m.junctionDecisions) : undefined,
      hint: 'Precisión de movimiento en celdas con más de una opción válida: las decisiones más difíciles.',
    },
    {
      label: 'Latencia p50',
      value: m.latency.count > 0 ? fmtMs(m.latency.p50) : DASH,
      sub: m.latency.count > 0 ? `p95 ${fmtMs(m.latency.p95)}` : undefined,
      hint: 'Tiempo de decisión de extremo a extremo (cliente → modelo → cliente). p50 = mediana; p95 = el 95 % de las decisiones tardó menos que esto.',
    },
    {
      label: '% tiempo pensando',
      value: m.time.raceMs > 0 ? fmtPercent(m.time.thinkingShare) : DASH,
      sub: m.time.raceMs > 0 ? `${fmtClock(m.time.thinkingMs)} de ${fmtClock(m.time.raceMs)}` : undefined,
      hint: 'Parte del tiempo de carrera que el carro estuvo detenido esperando la decisión de la IA.',
    },
    {
      label: 'Vueltas',
      value: none ? DASH : totalLaps ? `${m.lapsCompleted}/${totalLaps}` : String(m.lapsCompleted),
      sub: m.bestLapMs !== null ? `mejor ${fmtClock(m.bestLapMs)}` : undefined,
      hint: 'Vueltas completadas y mejor tiempo de vuelta.',
    },
    {
      label: 'Respuestas inválidas',
      value: none ? DASH : fmtPercent(m.invalidRate),
      sub: none ? undefined : `${m.invalidCount} · ${m.timeouts} timeout${m.timeouts === 1 ? '' : 's'}`,
      hint: 'Salidas que no se pudieron interpretar o quedaron fuera del conjunto permitido (type errors). También se indican los timeouts.',
      tone: m.invalidCount > 0 ? 'warn' : undefined,
    },
    {
      label: m.costEstimated ? 'Costo (est.)' : 'Costo',
      value: none ? DASH : fmtUsd(m.costUsd),
      sub: none ? undefined : `${fmtCompact(m.tokensIn)}/${fmtCompact(m.tokensOut)} tok`,
      hint: m.costEstimated
        ? 'Costo acumulado en USD: ESTIMADO (modo SIMULADO). Debajo, tokens de entrada / salida.'
        : 'Costo acumulado en USD según el uso de tokens reportado. Debajo, tokens de entrada / salida.',
    },
    {
      label: 'Decisiones/min',
      value: m.decisionsPerMinute > 0 ? fmtNumber(m.decisionsPerMinute, 1) : DASH,
      sub: none ? undefined : `${m.decisions} decisiones`,
      hint: 'Rendimiento: decisiones tomadas por minuto de tiempo de carrera.',
    },
    {
      label: 'Calibración (ECE)',
      value: calibrated ? fmtScore(m.calibration.ece) : DASH,
      sub: calibrated ? `Brier ${fmtScore(m.calibration.brier)}` : undefined,
      hint: 'Error de calibración esperado: diferencia media entre la confianza declarada y la precisión real (0 = perfecta). Debajo, el Brier score (menor es mejor).',
    },
  ]
}

/** KPI tiles for one lane. */
export function LaneMetrics({ lane }: LaneMetricsProps) {
  const m = useLaneMetrics(lane)
  const style = LANE_STYLE[lane.engine]
  const totalLaps = lane.snapshot?.totalLaps ?? null

  return (
    <section aria-label={`Métricas de ${lane.label}`} className={clsx('overflow-hidden rounded-xl border bg-panel', style.border)}>
      <header className={clsx('flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3.5 py-2.5', style.bgSoft)}>
        <span aria-hidden className={clsx('h-4 w-1 rounded-full', style.bg)} />
        <h3 className={clsx('min-w-0 truncate text-sm font-semibold', style.text)}>{lane.label}</h3>
        <ModeBadge mode={lane.mode} />
        <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-dim">
          {m.decisions} {m.decisions === 1 ? 'decisión' : 'decisiones'}
        </span>
      </header>
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 2xl:grid-cols-4">
        {tiles(m, totalLaps).map((t) => (
          <Tile key={t.label} {...t} />
        ))}
      </div>
    </section>
  )
}
