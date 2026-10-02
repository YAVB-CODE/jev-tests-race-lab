import { describe, expect, it } from 'vitest'
import { DEFAULTS, loadConfig } from './env.ts'
import { costUsd, gptPrices, jevPrices } from './pricing.ts'

describe('costUsd', () => {
  it('prices GPT input and output separately', () => {
    const prices = gptPrices({ priceInputPerMTok: 0.4, priceOutputPerMTok: 1.6 })
    // 1000 × 0.40/1e6 + 50 × 1.60/1e6 = 0.0004 + 0.00008
    expect(costUsd({ inputTokens: 1000, outputTokens: 50 }, prices)).toBeCloseTo(0.00048, 12)
  })

  it('charges Jev input only (output is free)', () => {
    const prices = jevPrices({ priceInputPerMTok: 0.042 })
    expect(prices.outputPerMTok).toBe(0)
    expect(costUsd({ inputTokens: 392, outputTokens: 65 }, prices)).toBeCloseTo(392 * 0.042e-6, 15)
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, prices)).toBe(0.042)
  })

  it('has no float noise and ignores negative counts', () => {
    const prices = gptPrices({ priceInputPerMTok: 0.4, priceOutputPerMTok: 1.6 })
    expect(String(costUsd({ inputTokens: 42, outputTokens: 0 }, prices))).toBe('0.0000168')
    expect(costUsd({ inputTokens: -5, outputTokens: 0 }, prices)).toBe(0)
  })
})

describe('loadConfig', () => {
  it('uses defaults when env is empty', () => {
    const cfg = loadConfig({})
    expect(cfg.port).toBe(8787)
    expect(cfg.gpt).toMatchObject({ apiKey: undefined, model: 'gpt-4.1-mini', priceInputPerMTok: 0.4, priceOutputPerMTok: 1.6, maxRetries: 1 })
    expect(cfg.jev).toMatchObject({ apiKey: undefined, model: 'jev-1.13-free', priceInputPerMTok: DEFAULTS.JEV_PRICE_INPUT_PER_MTOK, maxRetries: 1, timeoutMs: 10_000 })
  })

  it('reads env values and ignores blank or invalid ones', () => {
    const cfg = loadConfig({
      PORT: '9000',
      OPENAI_API_KEY: '  sk-test  ',
      OPENAI_MODEL: 'gpt-5-mini',
      OPENAI_PRICE_INPUT_PER_MTOK: '0.25',
      OPENAI_PRICE_OUTPUT_PER_MTOK: 'abc',
      OPENAI_REASONING_EFFORT: 'LOW',
      OPENAI_MAX_COMPLETION_TOKENS: '2000',
      OPENCODE_API_KEY: '   ',
      JEV_MODEL: 'jev-1.13',
      JEV_MAX_RETRIES: '-1',
    })
    expect(cfg.port).toBe(9000)
    expect(cfg.gpt).toMatchObject({
      apiKey: 'sk-test',
      model: 'gpt-5-mini',
      priceInputPerMTok: 0.25,
      priceOutputPerMTok: 1.6,
      reasoningEffort: 'low',
      maxCompletionTokens: 2000,
    })
    expect(cfg.jev.apiKey).toBeUndefined()
    expect(cfg.jev.model).toBe('jev-1.13')
    expect(cfg.jev.maxRetries).toBe(1)
    expect(loadConfig({ OPENAI_REASONING_EFFORT: 'turbo' }).gpt.reasoningEffort).toBeUndefined()
  })
})
