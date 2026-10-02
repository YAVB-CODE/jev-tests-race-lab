import type { EngineId, HealthResponse } from '../shared/contracts.ts'

const FALLBACK: HealthResponse = {
  ok: true,
  engines: { gpt: { live: false, model: 'gpt' }, jev: { live: false, model: 'jev' } },
}

function fallback(): HealthResponse {
  return { ok: true, engines: { gpt: { ...FALLBACK.engines.gpt }, jev: { ...FALLBACK.engines.jev } } }
}

function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { ok?: unknown; engines?: unknown }
  if (v.ok !== true || typeof v.engines !== 'object' || v.engines === null) return false
  const engines = v.engines as Record<string, unknown>
  return (['gpt', 'jev'] as EngineId[]).every((id) => {
    const e = engines[id] as { live?: unknown; model?: unknown } | undefined
    return typeof e === 'object' && e !== null && typeof e.live === 'boolean' && typeof e.model === 'string'
  })
}

/**
 * GET /api/health. NEVER throws: when the backend is down (or answers something unexpected) it resolves
 * a response saying no engine is live, so the UI keeps working in SIMULADO mode.
 */
export async function fetchHealth(timeoutMs = 4000): Promise<HealthResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('/api/health', { signal: controller.signal })
    if (!response.ok) return fallback()
    const payload: unknown = await response.json()
    return isHealthResponse(payload) ? payload : fallback()
  } catch {
    return fallback()
  } finally {
    clearTimeout(timer)
  }
}
