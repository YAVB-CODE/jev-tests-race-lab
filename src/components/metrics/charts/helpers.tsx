/** Axis styling, tick formatters and series helpers shared by the charts (no components here). */
import { Rectangle } from 'recharts'
import type { BarShapeProps } from 'recharts'

export const AXIS_TICK = { fill: 'var(--color-ink-faint)', fontSize: 11, fontFamily: 'var(--font-mono)' } as const
export const AXIS_LINE = { stroke: 'var(--color-line)' } as const
export const GRID_STROKE = 'var(--color-line)'
export const SURFACE = 'var(--color-panel)'
export const MAX_POINTS = 500

/** Keep a long series light: at most `max` points (evenly strided), always keeping the last one. */
export function strideSample<T>(rows: T[], max = MAX_POINTS): T[] {
  if (rows.length <= max) return rows
  const stride = Math.ceil(rows.length / max)
  const out = rows.filter((_, i) => i % stride === 0)
  const last = rows[rows.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

export const pctTick = (v: number): string => `${Math.round(v * 100)}%`
export const PCT_TICKS = [0, 0.25, 0.5, 0.75, 1]

export function msTick(v: number): string {
  if (v >= 1000) return `${Number((v / 1000).toFixed(1))} s`
  return `${Math.round(v)} ms`
}

/** Square stacked segments, except the last non-empty one of each stack, which gets the 4px rounded data end. */
export function stackEndShape(keys: readonly string[], index: number) {
  return function StackEndShape(props: BarShapeProps) {
    const row = props.payload as Record<string, unknown> | undefined
    const isEnd = !row || !keys.slice(index + 1).some((k) => Number(row[k]) > 0)
    return <Rectangle {...props} radius={isEnd ? [0, 4, 4, 0] : 0} />
  }
}
