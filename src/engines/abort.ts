/** Abort helpers shared by the engines. */

export function createAbortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/**
 * Resolves after `ms`. Rejects with an AbortError as soon as `signal` aborts (clearing the timer),
 * or immediately if it is already aborted. A non-positive delay resolves right away.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError())
      return
    }
    if (ms <= 0) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(createAbortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
