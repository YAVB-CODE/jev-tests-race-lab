/**
 * Live charts for the lane comparison (Recharts 3, animations off so they keep up with streaming records).
 *  (a) latency per decision  (b) hit rate over the race  (c) reliability diagram
 *  (d) race-time breakdown   (e) outcome distribution
 * Lane colors are the categorical series; every chart has a legend, a tooltip and a table twin.
 */
import type { ComparisonProps } from '../../shared/contracts.ts'
import { useBothMetrics } from './hooks.ts'
import { HitRateChart } from './charts/HitRateChart.tsx'
import { LatencyChart } from './charts/LatencyChart.tsx'
import { OutcomeChart } from './charts/OutcomeChart.tsx'
import { ReliabilityChart } from './charts/ReliabilityChart.tsx'
import { TimeBreakdownChart } from './charts/TimeBreakdownChart.tsx'

export function ChartsPanel({ lanes }: ComparisonProps) {
  const metrics = useBothMetrics(lanes)
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <LatencyChart lanes={lanes} metrics={metrics} className="h-full" />
      <HitRateChart lanes={lanes} metrics={metrics} className="h-full" />
      <ReliabilityChart metrics={metrics} className="h-full" />
      <div className="flex min-w-0 flex-col gap-4">
        <OutcomeChart metrics={metrics} className="flex-1" />
        <TimeBreakdownChart metrics={metrics} className="flex-1" />
      </div>
    </div>
  )
}
