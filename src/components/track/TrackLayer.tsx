import { memo, useMemo } from 'react'
import type { TrackDefinition } from '../../shared/contracts.ts'
import { ROAD, buildTrackArt, gradId } from './geometry.ts'

interface TrackLayerProps {
  track: TrackDefinition
  /** Sanitized unique id prefix (several TrackViews live on the same page). */
  uid: string
}

/**
 * Static layer: grass, road, kerbs, start/finish line and checkpoint markers.
 * Memoized — only re-rendered when `track` (or the id prefix) changes, never per frame.
 */
export const TrackLayer = memo(function TrackLayer({ track, uid }: TrackLayerProps) {
  const art = useMemo(() => buildTrackArt(track), [track])
  const { width: W, height: H } = track
  const { shoulder, edge, asphalt, kerbs, centerLine, checkpoints, bushes } = art
  const id = (name: string) => gradId(uid, name)

  const cols = 8
  const checkerSize = (ROAD.EDGE * 2) / cols

  return (
    <g>
      <defs>
        <pattern id={id('tufts')} width="0.8" height="0.8" patternUnits="userSpaceOnUse">
          <path
            d="M0.1 0.2l0.012-0.05M0.13 0.2l0.02-0.045M0.5 0.45l-0.01-0.05M0.53 0.46l0.02-0.04M0.3 0.7l0.01-0.045M0.68 0.12l-0.012-0.04M0.7 0.62l0.016-0.04"
            className="stroke-ok"
            strokeOpacity="0.2"
            strokeWidth="0.014"
            strokeLinecap="round"
            fill="none"
          />
        </pattern>
        <pattern id={id('flowers')} width="1.37" height="1.13" patternUnits="userSpaceOnUse">
          <circle cx="0.31" cy="0.84" r="0.014" className="fill-warn" fillOpacity="0.22" />
          <circle cx="1.02" cy="0.31" r="0.012" className="fill-info" fillOpacity="0.2" />
          <circle cx="0.78" cy="0.62" r="0.01" className="fill-kerb-b" fillOpacity="0.16" />
        </pattern>
        <pattern id={id('mow')} width="2" height="1" patternUnits="userSpaceOnUse">
          <rect x="1" width="1" height="1" className="fill-ok" fillOpacity="0.035" />
        </pattern>
      </defs>

      {/* Grass */}
      <rect width={W} height={H} className="fill-grass" />
      <rect width={W} height={H} fill={`url(#${id('mow')})`} />
      <rect width={W} height={H} fill={`url(#${id('tufts')})`} />
      <rect width={W} height={H} fill={`url(#${id('flowers')})`} />
      {bushes.map((b) => (
        <g key={`${b.x.toFixed(2)},${b.y.toFixed(2)}`}>
          <circle cx={b.x + 0.025} cy={b.y + 0.04} r={b.r} className="fill-surface" fillOpacity="0.5" />
          <circle cx={b.x} cy={b.y} r={b.r} className="fill-ok" fillOpacity={0.1 + b.variant * 0.03} />
          <circle cx={b.x - b.r * 0.25} cy={b.y - b.r * 0.28} r={b.r * 0.55} className="fill-ok" fillOpacity="0.1" />
        </g>
      ))}

      {/* Road: shoulder > white edge line > asphalt (concentric layers, one path per layer = no seams) */}
      <path d={shoulder.stroke} className="stroke-asphalt-edge" strokeWidth={ROAD.SHOULDER * 2} fill="none" />
      <path d={shoulder.fill} className="fill-asphalt-edge" />
      <path d={edge.stroke} className="stroke-kerb-b" strokeOpacity="0.8" strokeWidth={ROAD.EDGE * 2} fill="none" />
      <path d={edge.fill} className="fill-kerb-b" fillOpacity="0.8" />
      <path d={asphalt.stroke} className="stroke-asphalt" strokeWidth={ROAD.ASPHALT * 2} fill="none" />
      <path d={asphalt.fill} className="fill-asphalt" />
      <path
        d={centerLine}
        className="stroke-kerb-b"
        strokeOpacity="0.28"
        strokeWidth="0.018"
        strokeDasharray="0.07 0.0967"
        fill="none"
      />

      {/* Kerbs on curves: red base + white dashes */}
      <path d={kerbs.inner} className="stroke-kerb-a" strokeWidth={ROAD.KERB} fill="none" />
      <path
        d={kerbs.inner}
        className="stroke-kerb-b"
        strokeWidth={ROAD.KERB}
        strokeDasharray={`${kerbs.innerDash} ${kerbs.innerDash}`}
        fill="none"
      />
      <path d={kerbs.outer} className="stroke-kerb-a" strokeWidth={ROAD.KERB} fill="none" />
      <path
        d={kerbs.outer}
        className="stroke-kerb-b"
        strokeWidth={ROAD.KERB}
        strokeDasharray={`${kerbs.outerDash} ${kerbs.outerDash}`}
        fill="none"
      />

      {/* Checkpoints */}
      {checkpoints.map((c) => (
        <g key={c.index}>
          {c.gate.type === 'band' ? (
            <g transform={`translate(${c.cx} ${c.cy}) rotate(${c.gate.angle})`}>
              <rect x={-ROAD.ASPHALT} y="-0.035" width={ROAD.ASPHALT * 2} height="0.07" className="fill-info" fillOpacity="0.42" />
              <circle cx={-ROAD.EDGE} r="0.035" className="fill-info" />
              <circle cx={ROAD.EDGE} r="0.035" className="fill-info" />
            </g>
          ) : (
            <circle
              cx={c.cx}
              cy={c.cy}
              r="0.27"
              className="stroke-info"
              strokeOpacity="0.6"
              strokeWidth="0.03"
              strokeDasharray="0.09 0.07"
              fill="none"
            />
          )}
          <circle cx={c.badge.x + 0.015} cy={c.badge.y + 0.03} r="0.19" className="fill-surface" fillOpacity="0.55" />
          <circle cx={c.badge.x} cy={c.badge.y} r="0.19" className="fill-panel stroke-info" strokeWidth="0.03" />
          <text
            x={c.badge.x}
            y={c.badge.y}
            dy="0.085"
            textAnchor="middle"
            fontSize="0.24"
            fontWeight="700"
            className="fill-ink font-mono"
          >
            {c.index + 1}
          </text>
        </g>
      ))}

      {/* Start / finish: checkered line across the road, perpendicular to the start heading */}
      <g transform={`translate(${art.startCenter.x} ${art.startCenter.y}) rotate(${art.startAngle})`}>
        <rect
          x={-ROAD.EDGE}
          y={-checkerSize}
          width={ROAD.EDGE * 2}
          height={checkerSize * 2}
          className="fill-oil"
        />
        {Array.from({ length: cols * 2 }, (_, i) => {
          const col = i % cols
          const row = Math.floor(i / cols)
          if ((col + row) % 2 !== 0) return null
          return (
            <rect
              key={i}
              x={-ROAD.EDGE + col * checkerSize}
              y={-checkerSize + row * checkerSize}
              width={checkerSize}
              height={checkerSize}
              className="fill-kerb-b"
            />
          )
        })}
        <rect
          x={-ROAD.EDGE}
          y={-checkerSize}
          width={ROAD.EDGE * 2}
          height={checkerSize * 2}
          fill="none"
          className="stroke-oil"
          strokeOpacity="0.5"
          strokeWidth="0.008"
        />
      </g>
    </g>
  )
})
