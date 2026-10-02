/**
 * Cost estimation from token usage and per-million-token prices.
 *  - GPT: input × OPENAI_PRICE_INPUT_PER_MTOK + output × OPENAI_PRICE_OUTPUT_PER_MTOK
 *    (output includes reasoning tokens, which OpenAI bills as output).
 *  - Jev: input × JEV_PRICE_INPUT_PER_MTOK; output tokens are free (OpenCode Zen pricing).
 */
import type { TokenUsage } from '../src/shared/contracts.ts'

export interface TokenPrices {
  /** USD per million input tokens. */
  inputPerMTok: number
  /** USD per million output tokens. */
  outputPerMTok: number
}

/** Rounds away float noise (1e-12 USD resolution) so logs stay readable. */
function roundUsd(value: number): number {
  return Math.round(value * 1e12) / 1e12
}

export function costUsd(usage: TokenUsage, prices: TokenPrices): number {
  const input = Math.max(0, usage.inputTokens) * prices.inputPerMTok
  const output = Math.max(0, usage.outputTokens) * prices.outputPerMTok
  return roundUsd((input + output) / 1_000_000)
}

export function gptPrices(cfg: { priceInputPerMTok: number; priceOutputPerMTok: number }): TokenPrices {
  return { inputPerMTok: cfg.priceInputPerMTok, outputPerMTok: cfg.priceOutputPerMTok }
}

export function jevPrices(cfg: { priceInputPerMTok: number }): TokenPrices {
  return { inputPerMTok: cfg.priceInputPerMTok, outputPerMTok: 0 }
}
