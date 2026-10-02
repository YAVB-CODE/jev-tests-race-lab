import clsx from 'clsx'
import { LANE_NAME } from '../components/metrics/lanes.ts'
import type { EngineId } from '../shared/contracts.ts'
import { ActionButton, INPUT_CLASS } from './controls.tsx'
import { modelOptionLabel } from './labels.ts'
import { useRaceStore } from './store.ts'

/** Per-lane model dropdown, fed by GET /api/models. The pick is sent with every /api/decide of that lane. */
export function ModelPicker({ engine, locked }: { engine: EngineId; locked: boolean }) {
  const catalogue = useRaceStore((s) => s.models?.engines[engine])
  const selected = useRaceStore((s) => s.selectedModels[engine])
  const fallbackDefault = useRaceStore((s) => s.health?.engines[engine].model)
  const liveAvailable = useRaceStore((s) => s.liveAvailable[engine])
  const mode = useRaceStore((s) => s.modes[engine])
  const setModel = useRaceStore((s) => s.setModel)
  const loadModels = useRaceStore((s) => s.loadModels)

  const name = LANE_NAME[engine]
  const defaultId = catalogue?.default ?? fallbackDefault
  const value = selected ?? defaultId ?? ''
  const disabled = locked || !liveAvailable || !catalogue

  let title = `Modelo que usa ${name} en modo Live. Las tarifas son USD por millón de tokens.`
  if (!liveAvailable) title = `Configura la API key de ${name} en .env para elegir un modelo.`
  else if (!catalogue) title = 'Cargando modelos…'
  else if (catalogue.source === 'fallback') title += ` Lista integrada${catalogue.error ? ` (el proveedor no respondió: ${catalogue.error})` : ''}.`
  if (locked) title = 'El modelo no se puede cambiar durante la carrera.'
  if (mode === 'mock' && liveAvailable) title += ' Ahora el carril está en Simulado: el modelo se usará al pasar a Live.'

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <select
        aria-label={`Modelo de ${name}`}
        title={title}
        className={clsx(INPUT_CLASS, 'min-w-0 flex-1 truncate font-mono text-xs', mode === 'mock' && 'opacity-60')}
        value={value}
        disabled={disabled}
        onChange={(e) => setModel(engine, e.target.value)}
      >
        {!catalogue && <option value={value}>{value || 'cargando…'}</option>}
        {catalogue?.models.map((m) => (
          <option key={m.id} value={m.id}>
            {modelOptionLabel(engine, m, m.id === defaultId)}
          </option>
        ))}
      </select>
      <ActionButton
        aria-label={`Recargar modelos de ${name}`}
        title="Volver a listar los modelos del proveedor"
        className="w-8 px-0 text-sm"
        disabled={locked || !liveAvailable}
        onClick={() => void loadModels(true)}
      >
        ⟳
      </ActionButton>
      {catalogue?.source === 'fallback' && liveAvailable && (
        <span className="text-xs text-warn" title={title} aria-label="Lista de modelos integrada">
          !
        </span>
      )}
    </span>
  )
}
