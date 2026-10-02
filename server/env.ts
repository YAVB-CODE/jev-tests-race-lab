/**
 * Typed server configuration, read from process.env (loaded from `.env` by server/index.ts).
 * Variable names match .env.example. Read lazily (call `loadConfig()`), never at import time,
 * so tests can pass their own env and the dotenv load order does not matter.
 */

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffortSetting = (typeof REASONING_EFFORTS)[number]

export interface GptConfig {
  /** OPENAI_API_KEY — undefined when blank. Never log or echo it. */
  apiKey: string | undefined
  /** OPENAI_MODEL (default gpt-4.1-mini). */
  model: string
  /** OPENAI_BASE_URL (optional; SDK default otherwise). */
  baseURL: string | undefined
  /** OPENAI_PRICE_INPUT_PER_MTOK / OPENAI_PRICE_OUTPUT_PER_MTOK (USD per million tokens; defaults match gpt-4.1-mini). */
  priceInputPerMTok: number
  priceOutputPerMTok: number
  /** true when both OPENAI_PRICE_* are set in the env: they then apply to OPENAI_MODEL (other models use server/models.ts). */
  pricesFromEnv: boolean
  /** OPENAI_REASONING_EFFORT — only sent to reasoning models (gpt-5*, o-series). */
  reasoningEffort: ReasoningEffortSetting | undefined
  /** OPENAI_MAX_COMPLETION_TOKENS — default depends on the model family (see adapters/gpt.ts). */
  maxCompletionTokens: number | undefined
  /** OPENAI_TIMEOUT_MS — per attempt (default 30000). The browser runner usually aborts earlier. */
  timeoutMs: number
  /** OPENAI_MAX_RETRIES — default 1 (SDK default is 2; fewer retries = less hidden latency). */
  maxRetries: number
}

/** Jev is served only through OpenCode Zen (https://opencode.ai/docs/zen): `POST {base}/v1/systemone`. */
export const OPENCODE_LABEL = 'OpenCode Zen'
export const OPENCODE_DEFAULT_BASE_URL = 'https://opencode.ai/zen'

/** Jev model ids listed by OpenCode Zen. */
export const OPENCODE_JEV_MODELS: readonly string[] = ['jev-1.13', 'jev-1.13-free']

/** Human-readable startup warnings for configurations that will likely fail (never includes secrets). */
export function configWarnings(cfg: ServerConfig): string[] {
  const warnings: string[] = []
  const { jev } = cfg
  if (!OPENCODE_JEV_MODELS.includes(jev.model)) {
    warnings.push(
      `JEV_MODEL=${jev.model} no aparece en OpenCode Zen (usa ${OPENCODE_JEV_MODELS.join(' o ')}, o borra JEV_MODEL para usar jev-1.13-free).`,
    )
  }
  return warnings
}

export interface JevConfig {
  /** OPENCODE_API_KEY — undefined when blank. Never log or echo it. */
  apiKey: string | undefined
  /** JEV_MODEL (default jev-1.13-free). */
  model: string
  /** OPENCODE_BASE_URL (default https://opencode.ai/zen). */
  baseURL: string
  /** JEV_PRICE_INPUT_PER_MTOK for paid models (default 0.042). `*-free` models always cost 0. Output tokens are free. */
  priceInputPerMTok: number
  /** JEV_TIMEOUT_MS — per attempt (default 10000). */
  timeoutMs: number
  /** JEV_MAX_RETRIES — default 1, only on 429 / 529 / connection errors. */
  maxRetries: number
}

export interface ServerConfig {
  port: number
  gpt: GptConfig
  jev: JevConfig
}

type Env = Record<string, string | undefined>

function str(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function num(env: Env, name: string, fallback: number, { min = 0, integer = false } = {}): number {
  const raw = str(env, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) return fallback
  return value
}

function optionalInt(env: Env, name: string, min: number): number | undefined {
  const raw = str(env, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= min ? value : undefined
}

function reasoningEffort(env: Env): ReasoningEffortSetting | undefined {
  const raw = str(env, 'OPENAI_REASONING_EFFORT')?.toLowerCase()
  return (REASONING_EFFORTS as readonly string[]).includes(raw ?? '') ? (raw as ReasoningEffortSetting) : undefined
}

export const DEFAULTS = {
  PORT: 8787,
  OPENAI_MODEL: 'gpt-4.1-mini',
  OPENAI_PRICE_INPUT_PER_MTOK: 0.4,
  OPENAI_PRICE_OUTPUT_PER_MTOK: 1.6,
  OPENAI_TIMEOUT_MS: 30_000,
  OPENAI_MAX_RETRIES: 1,
  JEV_MODEL: 'jev-1.13-free',
  JEV_PRICE_INPUT_PER_MTOK: 0.042,
  JEV_TIMEOUT_MS: 10_000,
  JEV_MAX_RETRIES: 1,
} as const

export function loadConfig(env: Env = process.env): ServerConfig {
  return {
    port: num(env, 'PORT', DEFAULTS.PORT, { integer: true }),
    gpt: {
      apiKey: str(env, 'OPENAI_API_KEY'),
      model: str(env, 'OPENAI_MODEL') ?? DEFAULTS.OPENAI_MODEL,
      baseURL: str(env, 'OPENAI_BASE_URL'),
      priceInputPerMTok: num(env, 'OPENAI_PRICE_INPUT_PER_MTOK', DEFAULTS.OPENAI_PRICE_INPUT_PER_MTOK),
      priceOutputPerMTok: num(env, 'OPENAI_PRICE_OUTPUT_PER_MTOK', DEFAULTS.OPENAI_PRICE_OUTPUT_PER_MTOK),
      pricesFromEnv: str(env, 'OPENAI_PRICE_INPUT_PER_MTOK') !== undefined && str(env, 'OPENAI_PRICE_OUTPUT_PER_MTOK') !== undefined,
      reasoningEffort: reasoningEffort(env),
      maxCompletionTokens: optionalInt(env, 'OPENAI_MAX_COMPLETION_TOKENS', 16),
      timeoutMs: num(env, 'OPENAI_TIMEOUT_MS', DEFAULTS.OPENAI_TIMEOUT_MS, { min: 1, integer: true }),
      maxRetries: num(env, 'OPENAI_MAX_RETRIES', DEFAULTS.OPENAI_MAX_RETRIES, { integer: true }),
    },
    jev: jevConfig(env),
  }
}

function jevConfig(env: Env): JevConfig {
  return {
    apiKey: str(env, 'OPENCODE_API_KEY'),
    model: str(env, 'JEV_MODEL') ?? DEFAULTS.JEV_MODEL,
    baseURL: (str(env, 'OPENCODE_BASE_URL') ?? OPENCODE_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    priceInputPerMTok: num(env, 'JEV_PRICE_INPUT_PER_MTOK', DEFAULTS.JEV_PRICE_INPUT_PER_MTOK),
    timeoutMs: num(env, 'JEV_TIMEOUT_MS', DEFAULTS.JEV_TIMEOUT_MS, { min: 1, integer: true }),
    maxRetries: num(env, 'JEV_MAX_RETRIES', DEFAULTS.JEV_MAX_RETRIES, { integer: true }),
  }
}
