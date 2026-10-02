/**
 * Shared adapter plumbing: the adapter interface, an instrumented fetch that records every HTTP
 * attempt (so SDK retries never distort latency silently), secret redaction and result helpers.
 */
import type { DecisionAnswer, DecisionResult, EngineId, EngineModels, Observation } from '../../src/shared/contracts.ts'

export interface DecideOptions {
  /** Aborted when the browser request closes (runner timeout / race abort). */
  signal?: AbortSignal
  /** Model picked in the UI for this lane; the adapter's configured default when omitted. */
  model?: string
}

export interface EngineAdapter {
  readonly engine: EngineId
  /** true when the API key is configured. */
  readonly live: boolean
  /** Configured model name (the response may report a more specific versioned id). */
  readonly model: string
  /** Gateway serving the model, for display (e.g. 'OpenAI', 'OpenCode Zen'). */
  readonly provider?: string
  /** Never throws: every failure is mapped to a DecisionResult with status 'invalid' | 'error'. */
  decide(observation: Observation, options?: DecideOptions): Promise<DecisionResult>
  /** Models selectable in the UI (cached; `force` re-lists). Never throws: falls back to a built-in list. */
  listModels(force?: boolean): Promise<EngineModels>
}

export type Adapters = Record<EngineId, EngineAdapter>

/** Compatible with the global fetch and OpenAI's `Fetch`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface AttemptLog {
  /** 1-based HTTP attempt number (1 = first try, 2 = first retry, ...). */
  attempt: number
  /** HTTP status, or null when the attempt failed before a response (network / abort / timeout). */
  status: number | null
  /** Time to response headers for this attempt, in ms. */
  ms: number
  error?: string
}

export const NULL_ANSWER: DecisionAnswer = Object.freeze({ move: null, speed: null }) as DecisionAnswer

export function roundMs(ms: number): number {
  return Math.round(ms)
}

export function clamp01(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/** Wraps fetch so every HTTP attempt made by an SDK (including its retries) is logged. */
export function instrumentFetch(base: FetchLike, log: AttemptLog[]): FetchLike {
  return async (input, init) => {
    const attempt = log.length + 1
    const started = performance.now()
    try {
      const response = await base(input, init)
      log.push({ attempt, status: response.status, ms: roundMs(performance.now() - started) })
      return response
    } catch (error) {
      const aborted = init?.signal?.aborted === true
      log.push({
        attempt,
        status: null,
        ms: roundMs(performance.now() - started),
        error: aborted ? 'aborted' : error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_*.-]{6,}/g,
  /\bBearer\s+[^\s"',]+/gi,
  /\b(api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',]+/gi,
]

/** Removes API keys (the configured ones and anything that looks like one) from text sent to the browser. */
export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('***')
  }
  out = out
    .replace(SECRET_PATTERNS[0], 'sk-***')
    .replace(SECRET_PATTERNS[1], 'Bearer ***')
    .replace(SECRET_PATTERNS[2], (_m, name: string, sep: string) => `${name}${sep}***`)
  return out.length > 400 ? `${out.slice(0, 400)}…` : out
}

/** SDK errors read "429 Rate limit…"; we prefix the status ourselves, so drop theirs. */
export function withoutStatusPrefix(message: string, status: number | undefined): string {
  return status !== undefined && message.startsWith(`${status} `) ? message.slice(String(status).length + 1) : message
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown error'
}

export function errorResult(
  engine: EngineId,
  model: string,
  errorMessage: string,
  extra: Partial<DecisionResult> = {},
): DecisionResult {
  return { engine, mode: 'live', model, status: 'error', answer: { ...NULL_ANSWER }, errorMessage, ...extra }
}

export function missingKeyResult(engine: EngineId, model: string, envVar: string): DecisionResult {
  return errorResult(
    engine,
    model,
    `${envVar} no está configurada en el servidor (.env): usa el modo SIMULADO o agrega la key. / ${envVar} is not set on the server.`,
  )
}

/** JSON round-trip: the exact value both providers receive (drops undefined, same as JSON.stringify). */
export function toJsonValue<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T
}
