import { describe, expect, it } from 'vitest'
import { configWarnings, loadConfig } from './env.ts'

describe('Jev config (OpenCode Zen)', () => {
  it('reads OPENCODE_API_KEY with Zen defaults', () => {
    const { jev } = loadConfig({ OPENCODE_API_KEY: 'zen-key' })
    expect(jev).toMatchObject({
      apiKey: 'zen-key',
      model: 'jev-1.13-free',
      baseURL: 'https://opencode.ai/zen',
      priceInputPerMTok: 0.042,
      timeoutMs: 10_000,
      maxRetries: 1,
    })
  })

  it('honours JEV_MODEL, JEV_PRICE_INPUT_PER_MTOK and OPENCODE_BASE_URL', () => {
    const { jev } = loadConfig({
      OPENCODE_API_KEY: 'k',
      JEV_MODEL: 'jev-1.13',
      JEV_PRICE_INPUT_PER_MTOK: '0.05',
      OPENCODE_BASE_URL: 'http://localhost:9000/zen/',
    })
    expect(jev).toMatchObject({ model: 'jev-1.13', priceInputPerMTok: 0.05, baseURL: 'http://localhost:9000/zen' })
  })

  it('is not live without a key', () => {
    expect(loadConfig({}).jev.apiKey).toBeUndefined()
    expect(loadConfig({ OPENCODE_API_KEY: '   ' }).jev.apiKey).toBeUndefined()
  })

  it('knows whether GPT prices come from the env', () => {
    expect(loadConfig({}).gpt.pricesFromEnv).toBe(false)
    expect(loadConfig({ OPENAI_PRICE_INPUT_PER_MTOK: '1', OPENAI_PRICE_OUTPUT_PER_MTOK: '2' }).gpt.pricesFromEnv).toBe(true)
  })
})

describe('configWarnings', () => {
  it('flags a JEV_MODEL that OpenCode Zen does not list', () => {
    const [warning] = configWarnings(loadConfig({ OPENCODE_API_KEY: 'k', JEV_MODEL: 'jev-9000' }))
    expect(warning).toContain('JEV_MODEL=jev-9000')
  })

  it('stays quiet for valid setups', () => {
    expect(configWarnings(loadConfig({ OPENCODE_API_KEY: 'k' }))).toEqual([])
    expect(configWarnings(loadConfig({ OPENCODE_API_KEY: 'k', JEV_MODEL: 'jev-1.13' }))).toEqual([])
  })
})
