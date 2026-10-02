export {
  CALIBRATION_BINS,
  LOW_CONFIDENCE_THRESHOLD,
  MOVE_OUTCOMES,
  SPEED_OUTCOMES,
  computeCalibration,
  computeMetrics,
  cumulativeHitRate,
  rollingHitRate,
} from './compute.ts'
export type {
  CalibrationMetrics,
  EngineMetrics,
  ReliabilityBin,
  SeriesPoint,
  TimeBreakdown,
} from './compute.ts'
export { GROUP_LABELS, compareHeadline, compareLanes } from './compare.ts'
export type { ComparisonGroup, ComparisonRow, Winner } from './compare.ts'
export { EMPTY_LATENCY, latencyStats, mean, percentile, safeDiv } from './stats.ts'
export type { LatencyStats } from './stats.ts'
export {
  DASH,
  fmtClock,
  fmtCompact,
  fmtInt,
  fmtMs,
  fmtNumber,
  fmtPercent,
  fmtPp,
  fmtScore,
  fmtUsd,
} from './format.ts'
