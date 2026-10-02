import type { DecisionEngine, EngineId, EngineMode } from '../shared/contracts.ts'
import { MockEngine } from './MockEngine.ts'
import { RemoteEngine } from './RemoteEngine.ts'
import { engineLabel } from './labels.ts'
import type { DeepPartial, MockProfile } from './profiles.ts'

export interface CreateEngineOptions {
  /** Live mode only: model name shown in the label (e.g. from fetchHealth()). Ignored by mocks. */
  model?: string
  /** Mock mode only: overrides applied on top of MOCK_PROFILES[id] (nested keys may be partial). */
  profile?: DeepPartial<MockProfile>
}

/**
 * Engine factory. Labels: "GPT · simulado", "Jev · simulado", "GPT · gpt-4.1-mini", "Jev · jev-1.13-free".
 * 'mock' → MockEngine (SIMULATED, reads the oracle); 'live' → RemoteEngine (POST /api/decide).
 */
export function createEngine(id: EngineId, mode: EngineMode, opts: CreateEngineOptions = {}): DecisionEngine {
  if (mode === 'mock') return new MockEngine(id, { profile: opts.profile, label: engineLabel(id, 'mock') })
  return new RemoteEngine(id, { model: opts.model, label: engineLabel(id, 'live', opts.model) })
}

export { MockEngine, sampleLatencyMs } from './MockEngine.ts'
export type { MockEngineOptions } from './MockEngine.ts'
export { RemoteEngine } from './RemoteEngine.ts'
export type { RemoteEngineOptions } from './RemoteEngine.ts'
export { MOCK_PROFILES, mergeProfile } from './profiles.ts'
export type { ConfidenceModel, DeepPartial, MockLatencyProfile, MockProfile } from './profiles.ts'
export { fetchHealth } from './health.ts'
export { fetchModels } from './models.ts'
export { DEFAULT_LIVE_MODEL, ENGINE_NAMES, engineLabel } from './labels.ts'
