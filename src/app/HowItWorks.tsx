import type { ReactNode } from 'react'
import { RULES } from '../shared/rules.ts'
import { DIFFICULTY_OPTIONS } from './labels.ts'

const sec = (ms: number): string => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-ink uppercase">{title}</h3>
      <div className="space-y-1.5 text-[13px] leading-relaxed text-ink-dim">{children}</div>
    </div>
  )
}

function Term({ children }: { children: ReactNode }) {
  return <b className="font-semibold text-ink">{children}</b>
}

const LIST = 'list-disc space-y-1 pl-4 marker:text-ink-faint'

/** Collapsible explainer: rules, difficulty levels, metric definitions, who Jev is and how the comparison is kept fair. */
export function HowItWorks() {
  const s = RULES.SPEED
  return (
    <details className="group rounded-xl border border-line bg-panel">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-sm font-medium text-ink select-none hover:bg-panel-2/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-ink-faint transition-transform group-open:rotate-90">
          ▶
        </span>
        ¿Cómo funciona?
        <span className="ml-1 hidden text-xs font-normal text-ink-faint sm:inline">Reglas, dificultades, métricas y equidad del experimento</span>
      </summary>

      <div className="grid gap-x-8 gap-y-5 border-t border-line px-4 py-4 min-[900px]:grid-cols-2 min-[1280px]:grid-cols-3">
        <Block title="La idea">
          <p>
            Dos carros recorren el mismo circuito en vista dividida. En <Term>cada celda se detienen y esperan la decisión de su IA</Term>: qué
            movimiento hacer y a qué velocidad. Medimos aciertos, errores, tiempo de decisión, calibración y costo.
          </p>
          <p>
            <Term>GPT</Term> corre con OpenAI usando salidas estructuradas (JSON schema). <Term>Jev</Term> es un modelo «System One», servido por
            OpenCode Zen: recibe un estado y preguntas tipadas y devuelve decisiones con probabilidades calibradas en milisegundos (
            <a className="text-info underline decoration-info/40 underline-offset-2 hover:decoration-info" href="https://opencode.ai/docs/zen" target="_blank" rel="noreferrer">
              opencode.ai/docs/zen
            </a>
            ).
          </p>
        </Block>

        <Block title="Reglas de la pista">
          <ul className={LIST}>
            <li>
              Movimientos <Term>relativos</Term> al rumbo del carro: adelante, izquierda o derecha. No hay giros en U.
            </li>
            <li>
              Velocidades: <Term>lento</Term> ({RULES.CELL_TRAVEL_MS.slow} ms por celda), <Term>crucero</Term> ({RULES.CELL_TRAVEL_MS.cruise} ms) y{' '}
              <Term>turbo</Term> ({RULES.CELL_TRAVEL_MS.boost} ms).
            </li>
            <li>
              Regla de velocidad: <Term>lento</Term> es obligatorio si hay aceite en las primeras {s.OIL_SLOW_WITHIN} celdas o si hay que girar justo
              después (tramo recto ≤ {s.SLOW_MAX_STRAIGHT}). <Term>Turbo</Term> solo con al menos {s.BOOST_MIN_STRAIGHT} celdas rectas y sin aceite
              en las primeras {s.BOOST_CLEAR_WITHIN}. En cualquier otro caso, <Term>crucero</Term>.
            </li>
            <li>
              En una bifurcación gana la ruta <Term>más corta</Term> hasta el siguiente checkpoint. Los conos cierran una rama; el aceite exige ir lento.
            </li>
          </ul>
        </Block>

        <Block title="Penalizaciones">
          <ul className={LIST}>
            <li>
              <Term>Choque</Term> (fuera de pista, sentido contrario o conos): +{sec(RULES.CRASH_PENALTY_MS)}. El carro vuelve a la mejor ruta.
            </li>
            <li>
              <Term>Trompo</Term> (ir más rápido de lo permitido): +{sec(RULES.SPIN_PENALTY_MS)}.
            </li>
            <li>
              <Term>Respuesta inválida, timeout o fallo del motor</Term>: +{sec(RULES.INVALID_PENALTY_MS)} y el carro sigue en piloto automático
              (mejor movimiento, lento). El timeout por defecto es de {sec(RULES.DEFAULT_DECISION_TIMEOUT_MS)}.
            </li>
            <li>Ir más lento de lo necesario no se penaliza, solo hace perder tiempo.</li>
          </ul>
        </Block>

        <Block title="Qué ve la IA en cada dificultad">
          <ul className={LIST}>
            {DIFFICULTY_OPTIONS.map((d) => (
              <li key={d.value}>
                <Term>{d.label}:</Term> {d.hint}
              </li>
            ))}
          </ul>
        </Block>

        <Block title="Acierto, error y parcial">
          <ul className={LIST}>
            <li>
              <Term>Acierto</Term>: movimiento óptimo (ruta más corta) <em>y</em> velocidad correcta.
            </li>
            <li>
              <Term>Error</Term>: choque, respuesta inválida, timeout, fallo del motor o trompo por exceso de velocidad.
            </li>
            <li>
              <Term>Parcial</Term>: ni acierto ni error; por ejemplo, un movimiento válido pero más largo (subóptimo) o una velocidad más lenta de lo necesario.
            </li>
          </ul>
          <p>La calibración compara la confianza que declara cada modelo con su acierto real (Brier score y ECE).</p>
        </Block>

        <Block title="Equidad y modos">
          <ul className={LIST}>
            <li>
              Ambos carriles corren el <Term>mismo circuito, la misma semilla y los mismos obstáculos</Term>.
            </li>
            <li>
              Reciben <Term>exactamente la misma observación y el mismo texto de reglas</Term>, y se califican con el <Term>mismo oráculo</Term>.
            </li>
            <li>
              <Term>SIMULADO</Term>: motores locales con perfiles parametrizados (no medidos). <Term>LIVE</Term>: llamadas reales a través del backend.{' '}
              <Term>Solo LIVE valida la eficacia.</Term>
            </li>
          </ul>
        </Block>
      </div>
    </details>
  )
}
