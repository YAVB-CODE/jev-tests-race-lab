import { describe, expect, it } from 'vitest'
import type { EngineModels } from '../src/shared/contracts.ts'
import { createGptAdapter } from './adapters/gpt.ts'
import { createJevAdapter } from './adapters/jev.ts'
import { loadConfig } from './env.ts'
import { SAMPLE_EASY_OBSERVATION } from './fixtures.ts'
import {
  MODEL_LIST_TTL_MS,
  cachedListing,
  gptPriceFor,
  isChatGptModel,
  jevPriceFor,
  orderModelIds,
  parseModelIds,
} from './models.ts'
import { jsonResponse, scriptedFetch } from './testing.ts'

/** A slice of a real OpenAI /v1/models listing. */
const OPENAI_IDS = [
  'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-4o', 'gpt-4o-mini-tts', 'gpt-4o-transcribe', 'gpt-5', 'gpt-5-mini',
  'gpt-5-codex', 'gpt-5-pro', 'gpt-5-chat-latest', 'gpt-5.4-nano', 'gpt-6-sol', 'gpt-image-1', 'gpt-realtime',
  'gpt-audio', 'gpt-3.5-turbo', 'o3', 'o3-deep-research', 'o4-mini', 'text-embedding-3-small', 'whisper-1', 'tts-1',
  'omni-moderation-latest', 'davinci-002', 'gpt-4o-search-preview',
]

describe('isChatGptModel', () => {
  it('keeps chat models with Structured Outputs and drops the rest', () => {
    expect(OPENAI_IDS.filter(isChatGptModel)).toEqual(['gpt-4.1-mini', 'gpt-4o', 'gpt-5', 'gpt-5-mini', 'gpt-5.4-nano', 'gpt-6-sol', 'o3', 'o4-mini'])
  })
})

describe('orderModelIds', () => {
  it('puts the default first, dedupes and sorts naturally', () => {
    expect(orderModelIds(['gpt-5.4', 'gpt-4.1', 'gpt-5', 'gpt-4.1'], 'gpt-5')).toEqual(['gpt-5', 'gpt-4.1', 'gpt-5.4'])
    expect(orderModelIds(['jev-1.13'], 'jev-1.13-free')).toEqual(['jev-1.13-free', 'jev-1.13'])
  })
})

describe('prices', () => {
  const gpt = loadConfig({}).gpt
  it('uses .env prices only for OPENAI_MODEL when both are set', () => {
    const fromEnv = { ...gpt, model: 'gpt-4.1-mini', priceInputPerMTok: 9, priceOutputPerMTok: 9, pricesFromEnv: true }
    expect(gptPriceFor('gpt-4.1-mini', fromEnv)).toEqual({ prices: { inputPerMTok: 9, outputPerMTok: 9 }, source: 'env' })
    expect(gptPriceFor('gpt-4o', fromEnv)).toEqual({ prices: { inputPerMTok: 2.5, outputPerMTok: 10 }, source: 'table' })
  })

  it('maps dated snapshots to the table and leaves unknown models unpriced', () => {
    expect(gptPriceFor('gpt-4.1-mini-2025-04-14', gpt)?.prices).toEqual({ inputPerMTok: 0.4, outputPerMTok: 1.6 })
    expect(gptPriceFor('gpt-6-sol', gpt)).toBeUndefined()
  })

  it('prices Jev free models at 0 and paid ones at the configured rate', () => {
    const jev = loadConfig({}).jev
    expect(jevPriceFor('jev-1.13-free', jev)).toEqual({ prices: { inputPerMTok: 0, outputPerMTok: 0 }, source: 'free' })
    expect(jevPriceFor('jev-1.13', jev).prices).toEqual({ inputPerMTok: 0.042, outputPerMTok: 0 })
  })
})

describe('parseModelIds', () => {
  it('reads OpenAI-style listings (OpenAI and OpenCode Zen)', () => {
    expect(parseModelIds({ object: 'list', data: [{ id: 'jev-1.13' }, { id: 'gpt-5' }] })).toEqual(['jev-1.13', 'gpt-5'])
    expect(parseModelIds({ data: [{ name: 'no-id' }, null, { id: '' }] })).toEqual([])
    expect(parseModelIds('nope')).toEqual([])
  })
})

describe('cachedListing', () => {
  it('reuses the result within the TTL unless forced', async () => {
    let t = 0
    let loads = 0
    const list = cachedListing(async () => ({ default: 'm', models: [{ id: `m${++loads}` }], source: 'provider' }) as EngineModels, () => t)
    await list()
    await list()
    expect(loads).toBe(1)
    await list(true)
    expect(loads).toBe(2)
    t += MODEL_LIST_TTL_MS + 1
    await list()
    expect(loads).toBe(3)
  })
})

describe('GPT adapter models', () => {
  const completion = {
    id: 'c',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-2024-11-20',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: '{"move":"forward","speed":"boost","move_confidence":0.9,"speed_confidence":0.8}', refusal: null } }],
    usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
  }

  it('sends the per-request model and prices it from the table', async () => {
    const fetch = scriptedFetch([jsonResponse(completion)])
    const adapter = createGptAdapter({ ...loadConfig({}).gpt, apiKey: 'sk-test' }, { fetch })
    const r = await adapter.decide(SAMPLE_EASY_OBSERVATION, { model: 'gpt-4o' })
    expect((fetch.calls[0].body as { model: string }).model).toBe('gpt-4o')
    expect(r.costUsd).toBeCloseTo((1000 * 2.5 + 100 * 10) / 1e6, 12)
  })

  it('reports no cost for a model with unknown price', async () => {
    const fetch = scriptedFetch([jsonResponse(completion)])
    const adapter = createGptAdapter({ ...loadConfig({}).gpt, apiKey: 'sk-test' }, { fetch })
    const r = await adapter.decide(SAMPLE_EASY_OBSERVATION, { model: 'gpt-6-sol' })
    expect(r.status).toBe('ok')
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 100 })
    expect(r.costUsd).toBeUndefined()
  })

  it('lists chat models from the provider, default first', async () => {
    const fetch = scriptedFetch([jsonResponse({ object: 'list', data: OPENAI_IDS.map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' })) })])
    const adapter = createGptAdapter({ ...loadConfig({}).gpt, apiKey: 'sk-test' }, { fetch })
    const list = await adapter.listModels()
    expect(fetch.calls[0].url).toBe('https://api.openai.com/v1/models')
    expect(list.source).toBe('provider')
    expect(list.models.map((m) => m.id)).toEqual(['gpt-4.1-mini', 'gpt-4o', 'gpt-5', 'gpt-5-mini', 'gpt-5.4-nano', 'gpt-6-sol', 'o3', 'o4-mini'])
    expect(list.models.find((m) => m.id === 'gpt-5')).toMatchObject({ reasoning: true, inputPerMTok: 1.25, priceSource: 'table' })
    expect(list.models.find((m) => m.id === 'gpt-4o')?.reasoning).toBeUndefined()
  })

  it('falls back to the built-in list without a key or on errors', async () => {
    expect((await createGptAdapter(loadConfig({}).gpt).listModels()).source).toBe('fallback')
    const fetch = scriptedFetch([jsonResponse({ error: { message: 'bad key' } }, 401)])
    const list = await createGptAdapter({ ...loadConfig({}).gpt, apiKey: 'sk-test', maxRetries: 0 }, { fetch }).listModels()
    expect(list).toMatchObject({ source: 'fallback', default: 'gpt-4.1-mini' })
    expect(list.error).toBeTruthy()
    expect(list.error).not.toContain('sk-test')
  })
})

describe('Jev adapter models', () => {
  const answer = {
    model: 'jev-1.13',
    answers: {
      move: { type: 'choice', choice: 'forward', confidence: 0.9, probabilities: { forward: 0.95, left: 0.05, right: 0 } },
      speed: { type: 'choice', choice: 'boost', confidence: 0.9, probabilities: { slow: 0, cruise: 0.05, boost: 0.95 } },
    },
    usage: { input_tokens: 1000, output_tokens: 60 },
  }

  it('sends the per-request model and prices paid vs free', async () => {
    const zen = loadConfig({ OPENCODE_API_KEY: 'zen-test' }).jev
    const fetch = scriptedFetch([jsonResponse(answer), jsonResponse(answer)])
    const adapter = createJevAdapter(zen, { fetch })
    const paid = await adapter.decide(SAMPLE_EASY_OBSERVATION, { model: 'jev-1.13' })
    expect((fetch.calls[0].body as { model: string }).model).toBe('jev-1.13')
    expect(paid.costUsd).toBeCloseTo((1000 * 0.042) / 1e6, 12)
    const free = await adapter.decide(SAMPLE_EASY_OBSERVATION)
    expect((fetch.calls[1].body as { model: string }).model).toBe('jev-1.13-free')
    expect(free.costUsd).toBe(0)
  })

  it('lists only Jev models from the OpenCode Zen catalogue', async () => {
    const zen = loadConfig({ OPENCODE_API_KEY: 'zen-test' }).jev
    const fetch = scriptedFetch([jsonResponse({ object: 'list', data: [{ id: 'claude-opus-5-5' }, { id: 'jev-1.13' }, { id: 'jev-1.13-free' }, { id: 'gpt-5' }] })])
    const list = await createJevAdapter(zen, { fetch }).listModels()
    expect(fetch.calls[0].url).toBe('https://opencode.ai/zen/v1/models')
    expect(fetch.calls[0].headers.get('authorization')).toBe('Bearer zen-test')
    expect(list).toMatchObject({ source: 'provider', default: 'jev-1.13-free', provider: 'OpenCode Zen' })
    expect(list.models).toEqual([
      { id: 'jev-1.13-free', inputPerMTok: 0, outputPerMTok: 0, priceSource: 'free' },
      { id: 'jev-1.13', inputPerMTok: 0.042, outputPerMTok: 0, priceSource: 'env' },
    ])
  })

  it('falls back to the built-in Zen list on HTTP errors or without a key', async () => {
    const zen = loadConfig({ OPENCODE_API_KEY: 'zen-test' }).jev
    const failing = scriptedFetch([jsonResponse({ detail: 'nope' }, 500)])
    const list = await createJevAdapter(zen, { fetch: failing }).listModels()
    expect(list).toMatchObject({ source: 'fallback', error: expect.stringContaining('HTTP 500') })
    expect(list.models.map((m) => m.id)).toEqual(['jev-1.13-free', 'jev-1.13'])
    expect((await createJevAdapter(loadConfig({}).jev).listModels()).source).toBe('fallback')
  })
})
