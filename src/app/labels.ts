/** Spanish UI copy shared by the app shell components. */
import type { Difficulty, EngineId, LaneSnapshot, ModelOption } from '../shared/contracts.ts'

export const DIFFICULTY_OPTIONS: ReadonlyArray<{ value: Difficulty; label: string; hint: string }> = [
  {
    value: 'easy',
    label: 'Fácil',
    hint: 'Opciones con campos numéricos (en pista, bloqueo, peligro, tramo recto, aceite) y la distancia al checkpoint de cada ruta.',
  },
  {
    value: 'normal',
    label: 'Normal',
    hint: 'Opciones con un resumen en texto de cada ruta y un mapa local de 7×7 celdas.',
  },
  {
    value: 'hard',
    label: 'Difícil',
    hint: 'Solo un mapa ASCII egocéntrico de 11×11 y la posición del checkpoint: requiere razonamiento espacial.',
  },
]

export const LIVE_UNAVAILABLE_HINT = 'Configura OPENAI_API_KEY / OPENCODE_API_KEY en .env'

export const API_KEY_NAME: Record<EngineId, string> = { gpt: 'OPENAI_API_KEY', jev: 'OPENCODE_API_KEY' }

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'bad'

export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-line bg-panel-2 text-ink-dim',
  info: 'border-info/40 bg-info/10 text-info',
  ok: 'border-ok/40 bg-ok/10 text-ok',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  bad: 'border-bad/40 bg-bad/10 text-bad',
}

/** Human status of a lane for its header chip. */
export function laneStatus(snapshot: LaneSnapshot | null): { text: string; tone: Tone } {
  if (!snapshot) return { text: 'Cargando…', tone: 'neutral' }
  switch (snapshot.status) {
    case 'idle':
      return { text: 'Listo en la parrilla', tone: 'neutral' }
    case 'paused':
      return { text: 'En pausa', tone: 'warn' }
    case 'finished':
      return { text: '¡Meta!', tone: 'ok' }
    case 'aborted':
      return { text: 'Detenida', tone: 'bad' }
    case 'running':
      switch (snapshot.phase) {
        case 'thinking':
          return { text: 'Pensando…', tone: 'info' }
        case 'crashed':
          return { text: 'Choque', tone: 'bad' }
        case 'spinning':
          return { text: 'Trompo', tone: 'bad' }
        default:
          return { text: 'En movimiento', tone: 'info' }
      }
  }
}

function usd(perMTok: number): string {
  if (perMTok === 0) return '0'
  return perMTok < 0.1 ? String(Number(perMTok.toFixed(3))) : perMTok.toFixed(2)
}

/** "gpt-4.1-mini · $0.40 / $1.60" · "jev-1.13 · $0.042 in" · "jev-1.13-free · gratis" */
export function modelOptionLabel(engine: EngineId, option: ModelOption, isDefault: boolean): string {
  const parts = [option.id]
  if (option.priceSource === 'free') parts.push('gratis')
  else if (option.inputPerMTok !== undefined) {
    parts.push(engine === 'jev' ? `$${usd(option.inputPerMTok)} in` : `$${usd(option.inputPerMTok)} / $${usd(option.outputPerMTok ?? 0)}`)
  } else parts.push('precio desconocido')
  if (option.reasoning) parts.push('razonamiento')
  if (isDefault) parts.push('por defecto (.env)')
  return parts.join(' · ')
}
