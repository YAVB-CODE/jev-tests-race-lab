import { describe, expect, it } from 'vitest'
import { GAME_BRIEF, MOVE_QUESTION, SPEED_QUESTION } from '../../src/shared/rules.ts'
import { loadConfig, type GptConfig } from '../env.ts'
import { SAMPLE_EASY_OBSERVATION } from '../fixtures.ts'
import { hangUntilAborted, jsonResponse, scriptedFetch } from '../testing.ts'
import {
  GPT_SCHEMA,
  GPT_SYSTEM_PROMPT,
  buildGptRequest,
  createGptAdapter,
  gptModelProfile,
  parseGptContent,
} from './gpt.ts'

const KEY = 'sk-test-SECRET-1234567890abcdef'

function cfg(overrides: Partial<GptConfig> = {}): GptConfig {
  return { ...loadConfig({}).gpt, apiKey: KEY, ...overrides }
}

function completion(content: string | null, extra: { refusal?: string | null; finish_reason?: string } = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-4.1-mini-2025-04-14',
    choices: [
      {
        index: 0,
        finish_reason: extra.finish_reason ?? 'stop',
        logprobs: null,
        message: { role: 'assistant', content, refusal: extra.refusal ?? null },
      },
    ],
    usage: { prompt_tokens: 812, completion_tokens: 31, total_tokens: 843 },
  }
}

const VALID = '{"move":"forward","speed":"boost","move_confidence":0.92,"speed_confidence":0.7}'

describe('parseGptContent', () => {
  it('parses a valid answer', () => {
    const r = parseGptContent(VALID, null, 'stop')
    expect(r.status).toBe('ok')
    expect(r.answer).toEqual({ move: 'forward', speed: 'boost', moveConfidence: 0.92, speedConfidence: 0.7 })
    expect(r.errorMessage).toBeUndefined()
  })

  it('rejects out-of-enum values without normalising them', () => {
    const move = parseGptContent('{"move":"backward","speed":"slow","move_confidence":1,"speed_confidence":1}')
    expect(move.status).toBe('invalid')
    expect(move.answer).toEqual({ move: null, speed: null })
    expect(move.errorMessage).toContain('"move" out of set')
    expect(move.parsed).toMatchObject({ move: 'backward' })

    const caseDiff = parseGptContent('{"move":"Forward","speed":"slow","move_confidence":1,"speed_confidence":1}')
    expect(caseDiff.status).toBe('invalid')

    const speed = parseGptContent('{"move":"left","speed":"turbo","move_confidence":1,"speed_confidence":1}')
    expect(speed.status).toBe('invalid')
    expect(speed.answer).toEqual({ move: null, speed: null })
    expect(speed.errorMessage).toContain('"speed" out of set')
  })

  it('flags malformed JSON and non-object JSON', () => {
    const bad = parseGptContent('{"move":"forward",')
    expect(bad.status).toBe('invalid')
    expect(bad.errorMessage).toMatch(/Malformed JSON/)
    expect(parseGptContent('{"move":"forward",', null, 'length').errorMessage).toMatch(/truncated/)
    expect(parseGptContent('["forward","slow"]').errorMessage).toBe('Output is not a JSON object')
  })

  it('flags refusals and empty output', () => {
    const refused = parseGptContent(null, "I'm sorry, I can't help with that.")
    expect(refused.status).toBe('invalid')
    expect(refused.errorMessage).toMatch(/^Model refused/)
    expect(parseGptContent('', null, 'stop').errorMessage).toBe('Empty output from model')
    expect(parseGptContent(null, null, 'length').errorMessage).toMatch(/max_completion_tokens/)
    expect(parseGptContent(null, null, 'content_filter').errorMessage).toMatch(/content filter/)
  })

  it('clamps confidences to [0, 1] and drops non-numeric ones', () => {
    const r = parseGptContent('{"move":"right","speed":"cruise","move_confidence":1.7,"speed_confidence":-0.2}')
    expect(r.answer.moveConfidence).toBe(1)
    expect(r.answer.speedConfidence).toBe(0)
    const s = parseGptContent('{"move":"right","speed":"cruise","move_confidence":"high"}')
    expect(s.status).toBe('ok')
    expect(s.answer.moveConfidence).toBeUndefined()
    expect(s.answer.speedConfidence).toBeUndefined()
  })

  it('tolerates a markdown code fence around the JSON', () => {
    expect(parseGptContent('```json\n' + VALID + '\n```').status).toBe('ok')
  })
})

describe('buildGptRequest', () => {
  it('sends the canonical rules and questions in the system prompt and the observation as user JSON', () => {
    const params = buildGptRequest(SAMPLE_EASY_OBSERVATION, cfg())
    const [system, user] = params.messages
    expect(system.role).toBe('system')
    expect(system.content).toBe(GPT_SYSTEM_PROMPT)
    expect(GPT_SYSTEM_PROMPT.startsWith(GAME_BRIEF)).toBe(true)
    for (const text of [MOVE_QUESTION.instructions, SPEED_QUESTION.instructions]) expect(GPT_SYSTEM_PROMPT).toContain(text)
    for (const text of [...Object.values(MOVE_QUESTION.criteria), ...Object.values(SPEED_QUESTION.criteria)]) {
      expect(GPT_SYSTEM_PROMPT).toContain(text)
    }
    expect(user).toEqual({ role: 'user', content: JSON.stringify(SAMPLE_EASY_OBSERVATION) })
    expect(params.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'race_decision', strict: true, schema: GPT_SCHEMA },
    })
    expect(GPT_SCHEMA.required).toEqual(Object.keys(GPT_SCHEMA.properties))
  })

  it('uses temperature 0 for classic models', () => {
    const params = buildGptRequest(SAMPLE_EASY_OBSERVATION, cfg({ model: 'gpt-4.1-mini', reasoningEffort: 'low' }))
    expect(params.temperature).toBe(0)
    expect(params.max_completion_tokens).toBe(256)
    expect(params.reasoning_effort).toBeUndefined()
  })

  it('omits temperature for reasoning models and forwards reasoning_effort', () => {
    for (const model of ['gpt-5', 'gpt-5-mini', 'gpt-5.5', 'o3', 'o4-mini', 'o1']) {
      const params = buildGptRequest(SAMPLE_EASY_OBSERVATION, cfg({ model, reasoningEffort: 'minimal' }))
      expect(params, model).not.toHaveProperty('temperature')
      expect(params.max_completion_tokens).toBe(4096)
      expect(params.reasoning_effort).toBe('minimal')
      expect(params.messages[0].role).toBe('developer')
    }
    const custom = buildGptRequest(SAMPLE_EASY_OBSERVATION, cfg({ model: 'o4-mini', maxCompletionTokens: 1500 }))
    expect(custom.max_completion_tokens).toBe(1500)
    expect(custom).not.toHaveProperty('reasoning_effort')
  })

  it('classifies model families', () => {
    expect(gptModelProfile('gpt-4o-mini')).toMatchObject({ reasoning: false, omitTemperature: false })
    expect(gptModelProfile('gpt-5-chat-latest')).toMatchObject({ reasoning: false, omitTemperature: true })
    expect(gptModelProfile('o3-mini')).toMatchObject({ reasoning: true, omitTemperature: true })
  })
})

describe('createGptAdapter', () => {
  it('returns status error without calling OpenAI when the key is missing', async () => {
    const fetch = scriptedFetch([jsonResponse(completion(VALID))])
    const adapter = createGptAdapter(cfg({ apiKey: undefined }), { fetch })
    expect(adapter.live).toBe(false)
    const r = await adapter.decide(SAMPLE_EASY_OBSERVATION)
    expect(r).toMatchObject({ engine: 'gpt', mode: 'live', status: 'error', answer: { move: null, speed: null } })
    expect(r.errorMessage).toContain('OPENAI_API_KEY')
    expect(fetch.calls).toHaveLength(0)
  })

  it('maps a successful completion: answer, usage, cost, latency and raw payloads', async () => {
    const fetch = scriptedFetch([jsonResponse(completion(VALID), 200, { 'x-request-id': 'req_123' })])
    const adapter = createGptAdapter(cfg(), { fetch })
    const r = await adapter.decide(SAMPLE_EASY_OBSERVATION)

    expect(r.status).toBe('ok')
    expect(r.model).toBe('gpt-4.1-mini-2025-04-14')
    expect(r.answer).toEqual({ move: 'forward', speed: 'boost', moveConfidence: 0.92, speedConfidence: 0.7 })
    expect(r.usage).toEqual({ inputTokens: 812, outputTokens: 31 })
    expect(r.costUsd).toBeCloseTo((812 * 0.4 + 31 * 1.6) / 1e6, 12)
    expect(r.providerLatencyMs).toBeGreaterThanOrEqual(0)

    // What actually went over the wire
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0].url).toMatch(/\/chat\/completions$/)
    expect(fetch.calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`)
    const sent = fetch.calls[0].body as Record<string, unknown>
    expect(sent).toMatchObject({ model: 'gpt-4.1-mini', temperature: 0 })
    expect(sent.response_format).toMatchObject({ type: 'json_schema' })

    // raw: request + response, never the key
    const raw = r.raw as { request: Record<string, unknown>; response: Record<string, unknown> }
    expect(raw.request.messages).toEqual(sent.messages)
    expect(raw.response).toMatchObject({ content: VALID, finish_reason: 'stop', requestId: 'req_123' })
    expect(raw.response.attempts).toEqual([expect.objectContaining({ attempt: 1, status: 200 })])
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('maps a refusal to status invalid but keeps usage and cost', async () => {
    const fetch = scriptedFetch([jsonResponse(completion(null, { refusal: 'No.' }))])
    const r = await createGptAdapter(cfg(), { fetch }).decide(SAMPLE_EASY_OBSERVATION)
    expect(r.status).toBe('invalid')
    expect(r.answer).toEqual({ move: null, speed: null })
    expect(r.errorMessage).toMatch(/refused/)
    expect(r.usage).toBeDefined()
    expect(r.costUsd).toBeGreaterThan(0)
  })

  it('maps HTTP errors to status error without leaking the key', async () => {
    const body = { error: { message: `Incorrect API key provided: ${KEY}.`, type: 'invalid_request_error', code: 'invalid_api_key' } }
    const fetch = scriptedFetch([jsonResponse(body, 401)])
    const r = await createGptAdapter(cfg(), { fetch }).decide(SAMPLE_EASY_OBSERVATION)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toMatch(/^OpenAI 401/)
    expect(JSON.stringify(r)).not.toContain(KEY)
    expect(fetch.calls).toHaveLength(1)
  })

  it('surfaces 400 details (e.g. unsupported parameter) redacted', async () => {
    const body = { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: 'invalid_request_error' } }
    const fetch = scriptedFetch([jsonResponse(body, 400)])
    const r = await createGptAdapter(cfg(), { fetch }).decide(SAMPLE_EASY_OBSERVATION)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toMatch(/^OpenAI 400: Unsupported parameter/)
  })

  it('maps network failures to status error', async () => {
    const fetch = scriptedFetch([new TypeError('fetch failed')])
    const r = await createGptAdapter(cfg({ maxRetries: 0 }), { fetch }).decide(SAMPLE_EASY_OBSERVATION)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toMatch(/OpenAI (network error|error)/)
  })

  it('aborts the upstream call when the signal fires', async () => {
    const fetch = scriptedFetch([hangUntilAborted])
    const controller = new AbortController()
    const pending = createGptAdapter(cfg(), { fetch }).decide(SAMPLE_EASY_OBSERVATION, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const r = await pending
    expect(r.status).toBe('error')
    expect(r.errorMessage).toMatch(/aborted/)
    expect(fetch.calls).toHaveLength(1)
  })
})
