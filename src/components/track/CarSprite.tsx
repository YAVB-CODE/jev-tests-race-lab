import { memo } from 'react'
import { gradId } from './geometry.ts'

interface CarSpriteProps {
  /** CSS color of the lane (var(--color-gpt) / var(--color-jev)). */
  accent: string
  uid: string
}

/** Car outline, centered on (0, 0), nose pointing up (North). Length ≈ 0.46, width ≈ 0.22 grid units. */
const BODY =
  'M0 -0.232C0.062 -0.232 0.095 -0.2 0.104 -0.135L0.11 0.095C0.11 0.172 0.082 0.225 0 0.225C-0.082 0.225 -0.11 0.172 -0.11 0.095L-0.104 -0.135C-0.095 -0.2 -0.062 -0.232 0 -0.232Z'

/**
 * Top-down car sprite (body in the lane accent, windshield, 4 wheels, headlights + soft beams).
 * Memoized: it never changes after mount except for the accent.
 */
export const CarSprite = memo(function CarSprite({ accent, uid }: CarSpriteProps) {
  const gloss = gradId(uid, 'car-gloss')
  const beam = gradId(uid, 'car-beam')
  return (
    <g>
      <defs>
        <linearGradient id={gloss} x1="-0.11" y1="0" x2="0.11" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.34" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="1" stopColor="#000" stopOpacity="0.32" />
        </linearGradient>
        <linearGradient id={beam} x1="0" y1="-0.215" x2="0" y2="-0.66" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.26" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Headlight beams on the road */}
      <path d="M-0.085 -0.215L-0.2 -0.66L0.2 -0.66L0.085 -0.215Z" fill={`url(#${beam})`} />

      {/* Soft drop shadow */}
      <path d={BODY} transform="translate(0.022 0.03)" className="fill-oil" fillOpacity="0.45" />

      {/* Wheels */}
      <g className="fill-oil stroke-asphalt-edge" strokeWidth="0.008">
        <rect x="-0.146" y="-0.17" width="0.054" height="0.1" rx="0.018" />
        <rect x="0.092" y="-0.17" width="0.054" height="0.1" rx="0.018" />
        <rect x="-0.146" y="0.082" width="0.054" height="0.105" rx="0.018" />
        <rect x="0.092" y="0.082" width="0.054" height="0.105" rx="0.018" />
      </g>

      {/* Body */}
      <path d={BODY} style={{ fill: accent }} />
      <path d={BODY} fill={`url(#${gloss})`} />
      <path d={BODY} fill="none" className="stroke-surface" strokeOpacity="0.7" strokeWidth="0.012" />
      <rect x="-0.013" y="-0.228" width="0.026" height="0.45" className="fill-kerb-b" fillOpacity="0.2" />

      {/* Rear wing */}
      <rect x="-0.098" y="0.188" width="0.196" height="0.024" rx="0.008" className="fill-surface" fillOpacity="0.88" />

      {/* Cabin: roof, windshield, rear window */}
      <rect x="-0.074" y="-0.004" width="0.148" height="0.07" rx="0.02" className="fill-surface" fillOpacity="0.22" />
      <path d="M-0.07 -0.072Q0 -0.104 0.07 -0.072L0.084 -0.008L-0.084 -0.008Z" className="fill-surface" fillOpacity="0.92" />
      <path d="M-0.052 -0.064Q-0.02 -0.078 0.002 -0.078L-0.03 -0.016L-0.07 -0.016Z" className="fill-info" fillOpacity="0.4" />
      <path d="M-0.062 0.07L0.062 0.07L0.055 0.108Q0 0.12 -0.055 0.108Z" className="fill-surface" fillOpacity="0.9" />

      {/* Headlights and taillights */}
      <circle cx="-0.072" cy="-0.205" r="0.034" className="fill-warn" fillOpacity="0.28" />
      <circle cx="0.072" cy="-0.205" r="0.034" className="fill-warn" fillOpacity="0.28" />
      <rect x="-0.092" y="-0.22" width="0.05" height="0.02" rx="0.008" className="fill-kerb-b" />
      <rect x="0.042" y="-0.22" width="0.05" height="0.02" rx="0.008" className="fill-kerb-b" />
      <rect x="-0.088" y="0.214" width="0.044" height="0.012" rx="0.005" className="fill-kerb-a" />
      <rect x="0.044" y="0.214" width="0.044" height="0.012" rx="0.005" className="fill-kerb-a" />

      {/* Crash damage tint (shown only while crashed, see track.css) */}
      <path d={BODY} className="tv-damage fill-bad" />
    </g>
  )
})
