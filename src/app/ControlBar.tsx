import { useMemo } from 'react'
import { ExportButtons } from '../components/metrics/index.ts'
import { LANE_NAME } from '../components/metrics/lanes.ts'
import { LaneDot } from '../components/metrics/ui.tsx'
import { TRACKS } from '../sim/index.ts'
import type { EngineId, EngineMode } from '../shared/contracts.ts'
import { ActionButton, Field, INPUT_CLASS, NumberField, SegmentedControl } from './controls.tsx'
import { DIFFICULTY_OPTIONS, LIVE_UNAVAILABLE_HINT } from './labels.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { ENGINE_IDS, LAP_LIMITS, SEED_MAX, TIMEOUT_LIMITS_MS, useRaceStore } from './store.ts'

const MODE_LABEL: Record<EngineMode, string> = { mock: 'Simulado', live: 'Live' }

function ModeToggle({ engine, locked }: { engine: EngineId; locked: boolean }) {
  const mode = useRaceStore((s) => s.modes[engine])
  const liveAvailable = useRaceStore((s) => s.liveAvailable[engine])
  const setMode = useRaceStore((s) => s.setMode)
  return (
    <Field
      as="div"
      className="min-w-0"
      label={
        <>
          <LaneDot engine={engine} className="size-2" />
          {LANE_NAME[engine]} · modo y modelo
        </>
      }
    >
      <span className="flex min-w-0 items-center gap-1.5">
      <SegmentedControl<EngineMode>
        label={`Modo de ${LANE_NAME[engine]}`}
        value={mode}
        disabled={locked}
        onChange={(m) => setMode(engine, m)}
        options={[
          { value: 'mock', label: MODE_LABEL.mock, title: 'Motor local con perfiles parametrizados: no es una medición.' },
          {
            value: 'live',
            label: MODE_LABEL.live,
            disabled: !liveAvailable,
            title: liveAvailable ? 'Llamadas reales al proveedor a través del backend.' : LIVE_UNAVAILABLE_HINT,
          },
        ]}
      />
      <ModelPicker engine={engine} locked={locked} />
      </span>
    </Field>
  )
}

export function ControlBar() {
  const config = useRaceStore((s) => s.config)
  const raceStatus = useRaceStore((s) => s.raceStatus)
  const lanes = useRaceStore((s) => s.lanes)
  const setConfig = useRaceStore((s) => s.setConfig)
  const randomizeSeed = useRaceStore((s) => s.randomizeSeed)
  const start = useRaceStore((s) => s.start)
  const pause = useRaceStore((s) => s.pause)
  const resume = useRaceStore((s) => s.resume)
  const reset = useRaceStore((s) => s.reset)

  const locked = raceStatus === 'running' || raceStatus === 'paused'
  const track = TRACKS.find((t) => t.id === config.trackId)
  const meta = useMemo(
    () => ({
      source: 'jev-race-lab',
      trackId: config.trackId,
      laps: config.laps,
      seed: config.seed,
      difficulty: config.difficulty,
      decisionTimeoutMs: config.decisionTimeoutMs,
      raceStatus,
    }),
    [config, raceStatus],
  )

  return (
    <section aria-label="Controles de la carrera" className="rounded-xl border border-line bg-panel p-3.5 sm:p-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Field label="Circuito" hint={track?.description} className="min-w-40 flex-1 sm:flex-none">
          <select
            className={INPUT_CLASS}
            value={config.trackId}
            disabled={locked}
            onChange={(e) => setConfig({ trackId: e.target.value })}
          >
            {TRACKS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.hasForks ? ' · con bifurcaciones' : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Vueltas">
          <NumberField
            className="w-16"
            value={config.laps}
            min={LAP_LIMITS.min}
            max={LAP_LIMITS.max}
            disabled={locked}
            onCommit={(laps) => setConfig({ laps })}
          />
        </Field>

        <Field as="div" label="Dificultad">
          <SegmentedControl
            label="Dificultad"
            value={config.difficulty}
            disabled={locked}
            onChange={(difficulty) => setConfig({ difficulty })}
            options={DIFFICULTY_OPTIONS.map((d) => ({ value: d.value, label: d.label, title: d.hint }))}
          />
        </Field>

        <Field label="Semilla" hint="Misma semilla = mismos obstáculos y mismo azar de los motores simulados.">
          <span className="flex items-center gap-1.5">
            <NumberField
              className="w-24"
              value={config.seed}
              min={0}
              max={SEED_MAX}
              disabled={locked}
              ariaLabel="Semilla"
              onCommit={(seed) => setConfig({ seed })}
            />
            <ActionButton
              aria-label="Semilla aleatoria"
              title="Semilla aleatoria"
              className="w-8 px-0 text-sm"
              disabled={locked}
              onClick={randomizeSeed}
            >
              🎲
            </ActionButton>
          </span>
        </Field>

        <Field label="Timeout (s)" hint="Tiempo máximo de espera por decisión. Al vencer cuenta como error (+2 s) y el carro sigue en piloto automático.">
          <NumberField
            className="w-16"
            value={config.decisionTimeoutMs / 1000}
            min={TIMEOUT_LIMITS_MS.min / 1000}
            max={TIMEOUT_LIMITS_MS.max / 1000}
            step={1}
            disabled={locked}
            onCommit={(seconds) => setConfig({ decisionTimeoutMs: seconds * 1000 })}
          />
        </Field>

      </div>

      <div className="mt-3 grid gap-x-4 gap-y-3 md:grid-cols-2">
        {ENGINE_IDS.map((id) => (
          <ModeToggle key={id} engine={id} locked={locked} />
        ))}
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
        <ActionButton variant="primary" className="min-w-24" disabled={locked} onClick={start}>
          ▶ Iniciar
        </ActionButton>
        <ActionButton disabled={raceStatus !== 'running'} onClick={pause}>
          ❚❚ Pausar
        </ActionButton>
        <ActionButton disabled={raceStatus !== 'paused'} onClick={resume}>
          ▶ Reanudar
        </ActionButton>
        <ActionButton disabled={raceStatus === 'idle'} onClick={reset}>
          ■ Reiniciar
        </ActionButton>
        {locked && <span className="text-[11px] text-ink-faint">La configuración se bloquea mientras la carrera está en curso.</span>}
        <ExportButtons lanes={lanes} meta={meta} className="ml-auto" />
      </div>
    </section>
  )
}
