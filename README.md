# Jev Race Lab

Dos carros recorren el mismo circuito cerrado en **vista dividida**. En cada celda el carro se detiene y espera la decisión de una IA (qué movimiento hacer y a qué velocidad):

| Carril izquierdo | Carril derecho |
| --- | --- |
| **GPT**: LLM tradicional (OpenAI, salidas estructuradas con JSON schema) | **Jev**: modelo «System One» vía [OpenCode Zen](https://opencode.ai/docs/zen), con probabilidades calibradas en milisegundos |

La app mide **aciertos, errores, tiempo de decisión, calibración y costo** de cada modelo. Ambos carriles corren el mismo circuito, con la misma semilla y los mismos obstáculos, reciben la misma observación y se califican contra el mismo oráculo.

La API de Jev está documentada en [OpenCode Zen](https://opencode.ai/docs/zen)

## Inicio rápido

```bash
npm install
cp .env.example .env     # opcional: sin keys todo funciona en modo SIMULADO
npm run dev              # web + API
```

Abre http://localhost:5173. Elige circuito, vueltas y dificultad, y pulsa **Iniciar**.

Requiere Node 22 o superior. `npm run dev` levanta Vite (puerto 5173) y el backend Express (puerto 8787); Vite redirige `/api` al backend.

### Parámetros de URL (desarrollo y QA)

| Parámetro | Efecto |
| --- | --- |
| `?autostart=1` | inicia la carrera en cuanto la app está lista |
| `?track=ovalo&laps=1&seed=7&difficulty=hard&timeout=5` | precarga la configuración (todos opcionales) |
| `?demo=track` | página de QA visual del circuito (`TrackViewDemo`) |
| `?demo=metrics` | página de QA visual de las métricas (`MetricsDemo`) |

## Modos: SIMULADO vs LIVE

- **SIMULADO** (por defecto): motores locales (`MockEngine`) con perfiles de latencia y error **parametrizados, no medidos**. Sirven para desarrollar y hacer demos sin API keys. La UI lo marca siempre con el badge **SIMULADO** y un aviso visible, y el costo se muestra como estimado.
- **LIVE**: llamadas reales a OpenAI y a OpenCode Zen a través del backend (`server/`), que es quien guarda las API keys (el navegador nunca las ve).

> **Solo el modo LIVE valida la eficacia.** Los resultados SIMULADOS no miden nada, y una carrera con un carril SIMULADO y otro LIVE tampoco es una comparación válida. La exportación JSON incluye `validForEfficacy: true` únicamente cuando ambos carriles son LIVE.

Para habilitar LIVE, completa `.env` (el botón **Live** de cada carril se activa cuando el backend reporta la key):

```bash
OPENAI_API_KEY=...      # carril GPT
OPENCODE_API_KEY=...    # carril Jev (OpenCode Zen)
```

### Elegir el modelo desde la UI

Junto al selector **Simulado / Live** de cada carril hay un desplegable de modelos que se carga con `GET /api/models`:

- **GPT**: los modelos de chat con salida estructurada que ve tu `OPENAI_API_KEY` (filtra audio, imagen, embeddings, codex, `*-pro`, snapshots con fecha…).
- **Jev**: los modelos `jev*` del catálogo de OpenCode Zen (`jev-1.13-free`, `jev-1.13`).

El modelo elegido viaja en cada `POST /api/decide` de ese carril, así que **queda fijo durante toda la carrera** aunque edites `.env`.
`OPENAI_MODEL` / `JEV_MODEL` solo definen el valor **por defecto** (marcado «por defecto (.env)»). ⟳ vuelve a listar los modelos
(el servidor los guarda 10 min). Cada opción muestra su tarifa en USD por millón de tokens: `OPENAI_PRICE_*` aplica al modelo por
defecto y el resto sale de una tabla integrada (`server/models.ts`, puede estar desactualizada). Los modelos sin precio conocido
muestran «precio desconocido» y su costo queda vacío en las métricas en vez de un valor incorrecto. Los modelos de razonamiento
(gpt-5*, o*) aparecen marcados: son más lentos y pueden superar el timeout por decisión (ajústalo o usa `OPENAI_REASONING_EFFORT`).

### Jev vía OpenCode Zen

Jev se consume **solo** a través de [OpenCode Zen](https://opencode.ai/docs/zen): el backend llama a
`POST https://opencode.ai/zen/v1/systemone` con `Authorization: Bearer $OPENCODE_API_KEY` (una sola llamada por decisión con
dos preguntas *Choice*: `move` y `speed`). Modelos: `jev-1.13-free` (por defecto; gratis por tiempo limitado, costo $0 en las
métricas) y `jev-1.13` ($0.042 / MTok de input, output gratis). `JEV_MODEL` cambia el modelo por defecto y `OPENCODE_BASE_URL`
la URL base (por defecto `https://opencode.ai/zen`). El chip del encabezado muestra el modelo y el gateway en uso.

Las demás variables (modelo, precios por millón de tokens, timeouts y reintentos) están documentadas en [`.env.example`](.env.example).

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | web (Vite) y API (`tsx watch`) en paralelo |
| `npm run dev:web` / `npm run dev:api` | solo la web / solo la API |
| `npm test` | tests con Vitest (`src/**` y `server/**`) |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | oxlint |
| `npm run build` | `tsc -b` y `vite build` (salida en `dist/`) |
| `npm start` | API en el puerto 8787; si existe `dist/`, también sirve la app compilada |
| `npm run preview` | vista previa de Vite sobre `dist/` |
| `npm run smoke` | prueba real contra los proveedores con key (cuesta una fracción de centavo; `-- --runs 3` repite) |

## Arquitectura

```
src/
  shared/             contracts.ts (CONGELADO), rules.ts (reglas canónicas y textos de los prompts), rng.ts
  sim/                circuitos, grafo dirigido, oráculo, observaciones por dificultad, calificación y RaceRunner
  engines/            MockEngine (local), RemoteEngine (POST /api/decide), fetchHealth, perfiles de los mocks
  metrics/            cálculo puro: DecisionRecord[] → EngineMetrics, comparación y formato
  components/
    track/            TrackView (SVG + requestAnimationFrame) y su demo
    metrics/          KPIs por carril, comparación, gráficas, registro de decisiones y exportación
  app/                store (zustand), controles, barra de carrera, paneles de carril, banner final, pestañas, «¿Cómo funciona?»
  App.tsx, main.tsx   entrada de la app
server/               Express: GET /api/health, GET /api/models, POST /api/decide; adaptadores gpt.ts (OpenAI) y jev.ts (OpenCode Zen)
```

Flujo de cada carril (`RaceRunner`): el carro llega a una celda, se calculan el oráculo y la observación, se llama a `engine.decide()` con timeout (se mide la latencia de extremo a extremo), la decisión se califica y se anima el movimiento con sus penalizaciones.

El store (`src/app/store.ts`) guarda en estado reactivo solo datos planos (configuración, modos, health, registros y snapshot por carril). Los `RaceRunner` viven fuera del estado y se alcanzan con `getRunner(engine)`. Cada reconstrucción aborta primero los runners anteriores y descarta sus eventos tardíos, así que nunca hay dos runners vivos por carril (también bajo React StrictMode). `createRaceStore(deps)` permite inyectar dependencias en los tests.

## Reglas del juego

Las reglas canónicas están en [`src/shared/rules.ts`](src/shared/rules.ts); el simulador, los textos enviados a los modelos, los mocks y la UI leen de ahí.

- **Movimientos relativos** al rumbo: `forward`, `left`, `right`. No hay giros en U.
- **Velocidades**: `slow` (650 ms por celda), `cruise` (420 ms), `boost` (260 ms).
- **Regla de velocidad**: `slow` es obligatorio si hay aceite en las primeras 2 celdas de la ruta o si hay que girar justo después (tramo recto ≤ 1). `boost` solo con al menos 4 celdas rectas y sin aceite en las primeras 4. En cualquier otro caso, `cruise`.
- **Mejor movimiento**: la ruta más corta hasta el siguiente checkpoint (en empate: adelante, izquierda, derecha). Los conos cierran una rama.
- **Penalizaciones**: choque (fuera de pista, sentido contrario o conos) +3 s; trompo (ir más rápido de lo permitido) +1,5 s; respuesta inválida, timeout o fallo del motor +2 s y el carro sigue en piloto automático. Timeout por defecto: 10 s.
- **Dificultad** (lo que contiene la observación):
  - `easy`: opciones con campos numéricos y distancia al checkpoint.
  - `normal`: opciones con resumen en texto y mapa local de 7×7.
  - `hard`: solo mapa ASCII egocéntrico de 11×11 y posición del checkpoint (razonamiento espacial).
- **Circuitos**: `ovalo` (sin bifurcaciones), `tecnico` (curvas y chicanes) y `bifurcaciones` (tres bifurcaciones que se vuelven a unir). En cada vuelta se regeneran el aceite y los conos a partir de la semilla.

## Métricas

| Métrica | Definición |
| --- | --- |
| **Acierto** | movimiento `optimal` **y** velocidad `correct` |
| **Error** | choque, respuesta inválida, timeout, fallo del motor o trompo (`too_fast`) |
| **Parcial** | ni acierto ni error (por ejemplo, un movimiento válido pero más largo, o una velocidad más lenta de lo necesario) |
| Precisión de movimiento, de velocidad y en bifurcaciones | % sobre las decisiones calificables |
| Latencia de decisión | media, p50, p90, p95, mín., máx. y desviación estándar (extremo a extremo y del proveedor) |
| Tiempo de carrera | movimiento + pensando + penalizaciones; % del tiempo pensando |
| Vueltas | tiempos por vuelta y mejor vuelta |
| Calibración | Brier score, ECE y diagrama de confiabilidad (confianza del movimiento vs. acierto real) |
| Respuestas inválidas | % de salidas que no se pudieron interpretar o quedaron fuera del conjunto permitido |
| Tokens y costo | tokens de entrada y salida y USD (estimado en modo SIMULADO) |
| Throughput | decisiones por minuto |

El ganador de la carrera se decide por **tiempo de carrera**; el panel «Comparación» muestra quién gana en cada métrica. Los datos se pueden exportar a JSON (métricas, comparación y todas las decisiones) o CSV (una fila por decisión).

## Diseño de equidad

El experimento solo vale si la comparación es justa:

1. **Misma observación**: ambos motores reciben exactamente el mismo objeto `Observation`.
2. **Mismo texto canónico**: las reglas y las preguntas enviadas a GPT y a Jev salen de las mismas constantes (`GAME_BRIEF`, `MOVE_QUESTION`, `SPEED_QUESTION` en `rules.ts`), en inglés para ambos.
3. **Mismo oráculo**: ambos se califican con la misma función, que usa la misma regla de velocidad (`correctSpeed`) que describe el texto.
4. **Misma pista**: mismo circuito, semilla, obstáculos y configuración en los dos carriles.
5. **Oráculo derivable**: un test demuestra que la respuesta correcta se puede deducir solo de la observación (dificultades `easy` y `normal`). Los modelos reales nunca reciben el oráculo; solo los mocks lo leen.

## Cómo agregar un circuito

1. Abre `src/sim/tracks/presets.ts` y agrega un `TrackSpec` con `id`, `name` (en español), `description`, `startHeading` y un `map` ASCII. Cada carácter es una celda:
   - `─ │ ┌ ┐ └ ┘`: rectas y curvas; `├ ┤ ┬ ┴`: bifurcaciones o uniones
   - `S`: salida y meta; `1`–`9`: checkpoints en orden de carrera
   - `.` o espacio: fuera de pista
2. Agrégalo a `TRACK_SPECS` al final del archivo.
3. Ejecuta `npm test`: `src/sim/tracks.test.ts` valida cada preset (conectividad, un solo sentido de marcha, checkpoints, tamaño y longitud de vuelta) y el parser falla con un mensaje descriptivo si el mapa es inconsistente.

La app lista los circuitos desde `TRACKS`, así que el selector lo muestra sin más cambios.
