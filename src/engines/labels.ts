import type { EngineId, EngineMode } from '../shared/contracts.ts'

export const ENGINE_NAMES: Record<EngineId, string> = { gpt: 'GPT', jev: 'Jev' }

/** Model shown in the label of a live engine when the caller does not know the real one (see fetchHealth). */
export const DEFAULT_LIVE_MODEL: Record<EngineId, string> = { gpt: 'gpt-4.1-mini', jev: 'jev-1.13-free' }

/** "GPT · simulado" for mocks, "GPT · gpt-4.1-mini" for live engines. */
export function engineLabel(id: EngineId, mode: EngineMode, model?: string): string {
  const name = ENGINE_NAMES[id]
  return mode === 'mock' ? `${name} · simulado` : `${name} · ${model ?? DEFAULT_LIVE_MODEL[id]}`
}
