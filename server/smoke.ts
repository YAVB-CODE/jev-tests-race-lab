/**
 * Live smoke test (real API calls, costs a fraction of a cent).
 *
 *   npx tsx server/smoke.ts            # one easy observation per provider
 *   npx tsx server/smoke.ts --runs 3   # repeat (latency spread; the first call includes TLS setup)
 *
 * Providers without a key are skipped. Calls run sequentially so latencies don't interfere.
 */
import path from 'node:path'
import dotenv from 'dotenv'
import type { DecisionResult, Observation } from '../src/shared/contracts.ts'
import { createAdapters } from './adapters/index.ts'
import { loadConfig } from './env.ts'
import {
  SAMPLE_EASY_EXPECTED,
  SAMPLE_EASY_OBSERVATION,
  SAMPLE_EASY_OIL_EXPECTED,
  SAMPLE_EASY_OIL_OBSERVATION,
} from './fixtures.ts'

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env'), quiet: true })

const runsArg = process.argv.indexOf('--runs')
const runs = runsArg > -1 ? Math.max(1, Number(process.argv[runsArg + 1]) || 1) : 1

const cases: Array<{ name: string; observation: Observation; expected: { move: string; speed: string } }> = [
  { name: 'easy/straight', observation: SAMPLE_EASY_OBSERVATION, expected: SAMPLE_EASY_EXPECTED },
  { name: 'easy/oil', observation: SAMPLE_EASY_OIL_OBSERVATION, expected: SAMPLE_EASY_OIL_EXPECTED },
]

function pct(value: number | undefined): string {
  return value === undefined ? '  -' : `${Math.round(value * 100)}%`.padStart(4)
}

function row(caseName: string, expected: { move: string; speed: string }, r: DecisionResult, wallMs: number): string {
  const a = r.answer
  const decision = a.move ? `${a.move}/${a.speed}` : '—'
  const verdict = r.status !== 'ok' ? r.status.toUpperCase() : a.move === expected.move && a.speed === expected.speed ? 'HIT' : 'MISS'
  const attempts = ((r.raw?.response as { attempts?: unknown[] } | undefined)?.attempts ?? []).length
  return [
    r.engine.padEnd(4),
    r.model.padEnd(26),
    caseName.padEnd(14),
    decision.padEnd(15),
    verdict.padEnd(7),
    `conf ${pct(a.moveConfidence)}/${pct(a.speedConfidence)}`,
    `provider ${String(r.providerLatencyMs ?? '-').padStart(5)}ms`,
    `wall ${String(Math.round(wallMs)).padStart(5)}ms`,
    `tok ${r.usage ? `${r.usage.inputTokens}/${r.usage.outputTokens}` : '-'}`.padEnd(13),
    `$${r.costUsd?.toFixed(7) ?? '-'}`,
    attempts > 1 ? `attempts=${attempts}` : '',
    r.errorMessage ? `· ${r.errorMessage}` : '',
  ].join('  ')
}

async function main() {
  const config = loadConfig()
  const adapters = createAdapters(config)
  console.log(`Jev Race Lab smoke · runs=${runs} · expected: straight=${SAMPLE_EASY_EXPECTED.move}/${SAMPLE_EASY_EXPECTED.speed}, oil=${SAMPLE_EASY_OIL_EXPECTED.move}/${SAMPLE_EASY_OIL_EXPECTED.speed}`)
  for (const engine of ['gpt', 'jev'] as const) {
    const adapter = adapters[engine]
    if (!adapter.live) {
      console.log(`${engine.padEnd(4)}  skipped: no ${engine === 'gpt' ? 'OPENAI_API_KEY' : 'OPENCODE_API_KEY'} in .env`)
      continue
    }
    for (let i = 0; i < runs; i++) {
      for (const c of cases) {
        const t0 = performance.now()
        const result = await adapter.decide(c.observation, { signal: AbortSignal.timeout(30_000) })
        console.log(row(c.name, c.expected, result, performance.now() - t0))
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error('smoke failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
