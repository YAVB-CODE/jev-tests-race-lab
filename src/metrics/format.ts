/** Number formatting shared by the metrics UI and the comparison rows. Decimal point, no Intl dependence. */

export const DASH = '—'

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Fraction (0..1) → "62.5%". */
export function fmtPercent(v: number | null | undefined, digits = 1): string {
  return finite(v) ? `${(v * 100).toFixed(digits)}%` : DASH
}

/** Milliseconds → "184 ms" / "1.14 s" / "12.3 s". */
export function fmtMs(ms: number | null | undefined): string {
  if (!finite(ms)) return DASH
  const abs = Math.abs(ms)
  if (abs < 1000) return `${Math.round(ms)} ms`
  if (abs < 10_000) return `${(ms / 1000).toFixed(2)} s`
  return `${(ms / 1000).toFixed(1)} s`
}

/** Milliseconds → "m:ss.t" (lap and race clocks). */
export function fmtClock(ms: number | null | undefined): string {
  if (!finite(ms)) return DASH
  // Round to tenths BEFORE splitting, so 119_960 ms reads "2:00.0" and not "1:60.0".
  const tenths = Math.round(Math.max(0, ms) / 100)
  const minutes = Math.floor(tenths / 600)
  const s = ((tenths - minutes * 600) / 10).toFixed(1).padStart(4, '0')
  return `${minutes}:${s}`
}

/** USD with enough precision for sub-cent amounts. */
export function fmtUsd(v: number | null | undefined): string {
  if (!finite(v)) return DASH
  if (v === 0) return '$0.00'
  const abs = Math.abs(v)
  if (abs >= 1) return `$${v.toFixed(2)}`
  if (abs >= 0.01) return `$${v.toFixed(3)}`
  // Sub-cent amounts (e.g. Jev's ~$0.00004 per decision): keep 2 significant digits instead of rounding to $0.0000.
  return `$${v.toPrecision(2)}`
}

/** Integer with thousands separators ("12,345"). */
export function fmtInt(v: number | null | undefined): string {
  return finite(v) ? Math.round(v).toLocaleString('en-US') : DASH
}

/** Compact count: 842 / 12.3k / 1.2M. */
export function fmtCompact(v: number | null | undefined): string {
  if (!finite(v)) return DASH
  const abs = Math.abs(v)
  if (abs < 1000) return String(Math.round(v))
  if (abs < 1_000_000) return `${(v / 1000).toFixed(abs < 10_000 ? 2 : 1)}k`
  return `${(v / 1_000_000).toFixed(2)}M`
}

export function fmtNumber(v: number | null | undefined, digits = 1): string {
  return finite(v) ? v.toFixed(digits) : DASH
}

/** Probability-style score (Brier, ECE) → "0.123". */
export function fmtScore(v: number | null | undefined): string {
  return finite(v) ? v.toFixed(3) : DASH
}

/** Signed percentage points from a difference of fractions: 0.041 → "+4.1 pp", -0.05 → "−5.0 pp". */
export function fmtPp(deltaFraction: number): string {
  const pp = deltaFraction * 100
  const sign = pp > 0 ? '+' : pp < 0 ? '−' : ''
  return `${sign}${Math.abs(pp).toFixed(1)} pp`
}
