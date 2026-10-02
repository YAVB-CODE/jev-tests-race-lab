/**
 * Jev adapter — Jev "System One" model served by OpenCode Zen: `POST {OPENCODE_BASE_URL}/v1/systemone`
 * (https://opencode.ai/docs/zen), called with plain fetch.
 *
 * ── Fairness note ────────────────────────────────────────────────────────────────────────────
 * Jev and GPT receive the SAME information, only packaged in each API's native shape:
 *  - Rules: `GAME_BRIEF` verbatim (src/shared/rules.ts) → `state.game_rules`
 *    (GPT: start of its system prompt).
 *  - Situation: the Observation, JSON-serialised once (same JSON for both) → `state.observation`
 *    (GPT: the user message). State is a structured object.
 *  - Questions: ONE call, two Choice questions (answered in parallel): `move` and `speed`, with
 *    the `MOVE_QUESTION` / `SPEED_QUESTION` instructions and criteria verbatim (GPT: the same
 *    text in its system prompt, same option keys in its JSON schema).
 *  - One pointer sentence (structured instructions with backtick references to the state
 *    fields), mirroring GPT's pointer sentence. No extra game information on either side.
 * Jev's typed output needs no output-format instruction; GPT gets a short one.
 * Neither provider ever sees the oracle; the server only receives `{ engine, observation, model? }`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Mapping: move/speed = `choice`; *Probabilities = `probabilities`; moveConfidence /
 * speedConfidence = probabilities[choice] (calibration input, comparable to GPT's self-reported
 * probability); nativeMoveConfidence / nativeSpeedConfidence = Jev's `confidence` statistic.
 *
 * Retries: at most JEV_MAX_RETRIES (default 1) on 429 / 529 and connection errors, short
 * backoff, no retry on timeouts. Every HTTP attempt is logged in raw.response.attempts, and
 * providerLatencyMs covers the whole call (retries included), so retries are never silent.
 */
import {
  RELATIVE_MOVES,
  SPEED_MODES,
  type DecisionAnswer,
  type DecisionResult,
  type DecisionStatus,
  type EngineModels,
  type Observation,
  type RelativeMove,
  type SpeedMode,
  type TokenUsage,
} from '../../src/shared/contracts.ts'
import { GAME_BRIEF, MOVE_QUESTION, SPEED_QUESTION } from '../../src/shared/rules.ts'
import { OPENCODE_LABEL, OPENCODE_JEV_MODELS, type JevConfig } from '../env.ts'
import { cachedListing, jevPriceFor, orderModelIds, parseModelIds, toModelOption } from '../models.ts'
import { costUsd } from '../pricing.ts'
import {
  NULL_ANSWER,
  clamp01,
  defaultFetch,
  errorMessageOf,
  errorResult,
  instrumentFetch,
  missingKeyResult,
  redactSecrets,
  roundMs,
  toJsonValue,
  type AttemptLog,
  type DecideOptions,
  type EngineAdapter,
  type FetchLike,
} from './common.ts'

// ─────────────────────────────────── Request ───────────────────────────────────

/** Pointer sentence (GPT's counterpart: adapters/gpt.ts → GPT_CONTEXT). */
export const JEV_CONTEXT = 'The rules are in `game_rules`; the current situation is in `observation`.'

/** HTTP statuses worth one quick retry: rate limit and "overloaded". */
export const JEV_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 529])
const BACKOFF_INITIAL_MS = 200
const BACKOFF_MAX_MS = 1000
/** A longer Retry-After falls back to the short backoff instead of stalling the car. */
const MAX_RETRY_AFTER_MS = 2000

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface JevChoiceQuestion {
  type: 'choice'
  instructions: { question: string; context: string }
  criteria: Record<string, string>
}

export interface JevRequest {
  model: string
  state: { game_rules: string; observation: JsonValue }
  questions: { move: JevChoiceQuestion; speed: JevChoiceQuestion }
}

function choiceQuestion(question: string, criteria: Record<string, string>): JevChoiceQuestion {
  return { type: 'choice', instructions: { question, context: JEV_CONTEXT }, criteria: { ...criteria } }
}

export function buildJevQuestions(): JevRequest['questions'] {
  return {
    move: choiceQuestion(MOVE_QUESTION.instructions, MOVE_QUESTION.criteria),
    speed: choiceQuestion(SPEED_QUESTION.instructions, SPEED_QUESTION.criteria),
  }
}

export function buildJevRequest(observation: Observation, model: string): JevRequest {
  return {
    model,
    state: {
      game_rules: GAME_BRIEF,
      observation: toJsonValue<JsonValue>(observation),
    },
    questions: buildJevQuestions(),
  }
}

// ─────────────────────────────────── Mapping ───────────────────────────────────

export interface MappedJev {
  status: Extract<DecisionStatus, 'ok' | 'invalid'>
  answer: DecisionAnswer
  errorMessage?: string
}

interface MappedChoice<T extends string> {
  choice: T
  probabilities: Partial<Record<T, number>>
  /** probabilities[choice] */
  probability?: number
  /** Jev's native `confidence` statistic. */
  confidence?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mapChoice<T extends string>(
  name: string,
  raw: unknown,
  options: readonly T[],
): { ok: true; value: MappedChoice<T> } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `Missing "${name}" answer` }
  if (raw.type !== undefined && raw.type !== 'choice') return { ok: false, error: `"${name}" answer has type ${String(raw.type)}` }
  if (typeof raw.choice !== 'string') return { ok: false, error: `"${name}" answer has no choice` }
  if (!(options as readonly string[]).includes(raw.choice)) {
    return { ok: false, error: `"${name}" out of set: ${raw.choice.slice(0, 60)}` }
  }
  const picked = raw.choice as T
  const probabilities: Partial<Record<T, number>> = {}
  if (isRecord(raw.probabilities)) {
    for (const option of options) {
      const p = clamp01(raw.probabilities[option])
      if (p !== undefined) probabilities[option] = p
    }
  }
  return {
    ok: true,
    value: { choice: picked, probabilities, probability: probabilities[picked], confidence: clamp01(raw.confidence) },
  }
}

/** Maps a /v1/systemone response body to a DecisionAnswer. Defensive: input is untrusted JSON. */
export function mapJevAnswers(result: unknown): MappedJev {
  const answers = isRecord(result) && isRecord(result.answers) ? result.answers : undefined
  if (!answers) return { status: 'invalid', answer: { ...NULL_ANSWER }, errorMessage: 'Response has no answers' }
  const move = mapChoice<RelativeMove>('move', answers.move, RELATIVE_MOVES)
  if (!move.ok) return { status: 'invalid', answer: { ...NULL_ANSWER }, errorMessage: move.error }
  const speed = mapChoice<SpeedMode>('speed', answers.speed, SPEED_MODES)
  if (!speed.ok) return { status: 'invalid', answer: { ...NULL_ANSWER }, errorMessage: speed.error }

  const answer: DecisionAnswer = {
    move: move.value.choice,
    speed: speed.value.choice,
    moveProbabilities: move.value.probabilities,
    speedProbabilities: speed.value.probabilities,
  }
  if (move.value.probability !== undefined) answer.moveConfidence = move.value.probability
  if (speed.value.probability !== undefined) answer.speedConfidence = speed.value.probability
  if (move.value.confidence !== undefined) answer.nativeMoveConfidence = move.value.confidence
  if (speed.value.confidence !== undefined) answer.nativeSpeedConfidence = speed.value.confidence
  return { status: 'ok', answer }
}

function usageOf(result: unknown): TokenUsage | undefined {
  const usage = isRecord(result) && isRecord(result.usage) ? result.usage : undefined
  if (!usage) return undefined
  const input = Number(usage.input_tokens)
  const output = Number(usage.output_tokens)
  if (!Number.isFinite(input)) return undefined
  return { inputTokens: input, outputTokens: Number.isFinite(output) ? output : 0 }
}

// ─────────────────────────────────── Errors ───────────────────────────────────

const ERROR_PREFIX = 'OpenCode Zen (Jev)'

/** Failure of one call, already described for the UI. `status`/`body` are kept for raw.response. */
export class JevCallError extends Error {
  readonly status: number | null
  readonly body: unknown
  constructor(message: string, status: number | null = null, body: unknown = undefined) {
    super(message)
    this.name = 'JevCallError'
    this.status = status
    this.body = body
  }
}

/** FastAPI-style `{ detail: [{ loc, msg }] }` → "questions.move.criteria: field required"; plain `detail` strings as-is. */
export function describeDetail(body: unknown): string {
  const detail = isRecord(body) ? body.detail ?? body.error ?? body.message : body
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (!isRecord(d)) return String(d)
        const loc = Array.isArray(d.loc) ? d.loc.filter((part) => part !== 'body').join('.') : ''
        const msg = typeof d.msg === 'string' ? d.msg : JSON.stringify(d)
        return loc ? `${loc}: ${msg}` : msg
      })
      .join('; ')
  }
  if (isRecord(detail) && typeof detail.message === 'string') return detail.message
  return detail === undefined ? '' : JSON.stringify(detail)
}

export function describeHttpError(status: number, body: unknown, attempts: number): string {
  const tries = attempts > 1 ? ` (after ${attempts} attempts)` : ''
  if (status === 401) return `${ERROR_PREFIX} 401: missing or invalid API key (OPENCODE_API_KEY)`
  if (status === 422) return `${ERROR_PREFIX} 422: request rejected: ${describeDetail(body)}`
  if (status === 429) return `${ERROR_PREFIX} 429: rate limit exceeded${tries}`
  if (status === 529) return `${ERROR_PREFIX} 529: overloaded${tries}`
  const detail = describeDetail(body)
  return `${ERROR_PREFIX} ${status}${tries}${detail ? `: ${detail}` : ''}`
}

/** ms to wait before a retry: Retry-After(-ms) when short enough, otherwise exponential backoff with jitter. */
function retryDelayMs(response: Response | null, retry: number): number {
  const ms = Number(response?.headers.get('retry-after-ms'))
  if (Number.isFinite(ms) && ms >= 0 && ms <= MAX_RETRY_AFTER_MS) return ms
  const seconds = Number(response?.headers.get('retry-after'))
  if (Number.isFinite(seconds) && seconds >= 0 && seconds * 1000 <= MAX_RETRY_AFTER_MS) return seconds * 1000
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** (retry - 1))
  return base * (0.75 + Math.random() * 0.5)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true })
  })
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return text.slice(0, 300)
  }
}

// ─────────────────────────────────── Adapter ───────────────────────────────────

export interface JevAdapterDeps {
  fetch?: FetchLike
}

export function createJevAdapter(cfg: JevConfig, deps: JevAdapterDeps = {}): EngineAdapter {
  const live = Boolean(cfg.apiKey)
  const provider = OPENCODE_LABEL
  const fetchImpl = deps.fetch ?? defaultFetch
  const clean = (text: string) => redactSecrets(text, [cfg.apiKey])

  /**
   * One /v1/systemone call with retries. Resolves the parsed JSON body; throws JevCallError with a
   * UI-ready message. Each attempt gets its own timeout; the caller's signal aborts everything.
   */
  async function callSystemOne(
    request: JevRequest,
    signal: AbortSignal | undefined,
    attempts: AttemptLog[],
  ): Promise<{ data: unknown; requestId: string | null }> {
    const instrumented = instrumentFetch(fetchImpl, attempts)
    for (let retry = 0; ; retry++) {
      if (signal?.aborted) throw new JevCallError(`${ERROR_PREFIX} request aborted (client disconnected or timed out)`)
      const timeout = AbortSignal.timeout(cfg.timeoutMs)
      let response: Response
      try {
        response = await instrumented(`${cfg.baseURL}/v1/systemone`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(request),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      } catch (error) {
        if (signal?.aborted) throw new JevCallError(`${ERROR_PREFIX} request aborted (client disconnected or timed out)`)
        if (timeout.aborted) throw new JevCallError(`${ERROR_PREFIX} timeout after ${cfg.timeoutMs} ms`)
        if (retry < cfg.maxRetries) {
          await sleep(retryDelayMs(null, retry + 1), signal).catch(() => undefined)
          continue
        }
        const tries = attempts.length > 1 ? ` (after ${attempts.length} attempts)` : ''
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
        throw new JevCallError(`${ERROR_PREFIX} network error${tries}: ${clean(errorMessageOf(cause))}`)
      }

      if (response.ok) {
        const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
        return { data: await readJson(response), requestId }
      }
      const body = await readJson(response)
      if (JEV_RETRY_STATUSES.has(response.status) && retry < cfg.maxRetries) {
        await sleep(retryDelayMs(response, retry + 1), signal).catch(() => undefined)
        continue
      }
      throw new JevCallError(clean(describeHttpError(response.status, body, attempts.length)), response.status, body)
    }
  }

  async function decide(observation: Observation, options: DecideOptions = {}): Promise<DecisionResult> {
    const model = options.model ?? cfg.model
    if (!cfg.apiKey) return missingKeyResult('jev', model, 'OPENCODE_API_KEY')

    const price = jevPriceFor(model, cfg)
    const request = buildJevRequest(observation, model)
    const rawRequest = {
      ...request,
      options: {
        endpoint: `${cfg.baseURL}/v1/systemone`,
        timeoutMs: cfg.timeoutMs,
        retry: { maxRetries: cfg.maxRetries, httpStatuses: [...JEV_RETRY_STATUSES], backoffMs: [BACKOFF_INITIAL_MS, BACKOFF_MAX_MS] },
      },
    }
    const attempts: AttemptLog[] = []

    const started = performance.now()
    let data: unknown
    let requestId: string | null
    try {
      ;({ data, requestId } = await callSystemOne(request, options.signal, attempts))
    } catch (error) {
      const failure = error instanceof JevCallError ? error : new JevCallError(`${ERROR_PREFIX} error: ${clean(errorMessageOf(error))}`)
      return errorResult('jev', model, failure.message, {
        providerLatencyMs: roundMs(performance.now() - started),
        raw: {
          request: rawRequest,
          response: {
            attempts,
            ...(failure.status !== null ? { status: failure.status, body: clean(JSON.stringify(failure.body) ?? '') } : {}),
          },
        },
      })
    }
    const providerLatencyMs = roundMs(performance.now() - started)

    const mapped = mapJevAnswers(data)
    const usage = usageOf(data)
    const body = isRecord(data) ? data : {}
    const result: DecisionResult = {
      engine: 'jev',
      mode: 'live',
      model: typeof body.model === 'string' && body.model ? body.model : model,
      status: mapped.status,
      answer: mapped.answer,
      providerLatencyMs,
      raw: {
        request: rawRequest,
        response: {
          model: body.model ?? null,
          answers: body.answers ?? null,
          usage: body.usage ?? null,
          requestId,
          attempts,
          pricing: { ...price.prices, source: price.source },
        },
      },
    }
    if (mapped.errorMessage) result.errorMessage = mapped.errorMessage
    if (usage) {
      result.usage = usage
      result.costUsd = costUsd(usage, price.prices)
    }
    return result
  }

  const option = (id: string) => toModelOption(id, jevPriceFor(id, cfg))
  const fallback = (error?: string): EngineModels => ({
    default: cfg.model,
    provider,
    models: orderModelIds(OPENCODE_JEV_MODELS, cfg.model).map(option),
    source: 'fallback',
    ...(error ? { error } : {}),
  })

  // Zen's catalogue (`{ data: [{ id }] }`) lists every Zen model: keep the jev* ones.
  const listModels = cachedListing(async () => {
    if (!cfg.apiKey) return fallback()
    try {
      const response = await fetchImpl(`${cfg.baseURL}/v1/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(cfg.timeoutMs),
      })
      if (!response.ok) return fallback(`${ERROR_PREFIX} GET /v1/models → HTTP ${response.status}`)
      const ids = parseModelIds(await response.json()).filter((id) => id.startsWith('jev'))
      if (ids.length === 0) return fallback('OpenCode Zen listed no Jev models')
      return { default: cfg.model, provider, models: orderModelIds(ids, cfg.model).map(option), source: 'provider' }
    } catch (error) {
      return fallback(`${ERROR_PREFIX} GET /v1/models failed: ${clean(errorMessageOf(error))}`)
    }
  })

  return { engine: 'jev', live, model: cfg.model, provider, decide, listModels }
}
