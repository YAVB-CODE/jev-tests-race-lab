import clsx from 'clsx'
import { useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { LaneMetrics } from '../components/metrics/index.ts'
import {
  LANE_STYLE,
  MOVE_ARROW,
  MOVE_LABEL,
  MOVE_OUTCOME_LABEL,
  SPEED_LABEL,
  SPEED_OUTCOME_LABEL,
} from '../components/metrics/lanes.ts'
import { ModeBadge } from '../components/metrics/ui.tsx'
import { TrackView } from '../components/track/index.ts'
import { fmtClock, fmtMs, fmtPercent } from '../metrics/index.ts'
import { getTrack } from '../sim/index.ts'
import type { DecisionRecord, EngineId, LiveFrame, SpeedOutcome, TrackDefinition } from '../shared/contracts.ts'
import { Chip } from './controls.tsx'
import { TONE_CLASS, laneStatus } from './labels.ts'
import type { Tone } from './labels.ts'
import { getRunner, useRaceStore } from './store.ts'

const HEADING_ANGLE = { N: 0, E: 90, S: 180, W: 270 } as const

/** Frame of a car parked on the start cell (used until the runner exists). */
function parkedFrame(track: TrackDefinition): LiveFrame {
  const { cell, heading } = track.start
  return { pose: { x: cell.x + 0.5, y: cell.y + 0.5, angleDeg: HEADING_ANGLE[heading] }, phase: 'idle', raceTimeMs: 0, thinkingElapsedMs: null }
}

// ───────────────────────────── Última decisión ─────────────────────────────

type Verdict = 'hit' | 'partial' | 'error'

const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  hit: { label: 'Acierto', tone: 'ok' },
  partial: { label: 'Parcial', tone: 'warn' },
  error: { label: 'Error', tone: 'bad' },
}

const SPEED_TONE: Record<SpeedOutcome, string> = {
  correct: 'text-ok',
  too_slow: 'text-warn',
  too_fast: 'text-bad',
  not_graded: 'text-ink-dim',
}

const STATUS_TEXT = {
  invalid: 'Respuesta inválida',
  timeout: 'Sin respuesta (timeout)',
  error: 'Fallo del motor',
} as const

function DecisionCell({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[10px] font-medium tracking-wide text-ink-faint uppercase">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] leading-snug">{children}</dd>
    </div>
  )
}

function outcomeSummary(r: DecisionRecord): string {
  const parts = [MOVE_OUTCOME_LABEL[r.moveOutcome]]
  if (r.speedOutcome !== 'not_graded' && r.speedOutcome !== 'correct') parts.push(SPEED_OUTCOME_LABEL[r.speedOutcome])
  if (r.penaltyMs > 0) parts.push(`+${(r.penaltyMs / 1000).toFixed(1)} s`)
  return parts.join(' · ')
}

/** Compact strip with the latest graded decision of a lane: chosen vs correct, outcome, confidence, latency. */
function LastDecision({ record }: { record: DecisionRecord | undefined }) {
  if (!record) {
    return (
      <div className="flex min-h-[5.5rem] items-center rounded-xl border border-line bg-panel px-3.5 py-3 text-xs text-ink-faint">
        Última decisión: aún no hay decisiones. Pulsa Iniciar para correr.
      </div>
    )
  }

  const { result, oracle } = record
  const { move, speed } = result.answer
  const answered = result.status === 'ok' && move !== null && speed !== null
  const verdict: Verdict = record.hit ? 'hit' : record.error ? 'error' : 'partial'
  const correctSpeed = oracle.speedByMove[oracle.bestMove]
  const confidence = result.answer.moveConfidence
  const speedConfidence = result.answer.speedConfidence

  return (
    <div className="@container rounded-xl border border-line bg-panel px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-xs font-semibold text-ink">Última decisión</span>
        <span className="font-mono text-[11px] text-ink-faint tabular-nums">
          #{record.index + 1} · vuelta {record.lap}
        </span>
        {oracle.isJunction && (
          <Chip tone={TONE_CLASS.info} title="Bifurcación: más de una opción válida">
            Bifurcación
          </Chip>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-ink-dim">{outcomeSummary(record)}</span>
          <Chip tone={TONE_CLASS[VERDICT[verdict].tone]}>{VERDICT[verdict].label}</Chip>
        </span>
      </div>

      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2.5 @lg:grid-cols-4">
        <DecisionCell label="Elegido" title={result.errorMessage}>
          {answered ? (
            <>
              <span className={record.moveOutcome === 'optimal' ? 'text-ok' : record.moveOutcome === 'suboptimal' ? 'text-warn' : 'text-bad'}>
                {MOVE_ARROW[move]} {MOVE_LABEL[move]}
              </span>
              <span className="text-ink-faint"> · </span>
              <span className={SPEED_TONE[record.speedOutcome]}>{SPEED_LABEL[speed]}</span>
            </>
          ) : (
            <span className="text-bad">{STATUS_TEXT[result.status === 'ok' ? 'invalid' : result.status]}</span>
          )}
        </DecisionCell>
        <DecisionCell label="Correcto" title="Mejor movimiento según el oráculo y su velocidad correcta">
          <span className="text-ink">
            {MOVE_ARROW[oracle.bestMove]} {MOVE_LABEL[oracle.bestMove]}
          </span>
          <span className="text-ink-faint"> · </span>
          <span className="text-ink">{correctSpeed ? SPEED_LABEL[correctSpeed] : '—'}</span>
        </DecisionCell>
        <DecisionCell
          label="Confianza"
          title={speedConfidence !== undefined ? `Velocidad: ${fmtPercent(speedConfidence, 0)}` : 'El motor no reportó confianza'}
        >
          <span className="font-mono tabular-nums">{confidence !== undefined ? fmtPercent(confidence, 0) : '—'}</span>
        </DecisionCell>
        <DecisionCell
          label="Latencia"
          title={result.providerLatencyMs !== undefined ? `Del proveedor: ${fmtMs(result.providerLatencyMs)}` : undefined}
        >
          <span className="font-mono tabular-nums">{fmtMs(record.latencyMs)}</span>
        </DecisionCell>
      </dl>
    </div>
  )
}

// ───────────────────────────── Lane panel ─────────────────────────────

/** One lane of the split view: header, circuit, last decision and KPIs. */
export function LanePanel({ engine }: { engine: EngineId }) {
  const lane = useRaceStore((s) => s.lanes[engine])
  const trackId = useRaceStore((s) => s.config.trackId)
  const track = useMemo(() => getTrack(trackId), [trackId])
  const style = LANE_STYLE[engine]
  const status = laneStatus(lane.snapshot)
  const finished = lane.snapshot?.status === 'finished'

  // Stable: TrackView calls it every animation frame and always reads the current runner.
  const getFrame = useCallback(() => getRunner(engine)?.getFrame() ?? parkedFrame(track), [engine, track])

  return (
    <section aria-label={`Carril ${lane.label}`} className="flex min-w-0 flex-col gap-3">
      <header className={clsx('flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-xl border bg-panel px-3.5 py-2.5', style.border)}>
        <span aria-hidden className={clsx('h-5 w-1 rounded-full', style.bg)} />
        <h2 className={clsx('min-w-0 truncate text-base font-semibold', style.text)}>{lane.label}</h2>
        <ModeBadge mode={lane.mode} />
        <span className="ml-auto flex items-center gap-2">
          {finished && lane.snapshot && (
            <span className="font-mono text-xs font-semibold text-ok tabular-nums" title="Tiempo total de carrera">
              {fmtClock(lane.snapshot.raceTimeMs)}
            </span>
          )}
          <Chip tone={TONE_CLASS[status.tone]}>{finished ? '🏁 ¡Meta!' : status.text}</Chip>
        </span>
      </header>

      {lane.snapshot ? (
        <TrackView track={track} snapshot={lane.snapshot} getFrame={getFrame} accent={style.color} label={lane.label} />
      ) : null}

      <LastDecision record={lane.records[lane.records.length - 1]} />
      <LaneMetrics lane={lane} />
    </section>
  )
}
