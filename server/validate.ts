/**
 * POST /api/decide body validation.
 *
 * The observation is reduced to the top-level keys of the frozen `Observation` contract, so
 * nothing else the client might send (e.g. oracle data by mistake) can reach either provider.
 * Both providers receive this same sanitised object.
 */
import type { DecideRequest, EngineId, Observation } from '../src/shared/contracts.ts'

export const ENGINE_IDS: readonly EngineId[] = ['gpt', 'jev']

/** Record (not array) so the compiler flags any key added to / removed from `Observation`. */
const OBSERVATION_KEYS: Record<keyof Observation, true> = {
  decisionIndex: true,
  lap: true,
  totalLaps: true,
  heading: true,
  currentSpeed: true,
  difficulty: true,
  options: true,
  localMap: true,
  nextCheckpoint: true,
}

/** Model ids look like gpt-4.1-mini, o4-mini, jev-1.13-free, openai/gpt-5 … (no spaces or control characters). */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/

export type ParseResult = { ok: true; value: DecideRequest } | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sanitizeObservation(observation: Record<string, unknown>): Observation {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(OBSERVATION_KEYS)) {
    if (observation[key] !== undefined) out[key] = observation[key]
  }
  return out as unknown as Observation
}

export function parseDecideRequest(body: unknown): ParseResult {
  if (!isPlainObject(body)) return { ok: false, error: 'Body must be a JSON object: { engine, observation }' }
  const { engine, observation } = body
  if (typeof engine !== 'string' || !(ENGINE_IDS as readonly string[]).includes(engine)) {
    return { ok: false, error: `"engine" must be one of: ${ENGINE_IDS.join(', ')}` }
  }
  if (!isPlainObject(observation)) return { ok: false, error: '"observation" must be a JSON object' }
  const { model } = body
  if (model !== undefined && (typeof model !== 'string' || !MODEL_ID.test(model))) {
    return { ok: false, error: '"model" must be a model id such as "gpt-4.1-mini" or "jev-1.13"' }
  }
  const value: DecideRequest = { engine: engine as EngineId, observation: sanitizeObservation(observation) }
  if (model !== undefined) value.model = model
  return { ok: true, value }
}
