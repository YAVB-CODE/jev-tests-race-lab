import { useMemo } from 'react'
import type { EngineId, LaneData } from '../../shared/contracts.ts'
import { computeMetrics } from '../../metrics/index.ts'
import type { EngineMetrics } from '../../metrics/index.ts'

/**
 * Memoized metrics for one lane. `records.length` is a dependency on purpose: the store may append in place
 * (same array identity), and the snapshot changes on every phase / lap change.
 */
export function useLaneMetrics(lane: LaneData): EngineMetrics {
  const { records, snapshot } = lane
  const length = records.length
  return useMemo(() => {
    void length // cache key: recompute when records were appended in place
    return computeMetrics(records, snapshot)
  }, [records, length, snapshot])
}

export function useBothMetrics(lanes: Record<EngineId, LaneData>): Record<EngineId, EngineMetrics> {
  const gpt = useLaneMetrics(lanes.gpt)
  const jev = useLaneMetrics(lanes.jev)
  return useMemo(() => ({ gpt, jev }), [gpt, jev])
}
