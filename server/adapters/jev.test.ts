import { describe, expect, it } from 'vitest'
import { GAME_BRIEF, MOVE_QUESTION, SPEED_QUESTION } from '../../src/shared/rules.ts'
import { loadConfig, type JevConfig } from '../env.ts'
import { SAMPLE_EASY_OBSERVATION } from '../fixtures.ts'
import { hangUntilAborted, jsonResponse, scriptedFetch } from '../testing.ts'
import { GPT_CONTEXT, GPT_SCHEMA, GPT_SYSTEM_PROMPT, buildGptRequest } from './gpt.ts'
import { JEV_CONTEXT, buildJevRequest, createJevAdapter, mapJevAnswers } from './jev.ts'

const KEY = 'zen-test-SECRET-abcdef123456'

function cfg(overrides: Partial<JevConfig> = {}): JevConfig {
  return { ...loadConfig({ OPENCODE_API_KEY: KEY }).jev, ...overrides }
}

/** /v1/systemone response shape (Choice answers, model id, usage). */
function jevBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'jev-1.13',
    answers: {
      move: {
        type: 'choice',
        choice: 'forward',
        confidence: 0.78,
        probabilities: { forward: 0.85, left: 0.0, right: 0.15 },
      },
      speed: {
        type: 'choice',
        choice: 'boost',
        confidence: 0.42,
        probabilities: { slow: 0.04, cruise: 0.35, boost: 0.61 },
      },
      ...overrides,
    },
    usage: { input_tokens: 589, output_tokens: 212 },
  }
}

const RETRY_NOW = { 'retry-after-ms': '0' }

describe('buildJevRequest', () => {
  it('puts the rules and the observation in a structured state and asks two Choice questions', () => {
    const req = buildJevRequest(SAMPLE_EASY_OBSERVATION, 'jev-1.13-free')
    expect(req.model).toBe('jev-1.13-free')
    expect(req.state).toEqual({ game_rules: GAME_BRIEF, observation: SAMPLE_EASY_OBSERVATION })
    expect(Object.keys(req.questions)).toEqual(['move', 'speed'])
    expect(req.questions.move).toEqual({
      type: 'choice',
      instructions: { question: MOVE_QUESTION.instructions, context: JEV_CONTEXT },
      criteria: MOVE_QUESTION.criteria,
    })
    expect(req.questions.speed).toEqual({
      type: 'choice',
      instructions: { question: SPEED_QUESTION.instructions, context: JEV_CONTEXT },
      criteria: SPEED_QUESTION.criteria,
    })
    // Same pointer information on both sides (rules location + observation location).
    expect(JEV_CONTEXT).toMatch(/rules/)
    expect(GPT_CONTEXT).toMatch(/rules/)
  })
})

describe('fairness: both providers receive the same information', () => {
  it('same observation JSON, same rules text, same question texts and option keys', () => {
    const jevReq = buildJevRequest(SAMPLE_EASY_OBSERVATION, 'jev-1.13-free')
    const gptReq = buildGptRequest(SAMPLE_EASY_OBSERVATION, loadConfig({}).gpt)
    const state = jevReq.state as { game_rules: string; observation: unknown }
    expect(JSON.stringify(state.observation)).toBe(gptReq.messages[1].content)
    expect(GPT_SYSTEM_PROMPT.startsWith(state.game_rules)).toBe(true)
    for (const [id, q] of Object.entries(jevReq.questions)) {
      const instructions = q.instructions as { question: string }
      expect(GPT_SYSTEM_PROMPT, id).toContain(`Question "${id}": ${instructions.question}`)
      for (const [option, description] of Object.entries(q.criteria)) {
        expect(GPT_SYSTEM_PROMPT).toContain(`- "${option}": ${description}`)
      }
    }
    const schema = GPT_SCHEMA.properties
    expect(schema.move.enum).toEqual(Object.keys(jevReq.questions.move.criteria))
    expect(schema.speed.enum).toEqual(Object.keys(jevReq.questions.speed.criteria))
  })
})

describe('mapJevAnswers', () => {
  it('maps choice, probabilities, calibrated confidence and native confidence', () => {
    const r = mapJevAnswers(jevBody())
    expect(r.status).toBe('ok')
    expect(r.answer).toEqual({
      move: 'forward',
      speed: 'boost',
      moveProbabilities: { forward: 0.85, left: 0, right: 0.15 },
      speedProbabilities: { slow: 0.04, cruise: 0.35, boost: 0.61 },
      moveConfidence: 0.85,
      speedConfidence: 0.61,
      nativeMoveConfidence: 0.78,
      nativeSpeedConfidence: 0.42,
    })
  })

  it('flags out-of-set choices as invalid', () => {
    const r = mapJevAnswers(jevBody({ move: { type: 'choice', choice: 'backward', confidence: 1, probabilities: { backward: 1 } } }))
    expect(r.status).toBe('invalid')
    expect(r.answer).toEqual({ move: null, speed: null })
    expect(r.errorMessage).toContain('"move" out of set')
  })

  it('flags missing answers and malformed bodies as invalid', () => {
    expect(mapJevAnswers(jevBody({ speed: undefined })).errorMessage).toBe('Missing "speed" answer')
    expect(mapJevAnswers({ model: 'jev-1.13' }).status).toBe('invalid')
    expect(mapJevAnswers(null).status).toBe('invalid')
    expect(mapJevAnswers(jevBody({ move: { type: 'score', score: 1 } })).status).toBe('invalid')
  })

  it('keeps the decision when probabilities are missing (confidence just stays undefined)', () => {
    const r = mapJevAnswers(jevBody({ move: { type: 'choice', choice: 'left', confidence: 0.5 } }))
    expect(r.status).toBe('ok')
    expect(r.answer.move).toBe('left')
    expect(r.answer.moveConfidence).toBeUndefined()
    expect(r.answer.nativeMoveConfidence).toBe(0.5)
  })
})

describe('createJevAdapter', () => {
  it('returns status error without calling OpenCode Zen when the key is missing', async () => {
    const fetch = scriptedFetch([jsonResponse(jevBody())])
    const adapter = createJevAdapter(cfg({ apiKey: undefined }), { fetch })
    expect(adapter.live).toBe(false)
    const r = await adapter.decide(SAMPLE_EASY_OBSERVATION)
    expect(r).toMatchObject({ engine: 'jev', mode: 'live', status: 'error', model: 'jev-1.13-free' })
    expect(r.errorMessage).toContain('OPENCODE_API_KEY')
    expect(fetch.calls).toHaveLength(0)
  })

  it('sends one /v1/systemone call to OpenCode Zen and maps the response', async () => {
    const fetch = scriptedFetch([jsonResponse(jevBody(), 200, { 'x-request-id': 'rq_1' })])
    const r = await createJevAdapter(cfg({ model: 'jev-1.13' }), { fetch }).decide(SAMPLE_EASY_OBSERVATION)

    expect(fetch.calls).toHaveLength(1)
    const call = fetch.calls[0]
    expect(call.url).toBe('https://opencode.ai/zen/v1/systemone')
    expect(call.method).toBe('POST')
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(call.body).toEqual(buildJevRequest(SAMPLE_EASY_OBSERVATION, 'jev-1.13'))

    expect(r.status).toBe('ok')
    expect(r.model).toBe('jev-1.13')
    expect(r.answer.move).toBe('forward')
    expect(r.answer.moveConfidence).toBe(0.85)
    expect(r.usage).toEqual({ inputTokens: 589, outputTokens: 212 })
    expect(r.costUsd).toBeCloseTo(589 * 0.042e-6, 15)
    expect(r.providerLatencyMs).toBeGreaterThanOrEqual(0)
    const raw = r.raw as { request: Record<string, unknown>; response: Record<string, unknown> }
    expect(raw.request).toMatchObject({ model: 'jev-1.13', state: { game_rules: GAME_BRIEF } })
    expect(raw.response).toMatchObject({ model: 'jev-1.13', requestId: 'rq_1', usage: { input_tokens: 589 } })
    expect(raw.response.attempts).toEqual([expect.objectContaining({ attempt: 1, status: 200 })])
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('uses the free model by default (costs $0)', async () => {
    const zenKey = 'zen-test-SECRET-987654'
    const zen = loadConfig({ OPENCODE_API_KEY: zenKey }).jev
    const fetch = scriptedFetch([jsonResponse(jevBody())])
    const adapter = createJevAdapter(zen, { fetch })
    expect(adapter).toMatchObject({ live: true, model: 'jev-1.13-free', provider: 'OpenCode Zen' })

    const r = await adapter.decide(SAMPLE_EASY_OBSERVATION)
    const call = fetch.calls[0]
    expect(call.url).toBe('https://opencode.ai/zen/v1/systemone')
    expect(call.headers.get('authorization')).toBe(`Bearer ${zenKey}`)
    expect(call.body).toEqual(buildJevRequest(SAMPLE_EASY_OBSERVATION, 'jev-1.13-free'))
    expect(r).toMatchObject({ status: 'ok', costUsd: 0 })
    expect(r.answer.move).toBe('forward')
    expect(JSON.stringify(r)).not.toContain(zenKey)
  })

  it('names the OpenCode key when Zen rejects it', async () => {
    const zen = loadConfig({ OPENCODE_API_KEY: 'zen-bad' }).jev
    const fetch = scriptedFetch([jsonResponse({ detail: 'Unauthorized' }, 401)])
    const r = await createJevAdapter(zen, { fetch }).decide(SAMPLE_EASY_OBSERVATION)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toContain('OPENCODE_API_KEY')
  })

  it('retries a 429 once and records both attempts', async () => {
    const fetch = scriptedFetch([jsonResponse({ detail: 'Too many requests' }, 429, RETRY_NOW), jsonResponse(jevBody())])
    const r = await createJevAdapter(cfg(), { fetch }).decide(SAMPLE_EASY_OBSERVATION)
    expect(r.status).toBe('ok')
    expect(fetch.calls).toHaveLength(2)
    const attempts = (r.raw as { response: { attempts: Array<{ status: number }> } }).response.attempts
    expect(attempts.map((a) => a.status)).toEqual([429, 200])
  })

  it('gives up after one retry on repeated 529 (overloaded)', async () => {
    const fetch = scriptedFetch([jsonResponse({ detail: 'Overloaded' }, 529, RETRY_NOW)])
    const r = await createJevAdapter(cfg(), { fetch }).decide(SAMPLE_EASY_OBSERVATION)
    expect(fetch.calls).toHaveLength(2)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toBe('OpenCode Zen (Jev) 529: overloaded (after 2 attempts)')
  })

  it('does not retry 401 / 422 / 500 and reports readable messages', async () => {
    const unauthorized = scriptedFetch([jsonResponse({ detail: 'Invalid API key' }, 401)])
    const r401 = await createJevAdapter(cfg(), { fetch: unauthorized }).decide(SAMPLE_EASY_OBSERVATION)
    expect(unauthorized.calls).toHaveLength(1)
    expect(r401.status).toBe('error')
    expect(r401.errorMessage).toMatch(/^OpenCode Zen \(Jev\) 401/)

    const detail = [{ loc: ['body', 'questions', 'move', 'criteria'], msg: 'field required', type: 'missing' }]
    const invalid = scriptedFetch([jsonResponse({ detail }, 422)])
    const r422 = await createJevAdapter(cfg(), { fetch: invalid }).decide(SAMPLE_EASY_OBSERVATION)
    expect(invalid.calls).toHaveLength(1)
    expect(r422.errorMessage).toContain('OpenCode Zen (Jev) 422')
    expect(r422.errorMessage).toContain('questions.move.criteria: field required')

    const server = scriptedFetch([jsonResponse({ detail: 'boom' }, 500)])
    const r500 = await createJevAdapter(cfg(), { fetch: server }).decide(SAMPLE_EASY_OBSERVATION)
    expect(server.calls).toHaveLength(1)
    expect(r500.errorMessage).toBe('OpenCode Zen (Jev) 500: boom')
  })

  it('retries a network failure once, then reports it', async () => {
    const fetch = scriptedFetch([new TypeError('fetch failed')])
    const r = await createJevAdapter(cfg(), { fetch }).decide(SAMPLE_EASY_OBSERVATION)
    expect(fetch.calls).toHaveLength(2)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toMatch(/^OpenCode Zen \(Jev\) network error \(after 2 attempts\)/)
  })

  it('reports timeouts without retrying them', async () => {
    const fetch = scriptedFetch([hangUntilAborted])
    const r = await createJevAdapter(cfg({ timeoutMs: 30 }), { fetch }).decide(SAMPLE_EASY_OBSERVATION)
    expect(fetch.calls).toHaveLength(1)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toBe('OpenCode Zen (Jev) timeout after 30 ms')
  })

  it('aborts the upstream call when the signal fires', async () => {
    const fetch = scriptedFetch([hangUntilAborted])
    const controller = new AbortController()
    const pending = createJevAdapter(cfg(), { fetch }).decide(SAMPLE_EASY_OBSERVATION, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const r = await pending
    expect(r.status).toBe('error')
    expect(r.errorMessage).toMatch(/aborted/)
  })

  it('maps an out-of-set answer from the API to status invalid with usage kept', async () => {
    const fetch = scriptedFetch([jsonResponse(jevBody({ speed: { type: 'choice', choice: 'warp', confidence: 1, probabilities: { warp: 1 } } }))])
    const r = await createJevAdapter(cfg(), { fetch }).decide(SAMPLE_EASY_OBSERVATION)
    expect(r.status).toBe('invalid')
    expect(r.answer).toEqual({ move: null, speed: null })
    expect(r.usage?.inputTokens).toBe(589)
  })
})
