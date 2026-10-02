/**
 * Test helpers (no network): a scripted fetch that records what the SDKs send.
 */
import type { FetchLike } from './adapters/common.ts'

export interface RecordedCall {
  url: string
  method: string
  headers: Headers
  body: unknown
}

type Step = Response | Error | ((call: RecordedCall, init?: RequestInit) => Response | Promise<Response>)

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Rejects like a real fetch when the request's signal aborts; otherwise never settles. */
export function hangUntilAborted(_call: RecordedCall, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    const fail = () => reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'))
    if (signal?.aborted) return fail()
    signal?.addEventListener('abort', fail, { once: true })
  })
}

/** Plays `steps` in order (the last one repeats). Errors are thrown as network failures. */
export function scriptedFetch(steps: Step[]): FetchLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const rawBody = init?.body
    let body: unknown = rawBody
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = rawBody
      }
    }
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body }
    calls.push(call)
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]
    if (step instanceof Error) throw step
    if (typeof step === 'function') return step(call, init)
    return step.clone()
  }
  return Object.assign(fn, { calls })
}
