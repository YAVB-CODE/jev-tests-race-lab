/**
 * GPT adapter — OpenAI Chat Completions with Structured Outputs (strict JSON schema).
 *
 * ── Fairness note ────────────────────────────────────────────────────────────────────────────
 * GPT and Jev receive the SAME information, only packaged in each API's native shape:
 *  - Rules: `GAME_BRIEF` verbatim (src/shared/rules.ts). GPT: start of the system prompt.
 *    Jev: `state.game_rules`.
 *  - Questions: `MOVE_QUESTION` / `SPEED_QUESTION` instructions + every option's criteria, verbatim.
 *    GPT: listed in the system prompt. Jev: two Choice questions (same text, same option keys).
 *  - Situation: the Observation, JSON-serialised once (same JSON for both). GPT: the user message.
 *    Jev: `state.observation`.
 *  - One pointer sentence each, telling where rules and situation are (no game information).
 *  - GPT also gets a short output-format sentence (an LLM needs one; Jev's output is typed by the
 *    API). It asks for self-reported probabilities, which are what Jev returns natively.
 * Neither provider ever sees the oracle; the server only receives `{ engine, observation }`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Model families: reasoning models (gpt-5*, o1/o3/o4*) get no `temperature`, a larger
 * `max_completion_tokens` budget (reasoning tokens count) and optional `reasoning_effort`;
 * other models get temperature 0. Every HTTP attempt is logged in raw.response.attempts.
 */
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from 'openai'
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions'
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
import type { GptConfig } from '../env.ts'
import { GPT_FALLBACK_MODELS, cachedListing, gptPriceFor, isChatGptModel, orderModelIds, toModelOption } from '../models.ts'
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
  withoutStatusPrefix,
  type AttemptLog,
  type DecideOptions,
  type EngineAdapter,
  type FetchLike,
} from './common.ts'

// ─────────────────────────────────── Prompt ───────────────────────────────────

function optionLines(criteria: Record<string, string>): string {
  return Object.entries(criteria)
    .map(([option, description]) => `- "${option}": ${description}`)
    .join('\n')
}

/** Pointer sentence (Jev's counterpart lives in adapters/jev.ts → JEV_CONTEXT). */
export const GPT_CONTEXT = 'The rules are above; the current situation is the observation JSON in the user message.'

export const GPT_OUTPUT_INSTRUCTION =
  'Reply only with JSON matching the schema: "move" and "speed" are your answers; "move_confidence" and "speed_confidence" are your probabilities, from 0 to 1, that each answer is correct.'

export const GPT_SYSTEM_PROMPT = [
  GAME_BRIEF,
  '',
  `Answer two questions. ${GPT_CONTEXT}`,
  '',
  `Question "move": ${MOVE_QUESTION.instructions}`,
  'Options:',
  optionLines(MOVE_QUESTION.criteria),
  '',
  `Question "speed": ${SPEED_QUESTION.instructions}`,
  'Options:',
  optionLines(SPEED_QUESTION.criteria),
  '',
  GPT_OUTPUT_INSTRUCTION,
].join('\n')

export const GPT_SCHEMA_NAME = 'race_decision'

export const GPT_SCHEMA = {
  type: 'object',
  properties: {
    move: { type: 'string', enum: [...RELATIVE_MOVES], description: 'Answer to the "move" question.' },
    speed: { type: 'string', enum: [...SPEED_MODES], description: 'Answer to the "speed" question.' },
    move_confidence: {
      type: 'number',
      description: 'Probability from 0 to 1 that the chosen move is correct.',
    },
    speed_confidence: {
      type: 'number',
      description: 'Probability from 0 to 1 that the chosen speed is correct.',
    },
  },
  required: ['move', 'speed', 'move_confidence', 'speed_confidence'],
  additionalProperties: false,
} as const

// ───────────────────────────────── Model family ─────────────────────────────────

export interface GptModelProfile {
  /** Reasoning model: uses max_completion_tokens budget for hidden reasoning, accepts reasoning_effort. */
  reasoning: boolean
  /** gpt-5* and o-series reject a non-default temperature. */
  omitTemperature: boolean
  /** Reasoning models take instructions in the `developer` role. */
  instructionRole: 'system' | 'developer'
  defaultMaxCompletionTokens: number
}

export function gptModelProfile(model: string): GptModelProfile {
  const m = model.trim().toLowerCase().replace(/^openai\//, '')
  const oSeries = /^o\d/.test(m)
  const gpt5 = /^gpt-[56]/.test(m) // gpt-5.x and gpt-6.x share the reasoning-model API surface
  const chatVariant = /-chat/.test(m)
  const reasoning = oSeries || (gpt5 && !chatVariant)
  return {
    reasoning,
    omitTemperature: oSeries || gpt5,
    instructionRole: reasoning ? 'developer' : 'system',
    defaultMaxCompletionTokens: reasoning ? 4096 : 256,
  }
}

export function buildGptRequest(
  observation: Observation,
  cfg: Pick<GptConfig, 'model' | 'reasoningEffort' | 'maxCompletionTokens'>,
): ChatCompletionCreateParamsNonStreaming {
  const profile = gptModelProfile(cfg.model)
  const params: ChatCompletionCreateParamsNonStreaming = {
    model: cfg.model,
    messages: [
      { role: profile.instructionRole, content: GPT_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(observation) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: GPT_SCHEMA_NAME, strict: true, schema: GPT_SCHEMA },
    },
    max_completion_tokens: cfg.maxCompletionTokens ?? profile.defaultMaxCompletionTokens,
  }
  if (!profile.omitTemperature) params.temperature = 0
  if (profile.reasoning && cfg.reasoningEffort) params.reasoning_effort = cfg.reasoningEffort
  return params
}

// ─────────────────────────────────── Parsing ───────────────────────────────────

export interface ParsedGpt {
  status: Extract<DecisionStatus, 'ok' | 'invalid'>
  answer: DecisionAnswer
  errorMessage?: string
  /** The JSON object the model produced, when it parsed (for the decision log). */
  parsed?: unknown
}

function invalid(errorMessage: string, parsed?: unknown): ParsedGpt {
  return { status: 'invalid', answer: { ...NULL_ANSWER }, errorMessage, parsed }
}

function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  return fenced ? fenced[1] : text
}

function quote(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text ?? String(value)).slice(0, 60)
}

/**
 * Parses the assistant message into a DecisionAnswer. Out-of-enum values are NOT normalised
 * (no case folding): a value outside the set is a type error, which is part of what we measure.
 */
export function parseGptContent(
  content: string | null | undefined,
  refusal?: string | null,
  finishReason?: string | null,
): ParsedGpt {
  if (refusal && refusal.trim()) return invalid(`Model refused: ${refusal.trim().slice(0, 200)}`)
  const text = stripCodeFence((content ?? '').trim())
  if (!text) {
    if (finishReason === 'length') return invalid('Empty output: max_completion_tokens exhausted (finish_reason=length)')
    if (finishReason === 'content_filter') return invalid('Empty output: blocked by content filter')
    return invalid('Empty output from model')
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    const truncated = finishReason === 'length' ? ' (truncated: finish_reason=length)' : ''
    return invalid(`Malformed JSON${truncated}: ${text.slice(0, 80)}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return invalid('Output is not a JSON object', data)
  }
  const obj = data as Record<string, unknown>
  if (!(RELATIVE_MOVES as readonly unknown[]).includes(obj.move)) {
    return invalid(`"move" out of set: ${quote(obj.move)}`, data)
  }
  if (!(SPEED_MODES as readonly unknown[]).includes(obj.speed)) {
    return invalid(`"speed" out of set: ${quote(obj.speed)}`, data)
  }
  const answer: DecisionAnswer = { move: obj.move as RelativeMove, speed: obj.speed as SpeedMode }
  const moveConfidence = clamp01(obj.move_confidence)
  const speedConfidence = clamp01(obj.speed_confidence)
  if (moveConfidence !== undefined) answer.moveConfidence = moveConfidence
  if (speedConfidence !== undefined) answer.speedConfidence = speedConfidence
  return { status: 'ok', answer, parsed: data }
}

// ─────────────────────────────────── Errors ───────────────────────────────────

export function describeGptError(error: unknown, timeoutMs: number, secrets: Array<string | undefined>): string {
  const clean = (text: string) => redactSecrets(text, secrets)
  if (error instanceof APIUserAbortError) return 'OpenAI request aborted (client disconnected or timed out)'
  if (error instanceof APIConnectionTimeoutError) return `OpenAI timeout after ${timeoutMs} ms`
  if (error instanceof APIConnectionError) return `OpenAI network error: ${clean(errorMessageOf(error.cause ?? error))}`
  if (error instanceof AuthenticationError) return 'OpenAI 401: invalid or revoked API key (OPENAI_API_KEY)'
  const detail = error instanceof APIError ? clean(withoutStatusPrefix(error.message, error.status)) : ''
  if (error instanceof PermissionDeniedError) return `OpenAI 403: ${detail}`
  if (error instanceof NotFoundError) return `OpenAI 404 (model not found or no access?): ${detail}`
  if (error instanceof RateLimitError) return `OpenAI 429 rate limit / quota: ${detail}`
  if (error instanceof APIError) return `OpenAI ${error.status ?? 'error'}: ${detail}`
  return `OpenAI error: ${clean(errorMessageOf(error))}`
}

// ─────────────────────────────────── Adapter ───────────────────────────────────

export interface GptAdapterDeps {
  fetch?: FetchLike
}

function usageOf(completion: ChatCompletion): TokenUsage | undefined {
  const u = completion.usage
  if (!u) return undefined
  return { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 }
}

export function createGptAdapter(cfg: GptConfig, deps: GptAdapterDeps = {}): EngineAdapter {
  const live = Boolean(cfg.apiKey)
  const provider = cfg.baseURL ? hostOf(cfg.baseURL) : 'OpenAI'

  const newClient = (attempts?: AttemptLog[]) =>
    new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      timeout: cfg.timeoutMs,
      maxRetries: cfg.maxRetries,
      fetch: attempts ? instrumentFetch(deps.fetch ?? defaultFetch, attempts) : (deps.fetch ?? defaultFetch),
    })

  async function decide(observation: Observation, options: DecideOptions = {}): Promise<DecisionResult> {
    const model = options.model ?? cfg.model
    if (!cfg.apiKey) return missingKeyResult('gpt', model, 'OPENAI_API_KEY')

    const price = gptPriceFor(model, cfg)
    const params = buildGptRequest(observation, { ...cfg, model })
    const rawRequest = { ...params, options: { timeoutMs: cfg.timeoutMs, maxRetries: cfg.maxRetries } }
    const attempts: AttemptLog[] = []
    let client: OpenAI
    try {
      client = newClient(attempts)
    } catch (error) {
      return errorResult('gpt', model, describeGptError(error, cfg.timeoutMs, [cfg.apiKey]), {
        raw: { request: rawRequest },
      })
    }

    const started = performance.now()
    let completion: ChatCompletion
    let requestId: string | null = null
    try {
      const { data, request_id } = await client.chat.completions
        .create(params, { signal: options.signal })
        .withResponse()
      completion = data
      requestId = request_id
    } catch (error) {
      return errorResult('gpt', model, describeGptError(error, cfg.timeoutMs, [cfg.apiKey]), {
        providerLatencyMs: roundMs(performance.now() - started),
        raw: { request: rawRequest, response: { attempts } },
      })
    }
    const providerLatencyMs = roundMs(performance.now() - started)

    const choice = completion.choices?.[0]
    const message = choice?.message
    const parsed = choice
      ? parseGptContent(message?.content, message?.refusal, choice.finish_reason)
      : { status: 'invalid' as const, answer: { ...NULL_ANSWER }, errorMessage: 'No choices in response' }
    const usage = usageOf(completion)

    const result: DecisionResult = {
      engine: 'gpt',
      mode: 'live',
      model: completion.model || model,
      status: parsed.status,
      answer: parsed.answer,
      providerLatencyMs,
      raw: {
        request: rawRequest,
        response: {
          id: completion.id,
          model: completion.model,
          content: message?.content ?? null,
          refusal: message?.refusal ?? null,
          finish_reason: choice?.finish_reason ?? null,
          usage: completion.usage ?? null,
          system_fingerprint: completion.system_fingerprint ?? null,
          requestId,
          attempts,
          pricing: price ? { ...price.prices, source: price.source } : null,
        },
      },
    }
    if (parsed.errorMessage) result.errorMessage = parsed.errorMessage
    if (usage) {
      result.usage = usage
      // Unknown price (model not in the table and not OPENAI_MODEL with .env prices) → no cost rather than a wrong one.
      if (price) result.costUsd = costUsd(usage, price.prices)
    }
    return result
  }

  const option = (id: string) => toModelOption(id, gptPriceFor(id, cfg), gptModelProfile(id).reasoning)
  const fallback = (error?: string): EngineModels => ({
    default: cfg.model,
    provider,
    models: orderModelIds(GPT_FALLBACK_MODELS, cfg.model).map(option),
    source: 'fallback',
    ...(error ? { error } : {}),
  })

  const listModels = cachedListing(async () => {
    if (!cfg.apiKey) return fallback()
    try {
      const ids: string[] = []
      for await (const m of newClient().models.list()) ids.push(m.id)
      const chat = ids.filter(isChatGptModel)
      if (chat.length === 0) return fallback('The provider listed no chat models')
      return { default: cfg.model, provider, models: orderModelIds(chat, cfg.model).map(option), source: 'provider' }
    } catch (error) {
      return fallback(describeGptError(error, cfg.timeoutMs, [cfg.apiKey]))
    }
  })

  return { engine: 'gpt', live, model: cfg.model, provider, decide, listModels }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
