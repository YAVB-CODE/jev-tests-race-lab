import type { ServerConfig } from '../env.ts'
import type { Adapters, FetchLike } from './common.ts'
import { createGptAdapter } from './gpt.ts'
import { createJevAdapter } from './jev.ts'

export type { Adapters, AttemptLog, DecideOptions, EngineAdapter, FetchLike } from './common.ts'
export { createGptAdapter } from './gpt.ts'
export { createJevAdapter } from './jev.ts'

export function createAdapters(config: ServerConfig, deps: { fetch?: FetchLike } = {}): Adapters {
  return {
    gpt: createGptAdapter(config.gpt, deps),
    jev: createJevAdapter(config.jev, deps),
  }
}
