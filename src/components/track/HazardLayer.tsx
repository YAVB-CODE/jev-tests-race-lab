import { memo, useMemo } from 'react'
import type { Hazard } from '../../shared/contracts.ts'
import { blobPath, gradId, hash2 } from './geometry.ts'

interface HazardLayerProps {
  hazards: Hazard[]
  /** Part of the React key: a new lap regenerates the hazards, so they re-mount and replay their entrance. */
  lap: number
  uid: string
}

function sameHazards(a: Hazard[], b: Hazard[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((h, i) => h.kind === b[i]!.kind && h.cell.x === b[i]!.cell.x && h.cell.y === b[i]!.cell.y)
}

/** Dark glossy puddle. Static shape, deterministic per cell. */
function Oil({ x, y, uid }: { x: number; y: number; uid: string }) {
  const art = useMemo(() => {
    const radius = 0.255
    return {
      blob: blobPath(x, y, radius, 40),
      ring: blobPath(x, y, radius * 0.78, 40),
      rot: (hash2(x, y, 7) - 0.5) * 70,
    }
  }, [x, y])
  return (
    <g transform={`translate(${x + 0.5} ${y + 0.5}) rotate(${art.rot.toFixed(1)})`}>
      <path d={art.blob} className="fill-oil stroke-asphalt-edge" strokeOpacity="0.55" strokeWidth="0.012" />
      <path d={art.blob} fill={`url(#${gradId(uid, 'oil-gloss')})`} />
      <path d={art.ring} className="stroke-gpt" strokeOpacity="0.32" strokeWidth="0.012" fill="none" strokeDasharray="0.3 0.12" />
      <path
        d={art.ring}
        transform="translate(0.018 0.012) scale(0.82)"
        className="stroke-jev"
        strokeOpacity="0.3"
        strokeWidth="0.012"
        fill="none"
        strokeDasharray="0.22 0.16"
      />
      <ellipse cx="-0.085" cy="-0.085" rx="0.075" ry="0.032" transform="rotate(-32 -0.085 -0.085)" className="fill-kerb-b" fillOpacity="0.38" />
      <ellipse cx="0.07" cy="0.07" rx="0.03" ry="0.012" transform="rotate(-32 0.07 0.07)" className="fill-kerb-b" fillOpacity="0.2" />
    </g>
  )
}

/** Small top-down traffic cone: square base, orange body, white stripe, tip. */
function Cone({ x, y, rot }: { x: number; y: number; rot: number }) {
  return (
    <g transform={`translate(${x.toFixed(3)} ${y.toFixed(3)}) rotate(${rot.toFixed(1)})`}>
      <ellipse cx="0.02" cy="0.028" rx="0.085" ry="0.07" className="fill-oil" fillOpacity="0.4" />
      <rect x="-0.08" y="-0.08" width="0.16" height="0.16" rx="0.03" className="fill-cone" />
      <rect x="-0.08" y="-0.08" width="0.16" height="0.16" rx="0.03" className="fill-oil" fillOpacity="0.28" />
      <circle r="0.062" className="fill-cone" />
      <circle r="0.043" className="stroke-kerb-b" strokeWidth="0.022" fill="none" />
      <circle r="0.018" className="fill-cone" />
      <circle cx="-0.02" cy="-0.023" r="0.01" className="fill-kerb-b" fillOpacity="0.7" />
    </g>
  )
}

function Cones({ x, y }: { x: number; y: number }) {
  const count = hash2(x, y, 11) > 0.45 ? 3 : 2
  const spread = 0.17
  const base = hash2(x, y, 12) * Math.PI * 2
  const items = Array.from({ length: count }, (_, i) => {
    const a = base + (i / count) * Math.PI * 2
    const r = spread * (0.75 + hash2(x, y, 20 + i) * 0.4)
    return {
      x: x + 0.5 + Math.cos(a) * r,
      y: y + 0.5 + Math.sin(a) * r,
      rot: (hash2(x, y, 30 + i) - 0.5) * 40,
    }
  })
  return (
    <g>
      {items.map((c, i) => (
        <Cone key={i} {...c} />
      ))}
    </g>
  )
}

/**
 * Hazards of the current lap. Updates only when the hazard set / lap changes (low frequency),
 * and each hazard fades in on mount (see track.css).
 */
export const HazardLayer = memo(
  function HazardLayer({ hazards, lap, uid }: HazardLayerProps) {
    return (
      <g>
        <defs>
          <radialGradient id={gradId(uid, 'oil-gloss')} cx="0.35" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#fff" stopOpacity="0.2" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="0.04" />
            <stop offset="1" stopColor="#000" stopOpacity="0.45" />
          </radialGradient>
        </defs>
        {hazards.map((h, i) => (
          <g
            key={`${lap}:${h.kind}:${h.cell.x},${h.cell.y}`}
            className={h.kind === 'oil' ? 'tv-hazard tv-oil' : 'tv-hazard tv-cones'}
            style={{ animationDelay: `${Math.min(i, 8) * 55}ms` }}
          >
            {h.kind === 'oil' ? <Oil x={h.cell.x} y={h.cell.y} uid={uid} /> : <Cones x={h.cell.x} y={h.cell.y} />}
          </g>
        ))}
      </g>
    )
  },
  (a, b) => a.lap === b.lap && a.uid === b.uid && sameHazards(a.hazards, b.hazards),
)
