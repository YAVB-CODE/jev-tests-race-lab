import { useEffect, useMemo } from 'react'
import { MetricsDemo, SIMULATED_DISCLAIMER } from './components/metrics/index.ts'
import { TrackViewDemo } from './components/track/index.ts'
import { ControlBar } from './app/ControlBar.tsx'
import { FinishBanner } from './app/FinishBanner.tsx'
import { Header } from './app/Header.tsx'
import { HowItWorks } from './app/HowItWorks.tsx'
import { LanePanel } from './app/LanePanel.tsx'
import { RaceBar } from './app/RaceBar.tsx'
import { ResultTabs } from './app/ResultTabs.tsx'
import { parseQuery } from './app/query.ts'
import type { AppQuery } from './app/query.ts'
import { ENGINE_IDS, raceStore, useRaceStore } from './app/store.ts'

const HEALTH_REFRESH_MS = 5000

/** Query switches (?autostart, ?track…) are applied once per page load, even under StrictMode's double effects. */
let bootstrapped = false

function bootstrap(query: AppQuery): void {
  if (bootstrapped) return
  bootstrapped = true
  void raceStore.store
    .getState()
    .init()
    .then(() => {
      const state = raceStore.store.getState()
      if (Object.keys(query.config).length > 0) state.setConfig(query.config)
      if (query.autostart) raceStore.store.getState().start()
    })
}

/** Shown whenever any lane runs on a mock engine: simulated results are not a measurement. */
function SimulatedBanner() {
  const gpt = useRaceStore((s) => s.lanes.gpt.mode)
  const jev = useRaceStore((s) => s.lanes.jev.mode)
  if (gpt === 'live' && jev === 'live') return null
  const mixed = gpt !== jev
  return (
    <div role="note" className="flex items-start gap-2.5 rounded-xl border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm text-warn">
      <span aria-hidden className="mt-px font-bold">
        !
      </span>
      <p className="min-w-0">
        <span className="font-medium">{SIMULATED_DISCLAIMER}</span>
        {mixed && <span className="text-warn/80"> Un carril es SIMULADO y el otro LIVE: la comparación no es válida.</span>}
      </p>
    </div>
  )
}

function RaceApp({ query }: { query: AppQuery }) {
  const ready = useRaceStore((s) => s.ready)

  useEffect(() => {
    bootstrap(query)
  }, [query])

  // The API hot-reloads .env (keys, JEV_MODEL, OPENAI_MODEL…): keep the chips and lane labels in sync.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void raceStore.store.getState().refreshHealth()
    }
    const timer = window.setInterval(refresh, HEALTH_REFRESH_MS)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  return (
    <div className="min-h-full bg-surface text-ink">
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-4 px-3 py-4 sm:px-5 sm:py-5">
        <Header />
        {ready ? (
          <>
            <SimulatedBanner />
            <HowItWorks />
            <ControlBar />
            <RaceBar />
            <FinishBanner />
            <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              {ENGINE_IDS.map((id) => (
                <LanePanel key={id} engine={id} />
              ))}
            </div>
            <ResultTabs />
            <footer className="pb-2 text-center text-[11px] text-ink-faint">
              Jev Race Lab · Jev vía{' '}
              <a className="underline decoration-ink-faint/60 underline-offset-2 hover:text-ink-dim" href="https://opencode.ai/docs/zen" target="_blank" rel="noreferrer">
                OpenCode Zen
              </a>{' '}
              · solo el modo LIVE mide la eficacia real
            </footer>
          </>
        ) : (
          <p className="py-20 text-center text-sm text-ink-dim">Preparando la pista…</p>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const query = useMemo(() => parseQuery(window.location.search), [])
  // Dev / QA pages
  if (query.demo === 'track') return <TrackViewDemo />
  if (query.demo === 'metrics') return <MetricsDemo />
  return <RaceApp query={query} />
}
