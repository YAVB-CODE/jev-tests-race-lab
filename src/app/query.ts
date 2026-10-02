/**
 * URL switches for dev / QA:
 *  ?demo=track | metrics      renders the standalone demo pages
 *  ?autostart=1               starts the race as soon as the app is ready
 *  ?track=ovalo&laps=1&seed=7&difficulty=hard&timeout=5   preloads the race config
 */
import type { Difficulty, RaceConfig } from '../shared/contracts.ts'

export type DemoRoute = 'track' | 'metrics'

export interface AppQuery {
  demo: DemoRoute | null
  autostart: boolean
  config: Partial<RaceConfig>
}

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard']

function num(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function parseQuery(search: string): AppQuery {
  const q = new URLSearchParams(search)
  const demo = q.get('demo')
  const config: Partial<RaceConfig> = {}
  const track = q.get('track')
  if (track) config.trackId = track
  const laps = num(q.get('laps'))
  if (laps !== undefined) config.laps = laps
  const seed = num(q.get('seed'))
  if (seed !== undefined) config.seed = seed
  const difficulty = q.get('difficulty')
  if (difficulty && (DIFFICULTIES as readonly string[]).includes(difficulty)) config.difficulty = difficulty as Difficulty
  const timeout = num(q.get('timeout'))
  if (timeout !== undefined) config.decisionTimeoutMs = timeout * 1000
  const autostart = q.get('autostart')
  return {
    demo: demo === 'track' || demo === 'metrics' ? demo : null,
    autostart: autostart !== null && autostart !== '0' && autostart !== 'false',
    config,
  }
}
