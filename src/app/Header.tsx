import clsx from 'clsx'
import { LANE_NAME, LANE_STYLE } from '../components/metrics/lanes.ts'
import type { EngineId } from '../shared/contracts.ts'
import { Chip } from './controls.tsx'
import { API_KEY_NAME, TONE_CLASS } from './labels.ts'
import { ENGINE_IDS, useRaceStore } from './store.ts'

function ApiChip({ engine }: { engine: EngineId }) {
  const health = useRaceStore((s) => s.health)
  const live = useRaceStore((s) => s.liveAvailable[engine])
  const selected = useRaceStore((s) => s.selectedModels[engine])
  const model = selected ?? health?.engines[engine]?.model
  const provider = health?.engines[engine]?.provider
  const name = LANE_NAME[engine]

  let tone = TONE_CLASS.neutral
  let text = 'comprobando…'
  let title = `Consultando /api/health para ${name}`
  if (health) {
    if (live) {
      tone = TONE_CLASS.ok
      text = 'LIVE disponible'
      title = `${name} puede correr en modo LIVE con el modelo ${model}${provider ? ` vía ${provider}` : ''}`
    } else {
      tone = TONE_CLASS.warn
      text = 'sin API key'
      title = `${name} solo puede correr SIMULADO. Configura ${API_KEY_NAME[engine]} en .env (y arranca el backend) para habilitar LIVE.`
    }
  }

  return (
    <Chip tone={tone} title={title} className="gap-2 py-1.5">
      <span aria-hidden className={clsx('size-2 rounded-full', LANE_STYLE[engine].bg)} />
      <span className="text-ink">{name}</span>
      <span aria-hidden className="text-ink-faint">
        ·
      </span>
      <span>{text}</span>
      {health && live && model && (
        <span className="hidden font-mono text-[10px] text-ink-dim sm:inline">
          {model}
          {provider && ` · ${provider}`}
        </span>
      )}
    </Chip>
  )
}

export function Header() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2.5 text-2xl leading-tight font-semibold tracking-tight">
          <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-linear-to-br from-gpt to-jev text-[13px] text-surface">
            ⚑
          </span>
          Jev Race Lab
        </h1>
        <p className="mt-1 text-sm text-ink-dim">GPT vs Jev — ¿quién decide mejor en la pista?</p>
      </div>
      <div className="flex flex-wrap items-center gap-2" aria-label="Estado de las APIs">
        {ENGINE_IDS.map((id) => (
          <ApiChip key={id} engine={id} />
        ))}
      </div>
    </header>
  )
}
