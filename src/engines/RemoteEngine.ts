/**
 * RemoteEngine — calls the real models through the backend proxy (POST /api/decide).
 *
 * Fairness / leakage rule: the request body is exactly `{ engine, observation }` (+ `model` when the lane
 * picked one in the UI). The oracle in `ctx.oracle` (or anything derived from it) is NEVER sent.
 */
import type {
  DecideRequest,
  DecisionEngine,
  DecisionResult,
  EngineContext,
  EngineId,
  Observation,
} from '../shared/contracts.ts'
import { createAbortError, isAbortError } from './abort.ts'
import { DEFAULT_LIVE_MODEL, engineLabel } from './labels.ts'

export interface RemoteEngineOptions {
  /** Model picked in the UI: sent with every request and used for the label. Omitted → the server default. */
  model?: string
  label?: string
  /** Defaults to '/api/decide'. */
  endpoint?: string
}

const STATUSES = new Set(['ok', 'invalid', 'error', 'timeout'])

function looksLikeDecisionResult(value: unknown): value is DecisionResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { status?: unknown; answer?: unknown }
  return typeof v.status === 'string' && STATUSES.has(v.status) && typeof v.answer === 'object' && v.answer !== null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class RemoteEngine implements DecisionEngine {
  readonly id: EngineId
  readonly mode = 'live' as const
  readonly label: string
  readonly model: string
  /** Only an explicitly chosen model is sent; otherwise the server applies its .env default. */
  private readonly requestModel: string | undefined
  private readonly endpoint: string

  constructor(id: EngineId, options: RemoteEngineOptions = {}) {
    this.id = id
    this.model = options.model ?? DEFAULT_LIVE_MODEL[id]
    this.requestModel = options.model
    this.label = options.label ?? engineLabel(id, 'live', this.model)
    this.endpoint = options.endpoint ?? '/api/decide'
  }

  async decide(observation: Observation, ctx: EngineContext): Promise<DecisionResult> {
    // Only the observation leaves the browser. Do not add ctx.oracle here.
    const body: DecideRequest = { engine: this.id, observation }
    if (this.requestModel) body.model = this.requestModel
    const signal = ctx.signal
    if (signal.aborted) throw createAbortError()

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200)
        return this.errorResult(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${detail ? `: ${detail}` : ''}`)
      }
      const payload: unknown = await response.json()
      if (!looksLikeDecisionResult(payload)) return this.errorResult('Malformed response from /api/decide')
      return payload
    } catch (error) {
      // Aborts (runner timeout / race abort) are not engine errors: let the runner classify them.
      if (signal.aborted || isAbortError(error)) throw isAbortError(error) ? error : createAbortError()
      return this.errorResult(`Network error: ${errorText(error)}`)
    }
  }

  private errorResult(errorMessage: string): DecisionResult {
    return {
      engine: this.id,
      mode: 'live',
      model: this.model,
      status: 'error',
      answer: { move: null, speed: null },
      errorMessage,
    }
  }
}
