import type { EngineId, ModelsResponse } from '../shared/contracts.ts'

function isModelsResponse(value: unknown): value is ModelsResponse {
  if (typeof value !== 'object' || value === null) return false
  const engines = (value as { engines?: unknown }).engines
  if (typeof engines !== 'object' || engines === null) return false
  return (['gpt', 'jev'] as EngineId[]).every((id) => {
    const e = (engines as Record<string, unknown>)[id] as { default?: unknown; models?: unknown } | undefined
    return typeof e === 'object' && e !== null && typeof e.default === 'string' && Array.isArray(e.models)
  })
}

/**
 * GET /api/models (the server caches the provider listings; `force` re-lists them). NEVER throws:
 * resolves null when the backend is down or answers something unexpected (the UI then hides the picker).
 * Listing OpenAI's catalogue can take a few seconds, hence the longer default timeout.
 */
export async function fetchModels(force = false, timeoutMs = 15_000): Promise<ModelsResponse | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(force ? '/api/models?refresh=1' : '/api/models', { signal: controller.signal })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    return isModelsResponse(payload) ? payload : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
