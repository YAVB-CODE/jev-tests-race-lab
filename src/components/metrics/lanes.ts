/** Static lookups shared by the metrics components (class names must stay literal so Tailwind can see them). */
import type { EngineId, MoveOutcome, RelativeMove, SpeedMode, SpeedOutcome } from '../../shared/contracts.ts'

export const ENGINE_IDS: readonly EngineId[] = ['gpt', 'jev']

export const LANE_NAME: Record<EngineId, string> = { gpt: 'GPT', jev: 'Jev' }

export interface LaneStyle {
  /** CSS color for SVG attributes (charts). */
  color: string
  text: string
  bg: string
  bgSoft: string
  border: string
  ring: string
}

export const LANE_STYLE: Record<EngineId, LaneStyle> = {
  gpt: {
    color: 'var(--color-gpt)',
    text: 'text-gpt',
    bg: 'bg-gpt',
    bgSoft: 'bg-gpt/10',
    border: 'border-gpt/40',
    ring: 'ring-gpt/40',
  },
  jev: {
    color: 'var(--color-jev)',
    text: 'text-jev',
    bg: 'bg-jev',
    bgSoft: 'bg-jev/10',
    border: 'border-jev/40',
    ring: 'ring-jev/40',
  },
}

export const MOVE_LABEL: Record<RelativeMove, string> = { forward: 'Adelante', left: 'Izquierda', right: 'Derecha' }
export const MOVE_ARROW: Record<RelativeMove, string> = { forward: '↑', left: '←', right: '→' }
export const SPEED_LABEL: Record<SpeedMode, string> = { slow: 'Lento', cruise: 'Crucero', boost: 'Turbo' }

export const MOVE_OUTCOME_LABEL: Record<MoveOutcome, string> = {
  optimal: 'Óptimo',
  suboptimal: 'Subóptimo',
  crash: 'Choque',
  invalid: 'Inválido',
  timeout: 'Timeout',
  error: 'Fallo',
}

export const SPEED_OUTCOME_LABEL: Record<SpeedOutcome, string> = {
  correct: 'Correcta',
  too_slow: 'Muy lenta',
  too_fast: 'Trompo',
  not_graded: 'Sin calificar',
}

/** Chart fills for outcome segments. Status colors keep their meaning; the neutrals are the "no usable answer" family. */
export const MOVE_OUTCOME_COLOR: Record<MoveOutcome, string> = {
  optimal: 'var(--color-ok)',
  suboptimal: 'var(--color-warn)',
  crash: 'var(--color-bad)',
  invalid: 'var(--color-info)',
  timeout: 'var(--color-ink-dim)',
  error: 'var(--color-ink-faint)',
}

export const SPEED_OUTCOME_COLOR: Record<SpeedOutcome, string> = {
  correct: 'var(--color-ok)',
  too_slow: 'var(--color-warn)',
  too_fast: 'var(--color-bad)',
  not_graded: 'var(--color-ink-faint)',
}

/** Text color that stays legible on top of each outcome fill. */
export const ON_FILL_DARK = 'var(--color-surface)'
export const ON_FILL_LIGHT = '#ffffff'
