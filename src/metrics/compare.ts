/**
 * Lane comparison: turns two EngineMetrics (a = GPT, b = Jev) into table rows with a winner per metric.
 * "Lower is better" for latency, errors, invalid answers, cost, race time, thinking share, Brier and ECE.
 */
import type { EngineMetrics } from './compute.ts'
import { DASH, fmtClock, fmtCompact, fmtInt, fmtMs, fmtNumber, fmtPercent, fmtPp, fmtScore, fmtUsd } from './format.ts'

export type Winner = 'gpt' | 'jev' | 'tie' | null

export type ComparisonGroup = 'precision' | 'speed' | 'race' | 'calibration' | 'cost'

export const GROUP_LABELS: Record<ComparisonGroup, string> = {
  precision: 'Eficacia',
  speed: 'Velocidad de decisión',
  race: 'Carrera',
  calibration: 'Calibración',
  cost: 'Costo',
}

export interface ComparisonRow {
  key: string
  /** Spanish label. */
  label: string
  group: ComparisonGroup
  /** Spanish tooltip explaining the metric. */
  hint: string
  /** Raw values (null = no data yet). Units depend on the metric: fractions, ms, USD, counts. */
  gpt: number | null
  jev: number | null
  /** Formatted values for display. */
  gptText: string
  jevText: string
  /** null = not comparable (no data, informational row, or lanes not at the same point of the race). */
  better: Winner
  /** true when a lower value is better, false when higher is better, null for informational rows. */
  lowerIsBetter: boolean | null
  /** Winner's advantage, e.g. "6.3× más rápido", "+4.1 pp", "−2.0 pp". Empty when there is no winner. */
  deltaText: string
}

type Kind = 'percent' | 'ms' | 'clock' | 'usd' | 'count' | 'score' | 'tokens' | 'rate'

interface RowDef {
  key: string
  label: string
  group: ComparisonGroup
  hint: string
  kind: Kind
  direction: 'higher' | 'lower' | 'none'
  pick: (m: EngineMetrics) => number | null
  /** Appended to the formatted value (e.g. "38/60"); replaces it for `tokens`. */
  extra?: (m: EngineMetrics) => string
  /** Wording for a ratio advantage, e.g. 'más rápido' → "6.3× más rápido". */
  ratioWord?: string
  /** Only comparable when both lanes graded the same number of decisions (totals). */
  needsSameDecisions?: boolean
}

const hasData = (m: EngineMetrics) => m.decisions > 0

const ROWS: RowDef[] = [
  {
    key: 'hitRate',
    label: 'Aciertos',
    group: 'precision',
    hint: 'Decisiones con movimiento óptimo y velocidad correcta.',
    kind: 'percent',
    direction: 'higher',
    pick: (m) => (hasData(m) ? m.hitRate : null),
    extra: (m) => `${m.hits}/${m.decisions}`,
  },
  {
    key: 'errorRate',
    label: 'Errores',
    group: 'precision',
    hint: 'Choques, respuestas inválidas, timeouts, fallos del motor y trompos (velocidad excesiva).',
    kind: 'percent',
    direction: 'lower',
    pick: (m) => (hasData(m) ? m.errorRate : null),
    extra: (m) => `${m.errors}/${m.decisions}`,
  },
  {
    key: 'moveAccuracy',
    label: 'Precisión de movimiento',
    group: 'precision',
    hint: 'Movimientos óptimos sobre todas las decisiones.',
    kind: 'percent',
    direction: 'higher',
    pick: (m) => m.moveAccuracy,
  },
  {
    key: 'speedAccuracy',
    label: 'Precisión de velocidad',
    group: 'precision',
    hint: 'Velocidades correctas sobre las decisiones donde la velocidad fue calificada.',
    kind: 'percent',
    direction: 'higher',
    pick: (m) => m.speedAccuracy,
  },
  {
    key: 'junctionAccuracy',
    label: 'Precisión en bifurcaciones',
    group: 'precision',
    hint: 'Movimientos óptimos en celdas con más de una opción válida.',
    kind: 'percent',
    direction: 'higher',
    pick: (m) => m.junctionAccuracy,
    extra: (m) => `${m.junctionOptimal}/${m.junctionDecisions}`,
  },
  {
    key: 'invalidRate',
    label: 'Respuestas inválidas',
    group: 'precision',
    hint: 'Salidas que no se pudieron interpretar o quedaron fuera del conjunto permitido.',
    kind: 'percent',
    direction: 'lower',
    pick: (m) => (hasData(m) ? m.invalidRate : null),
    extra: (m) => `${m.invalidCount}/${m.decisions}`,
  },
  {
    key: 'latencyP50',
    label: 'Latencia p50',
    group: 'speed',
    hint: 'Mediana del tiempo de decisión de extremo a extremo.',
    kind: 'ms',
    direction: 'lower',
    pick: (m) => (m.latency.count > 0 ? m.latency.p50 : null),
    ratioWord: 'más rápido',
  },
  {
    key: 'latencyP95',
    label: 'Latencia p95',
    group: 'speed',
    hint: 'El 95 % de las decisiones tardó menos que esto (cola de latencia).',
    kind: 'ms',
    direction: 'lower',
    pick: (m) => (m.latency.count > 0 ? m.latency.p95 : null),
    ratioWord: 'más rápido',
  },
  {
    key: 'latencyMean',
    label: 'Latencia media',
    group: 'speed',
    hint: 'Promedio del tiempo de decisión de extremo a extremo.',
    kind: 'ms',
    direction: 'lower',
    pick: (m) => (m.latency.count > 0 ? m.latency.mean : null),
    ratioWord: 'más rápido',
  },
  {
    key: 'thinkingShare',
    label: '% tiempo pensando',
    group: 'speed',
    hint: 'Parte del tiempo de carrera que el carro pasó esperando la decisión.',
    kind: 'percent',
    direction: 'lower',
    pick: (m) => (m.time.raceMs > 0 ? m.time.thinkingShare : null),
  },
  {
    key: 'decisionsPerMinute',
    label: 'Decisiones por minuto',
    group: 'speed',
    hint: 'Rendimiento: decisiones tomadas por minuto de carrera.',
    kind: 'rate',
    direction: 'higher',
    pick: (m) => (m.decisionsPerMinute > 0 ? m.decisionsPerMinute : null),
    ratioWord: 'más decisiones/min',
  },
  {
    key: 'raceTime',
    label: 'Tiempo de carrera',
    group: 'race',
    hint: 'Movimiento + espera de la IA + penalizaciones. Solo comparable cuando ambos carriles llevan las mismas decisiones.',
    kind: 'clock',
    direction: 'lower',
    pick: (m) => (m.time.raceMs > 0 ? m.time.raceMs : null),
    ratioWord: 'más rápido',
    needsSameDecisions: true,
  },
  {
    key: 'bestLap',
    label: 'Mejor vuelta',
    group: 'race',
    hint: 'Menor tiempo de vuelta completada.',
    kind: 'clock',
    direction: 'lower',
    pick: (m) => m.bestLapMs,
    ratioWord: 'más rápido',
  },
  {
    key: 'lapsCompleted',
    label: 'Vueltas completadas',
    group: 'race',
    hint: 'Vueltas terminadas hasta ahora.',
    kind: 'count',
    direction: 'higher',
    pick: (m) => (hasData(m) ? m.lapsCompleted : null),
  },
  {
    key: 'brier',
    label: 'Brier score',
    group: 'calibration',
    hint: 'Error cuadrático medio entre la confianza declarada y el acierto real. 0 = perfecto; menor es mejor.',
    kind: 'score',
    direction: 'lower',
    pick: (m) => m.calibration.brier,
  },
  {
    key: 'ece',
    label: 'ECE',
    group: 'calibration',
    hint: 'Error de calibración esperado (10 intervalos): diferencia media entre confianza y precisión. Menor es mejor.',
    kind: 'score',
    direction: 'lower',
    pick: (m) => m.calibration.ece,
  },
  {
    key: 'lowConfidenceRate',
    label: 'Confianza baja (< 50 %)',
    group: 'calibration',
    hint: 'Parte de las decisiones donde el modelo declaró menos de 50 % de confianza en su movimiento.',
    kind: 'percent',
    direction: 'none',
    pick: (m) => m.calibration.lowConfidenceRate,
  },
  {
    key: 'costPerDecision',
    label: 'Costo por decisión',
    group: 'cost',
    hint: 'USD por decisión (estimado en modo SIMULADO).',
    kind: 'usd',
    direction: 'lower',
    pick: (m) => (hasData(m) ? m.costPerDecision : null),
    ratioWord: 'más barato',
  },
  {
    key: 'costTotal',
    label: 'Costo total',
    group: 'cost',
    hint: 'USD acumulados. Solo comparable cuando ambos carriles llevan las mismas decisiones.',
    kind: 'usd',
    direction: 'lower',
    pick: (m) => (hasData(m) ? m.costUsd : null),
    ratioWord: 'más barato',
    needsSameDecisions: true,
  },
  {
    key: 'tokens',
    label: 'Tokens (entrada / salida)',
    group: 'cost',
    hint: 'Tokens enviados y recibidos. Informativo: cada proveedor tokeniza distinto.',
    kind: 'tokens',
    direction: 'none',
    pick: (m) => (m.tokensIn + m.tokensOut > 0 ? m.tokensIn + m.tokensOut : null),
    extra: (m) => `${fmtCompact(m.tokensIn)} / ${fmtCompact(m.tokensOut)}`,
  },
]

// ─────────────────────────────── Formatting ───────────────────────────────

function fmtValue(kind: Kind, v: number): string {
  switch (kind) {
    case 'percent':
      return fmtPercent(v)
    case 'ms':
      return fmtMs(v)
    case 'clock':
      return fmtClock(v)
    case 'usd':
      return fmtUsd(v)
    case 'count':
      return fmtInt(v)
    case 'score':
      return fmtScore(v)
    case 'tokens':
      return fmtCompact(v)
    case 'rate':
      return fmtNumber(v, 1)
  }
}

function formatCell(def: RowDef, m: EngineMetrics, v: number | null): string {
  if (v === null) return DASH
  if (def.kind === 'tokens' && def.extra) return def.extra(m)
  const base = fmtValue(def.kind, v)
  return def.extra ? `${base} · ${def.extra(m)}` : base
}

// Differences at or below these are reported as ties (below display resolution).
const TIE_ABS: Partial<Record<Kind, number>> = {
  percent: 0.0005, // 0.05 pp
  score: 0.0005,
}
/** Relative tie tolerance for magnitudes where only the ratio matters. */
const TIE_REL = 0.02

function isTie(kind: Kind, a: number, b: number): boolean {
  if (a === b) return true
  const abs = TIE_ABS[kind]
  if (abs !== undefined) return Math.abs(a - b) <= abs
  const hi = Math.max(Math.abs(a), Math.abs(b))
  return kind !== 'count' && hi > 0 && Math.abs(a - b) / hi <= TIE_REL
}

/** Advantage text from the winner's point of view (winner − loser for differences, loser / winner for lower-is-better ratios). */
function deltaText(def: RowDef, winner: number, loser: number): string {
  const d = winner - loser
  const sign = d > 0 ? '+' : d < 0 ? '−' : ''
  switch (def.kind) {
    case 'percent':
      return fmtPp(d)
    case 'score':
      return `${sign}${Math.abs(d).toFixed(3)}`
    case 'count':
      return `${sign}${Math.abs(d)}`
    default: {
      const big = def.direction === 'lower' ? loser : winner
      const small = def.direction === 'lower' ? winner : loser
      if (def.ratioWord && small > 0 && big / small >= 1.05) return `${(big / small).toFixed(1)}× ${def.ratioWord}`
      const abs = Math.abs(d)
      if (def.kind === 'ms') return `${sign}${fmtMs(abs)}`
      if (def.kind === 'clock') return `${sign}${(abs / 1000).toFixed(1)} s`
      if (def.kind === 'usd') return `${sign}${fmtUsd(abs)}`
      return `${sign}${fmtNumber(abs, 1)}`
    }
  }
}

/** Compare GPT (a) against Jev (b), one row per metric. */
export function compareLanes(a: EngineMetrics, b: EngineMetrics): ComparisonRow[] {
  const sameDecisions = a.decisions === b.decisions
  return ROWS.map((def): ComparisonRow => {
    const av = def.pick(a)
    const bv = def.pick(b)
    let better: Winner = null
    let text = ''

    if (def.direction !== 'none' && av !== null && bv !== null && (!def.needsSameDecisions || sameDecisions)) {
      if (isTie(def.kind, av, bv)) {
        better = 'tie'
      } else {
        const aWins = def.direction === 'lower' ? av < bv : av > bv
        better = aWins ? 'gpt' : 'jev'
        text = aWins ? deltaText(def, av, bv) : deltaText(def, bv, av)
      }
    }

    return {
      key: def.key,
      label: def.label,
      group: def.group,
      hint: def.hint,
      gpt: av,
      jev: bv,
      gptText: formatCell(def, a, av),
      jevText: formatCell(def, b, bv),
      better,
      lowerIsBetter: def.direction === 'none' ? null : def.direction === 'lower',
      deltaText: text,
    }
  })
}

const NAME: Record<'gpt' | 'jev', string> = { gpt: 'GPT', jev: 'Jev' }
const NO_DATA = 'Aún no hay decisiones suficientes para comparar.'

/** One-sentence summary, e.g. "Jev decide 6.3× más rápido con +4.0 pp de aciertos". */
export function compareHeadline(rows: readonly ComparisonRow[]): string {
  const latency = rows.find((r) => r.key === 'latencyP50')
  const hits = rows.find((r) => r.key === 'hitRate')
  if (!latency || !hits || (latency.better === null && hits.better === null)) return NO_DATA

  const lw = latency.better === 'gpt' || latency.better === 'jev' ? latency.better : null
  const hw = hits.better === 'gpt' || hits.better === 'jev' ? hits.better : null
  const hitPp = hits.gpt !== null && hits.jev !== null ? Math.abs(hits.gpt - hits.jev) * 100 : 0
  const ppText = `${hitPp.toFixed(1)} pp`

  const speed = lw ? `${NAME[lw]} decide ${latency.deltaText}` : 'Ambos deciden a un ritmo similar'

  if (hw) {
    if (lw === hw) return `${speed} con +${ppText} de aciertos`
    if (lw) return `${speed}, pero ${NAME[hw]} acierta +${ppText} más`
    return `${NAME[hw]} acierta +${ppText} más, con latencia similar`
  }
  if (hits.better === 'tie') return `${speed} y con aciertos equivalentes`
  return lw ? speed : NO_DATA
}
