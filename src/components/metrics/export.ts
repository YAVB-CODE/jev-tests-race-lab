/**
 * Run export. `buildRunJson` / `buildRunCsv` are pure (testable); `exportRunJson` / `exportRunCsv`
 * additionally trigger a browser download through a Blob + object URL.
 */
import type { DecisionRecord, EngineId, LaneData } from '../../shared/contracts.ts'
import { compareLanes, computeMetrics } from '../../metrics/index.ts'
import { ENGINE_IDS } from './lanes.ts'

type Lanes = Record<EngineId, LaneData>

export interface RunExportMeta {
  [key: string]: unknown
}

export function buildRunJson(lanes: Lanes, meta?: RunExportMeta, now: Date = new Date()): string {
  const metrics = {
    gpt: computeMetrics(lanes.gpt.records, lanes.gpt.snapshot),
    jev: computeMetrics(lanes.jev.records, lanes.jev.snapshot),
  }
  const payload = {
    app: 'jev-race-lab',
    exportedAt: now.toISOString(),
    // A run with any SIMULADO lane is not a measurement; make that explicit in the file itself.
    validForEfficacy: ENGINE_IDS.every((id) => lanes[id].mode === 'live'),
    meta: meta ?? {},
    comparison: compareLanes(metrics.gpt, metrics.jev),
    lanes: Object.fromEntries(
      ENGINE_IDS.map((id) => [
        id,
        {
          engine: id,
          label: lanes[id].label,
          mode: lanes[id].mode,
          metrics: metrics[id],
          snapshot: lanes[id].snapshot,
          records: lanes[id].records,
        },
      ]),
    ),
  }
  return JSON.stringify(payload, null, 2)
}

// ───────────────────────────────── CSV ─────────────────────────────────

const CSV_HEADER = [
  'lane',
  'mode',
  'model',
  'decision',
  'lap',
  'cell_x',
  'cell_y',
  'heading',
  'is_junction',
  'move',
  'speed',
  'best_move',
  'best_speed',
  'move_outcome',
  'speed_outcome',
  'hit',
  'error',
  'status',
  'move_confidence',
  'speed_confidence',
  'latency_ms',
  'provider_latency_ms',
  'penalty_ms',
  'applied_move',
  'applied_speed',
  'race_time_at_start_ms',
  'input_tokens',
  'output_tokens',
  'cost_usd',
  'cost_estimated',
  'error_message',
] as const

type Cell = string | number | boolean | null | undefined

/** RFC 4180 quoting, plus a leading apostrophe on text that spreadsheets would evaluate as a formula. */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvRow(lane: LaneData, r: DecisionRecord): string {
  const best = r.oracle.bestMove
  const cells: Cell[] = [
    lane.engine,
    lane.mode,
    r.result.model,
    r.index + 1,
    r.lap,
    r.cell.x,
    r.cell.y,
    r.heading,
    r.oracle.isJunction,
    r.result.answer.move,
    r.result.answer.speed,
    best,
    r.oracle.speedByMove[best],
    r.moveOutcome,
    r.speedOutcome,
    r.hit,
    r.error,
    r.result.status,
    r.result.answer.moveConfidence,
    r.result.answer.speedConfidence,
    Math.round(r.latencyMs),
    r.result.providerLatencyMs,
    r.penaltyMs,
    r.appliedMove,
    r.appliedSpeed,
    Math.round(r.raceTimeAtStartMs),
    r.result.usage?.inputTokens,
    r.result.usage?.outputTokens,
    r.result.costUsd,
    r.result.estimated,
    r.result.errorMessage,
  ]
  return cells.map(csvCell).join(',')
}

/** One row per decision, both lanes, ordered by lane then decision. */
export function buildRunCsv(lanes: Lanes): string {
  const lines: string[] = [CSV_HEADER.join(',')]
  for (const id of ENGINE_IDS) {
    for (const r of lanes[id].records) lines.push(csvRow(lanes[id], r))
  }
  return lines.join('\r\n') + '\r\n'
}

// ─────────────────────────────── Download ───────────────────────────────

function timestamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

function download(filename: string, mime: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke after the click has been dispatched; some browsers cancel the download if it happens synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Download the full run (computed metrics, comparison, snapshots and every record) as JSON. */
export function exportRunJson(lanes: Lanes, meta?: RunExportMeta): void {
  const now = new Date()
  download(`jev-race-lab-${timestamp(now)}.json`, 'application/json', buildRunJson(lanes, meta, now))
}

/** Download one row per decision (both lanes) as CSV. */
export function exportRunCsv(lanes: Lanes): void {
  download(`jev-race-lab-${timestamp(new Date())}.csv`, 'text/csv', buildRunCsv(lanes))
}
