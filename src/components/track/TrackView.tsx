import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  CarPhase,
  DecisionRecord,
  MoveOutcome,
  RelativeMove,
  SpeedMode,
  SpeedOutcome,
  TrackViewProps,
} from '../../shared/contracts.ts'
import { CarSprite } from './CarSprite.tsx'
import { HazardLayer } from './HazardLayer.tsx'
import { TrackLayer } from './TrackLayer.tsx'
import './track.css'

// ─────────────────────────────── Labels (UI = Spanish) ───────────────────────────────

const PHASE_LABEL: Record<CarPhase, string> = {
  idle: 'Esperando',
  thinking: 'Pensando…',
  moving: 'En movimiento',
  crashed: '¡Choque!',
  spinning: 'Trompo',
  finished: 'Meta',
}

const SPEED_HUD: Record<SpeedMode, { label: string; className: string }> = {
  slow: { label: 'Lento', className: 'text-info' },
  cruise: { label: 'Crucero', className: 'text-ink' },
  boost: { label: 'Turbo', className: 'text-warn' },
}

const MOVE_LABEL: Record<RelativeMove, string> = { forward: 'recto', left: 'izquierda', right: 'derecha' }
const SPEED_LABEL: Record<SpeedMode, string> = { slow: 'lento', cruise: 'crucero', boost: 'turbo' }
const MOVE_OUTCOME_LABEL: Record<MoveOutcome, string> = {
  optimal: 'óptimo',
  suboptimal: 'subóptimo',
  crash: 'choque',
  invalid: 'inválido',
  timeout: 'sin respuesta',
  error: 'error',
}
const SPEED_OUTCOME_LABEL: Record<SpeedOutcome, string> = {
  correct: 'vel. correcta',
  too_slow: 'muy lento',
  too_fast: 'trompo',
  not_graded: '',
}

type MarkerKind = 'hit' | 'error' | 'meh'

interface MarkerInfo {
  id: string
  kind: MarkerKind
  glyph: string
  answer: string
  outcome: string
}

/** ✓ hit · ✗ error · ≈ neither (e.g. a valid but sub-optimal move). */
function describeRecord(r: DecisionRecord): MarkerInfo {
  const kind: MarkerKind = r.hit ? 'hit' : r.error ? 'error' : 'meh'
  const { move, speed } = r.result.answer
  let answer: string
  if (r.result.status === 'timeout') answer = 'tiempo agotado'
  else if (r.result.status === 'invalid') answer = 'respuesta inválida'
  else if (r.result.status === 'error') answer = 'error del motor'
  else answer = `${move ? MOVE_LABEL[move] : '—'} · ${speed ? SPEED_LABEL[speed] : '—'}`
  const speedPart = SPEED_OUTCOME_LABEL[r.speedOutcome]
  const outcome = [MOVE_OUTCOME_LABEL[r.moveOutcome], speedPart].filter(Boolean).join(' · ')
  return { id: r.id, kind, glyph: kind === 'hit' ? '✓' : kind === 'error' ? '✗' : '≈', answer, outcome }
}

// ─────────────────────────────── Helpers ───────────────────────────────

const TRAIL_POINTS = 12
const TRAIL_STEP = 0.12
const TRAIL_RESET_DIST = 1.6
const BUBBLE_HALF_WIDTH = 66
/** Bubble height (~26px) + top HUD chip row (~38px). */
const HUD_TOP_CLEARANCE = 66

const r1 = (v: number) => Math.round(v * 10) / 10
const r3 = (v: number) => Math.round(v * 1000) / 1000

function formatClock(ms: number): string {
  const total = Math.max(0, ms)
  const minutes = Math.floor(total / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const tenths = Math.floor((total % 1000) / 100)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`
}

function starPoints(spikes: number, outer: number, inner: number): string {
  const pts: string[] = []
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2
    const r = i % 2 === 0 ? outer : inner
    pts.push(`${r3(Math.cos(a) * r)},${r3(Math.sin(a) * r)}`)
  }
  return pts.join(' ')
}

const BURST_OUTER = starPoints(9, 0.5, 0.22)
const BURST_INNER = starPoints(9, 0.32, 0.13)

/** Restart a CSS animation that is gated by the `tv-on` class. */
function restartOn(el: Element) {
  el.classList.remove('tv-on')
  void el.getBoundingClientRect()
  el.classList.add('tv-on')
}

// ─────────────────────────────── Component ───────────────────────────────

/**
 * One lane of the race: responsive SVG circuit + animated car.
 *
 * Rendering split:
 *  - static layer (grass, road, kerbs, start line, checkpoints): memoized on `track`;
 *  - hazard layer: re-renders only when the hazard set / lap changes;
 *  - dynamic layer (car, trail, effects) + HTML overlays: written by ONE requestAnimationFrame loop
 *    through refs (transform / textContent / data-phase). No React state changes per frame.
 *
 * Sizing: the component fills the width of its container and derives its height from the track
 * aspect ratio (width × height cells), so the parent only needs to constrain the width.
 */
export function TrackView({ track, snapshot, getFrame, accent, label }: TrackViewProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  const rootRef = useRef<HTMLDivElement>(null)
  const carRef = useRef<SVGGElement>(null)
  const wobbleRef = useRef<SVGGElement>(null)
  const fxRef = useRef<SVGGElement>(null)
  const burstRef = useRef<SVGGElement>(null)
  const burstFxRef = useRef<SVGGElement>(null)
  const skidRef = useRef<SVGGElement>(null)
  const trailRef = useRef<SVGGElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const flashRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<HTMLSpanElement>(null)
  const clockRef = useRef<HTMLSpanElement>(null)
  const phaseRef = useRef<HTMLSpanElement>(null)

  // Always read the latest getFrame inside the loop without restarting it.
  const getFrameRef = useRef(getFrame)
  useLayoutEffect(() => {
    getFrameRef.current = getFrame
  }, [getFrame])

  useLayoutEffect(() => {
    const root = rootRef.current
    const car = carRef.current
    const wobble = wobbleRef.current
    const fx = fxRef.current
    const burst = burstRef.current
    const burstFx = burstFxRef.current
    const skid = skidRef.current
    const trail = trailRef.current
    const anchor = anchorRef.current
    const flash = flashRef.current
    const timer = timerRef.current
    const clock = clockRef.current
    const phaseEl = phaseRef.current
    if (!root || !car || !wobble || !fx || !burst || !burstFx || !skid || !trail || !anchor || !flash || !timer || !clock || !phaseEl) {
      return
    }

    // px per grid unit (the SVG fills the root width and keeps the track aspect ratio)
    let width = root.clientWidth
    let scale = width / track.width
    let gap = 12
    const measure = () => {
      width = root.clientWidth
      scale = width / track.width
      gap = Math.max(10, scale * 0.34)
      root.style.setProperty('--tv-gap', `${r1(gap)}px`)
    }
    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(root)

    const trailLines = Array.from(trail.children) as SVGLineElement[]
    const tx = new Array<number>(TRAIL_POINTS).fill(0)
    const ty = new Array<number>(TRAIL_POINTS).fill(0)
    let trailReady = false
    const drawTrail = () => {
      for (let i = 0; i < trailLines.length; i++) {
        const l = trailLines[i]!
        l.setAttribute('x1', String(r3(tx[i]!)))
        l.setAttribute('y1', String(r3(ty[i]!)))
        l.setAttribute('x2', String(r3(tx[i + 1]!)))
        l.setAttribute('y2', String(r3(ty[i + 1]!)))
      }
    }

    let lastPhase: CarPhase | null = null
    let lastCar = ''
    let lastFx = ''
    let lastWobble = ''
    let lastAnchor = ''
    let lastShift = NaN
    let lastFlip = ''
    let lastSide = ''
    let lastTimer = ''
    let lastClock = -1
    let raf = 0

    const onPhase = (phase: CarPhase, x: number, y: number) => {
      root.dataset.phase = phase
      phaseEl.textContent = PHASE_LABEL[phase]
      if (phase === 'crashed') {
        burst.setAttribute('transform', `translate(${r3(x)} ${r3(y)})`)
        restartOn(burstFx)
        restartOn(flash)
      } else if (phase === 'spinning') {
        skid.setAttribute('transform', `translate(${r3(x)} ${r3(y)})`)
        restartOn(skid)
      }
    }

    const tick = (now: number) => {
      const frame = getFrameRef.current()
      const { pose, phase } = frame

      if (phase !== lastPhase) {
        onPhase(phase, pose.x, pose.y)
        lastPhase = phase
      }

      // Car pose
      const carT = `translate(${r3(pose.x)} ${r3(pose.y)}) rotate(${r1(pose.angleDeg)})`
      if (carT !== lastCar) {
        car.setAttribute('transform', carT)
        lastCar = carT
      }
      const fxT = `translate(${r3(pose.x)} ${r3(pose.y)})`
      if (fxT !== lastFx) {
        fx.setAttribute('transform', fxT)
        lastFx = fxT
      }

      // Crash shake / spin wobble (on top of the pose rotation)
      let wobbleT = ''
      if (phase === 'crashed') {
        wobbleT = `translate(${r3(Math.sin(now / 13) * 0.016)} ${r3(Math.cos(now / 9) * 0.012)})`
      } else if (phase === 'spinning') {
        wobbleT = `rotate(${r1(Math.sin(now / 48) * 6)}) scale(${r3(1 + Math.sin(now / 90) * 0.05)})`
      }
      if (wobbleT !== lastWobble) {
        if (wobbleT) wobble.setAttribute('transform', wobbleT)
        else wobble.removeAttribute('transform')
        lastWobble = wobbleT
      }

      // Fading trail: sample the pose every TRAIL_STEP units
      if (!trailReady) {
        tx.fill(pose.x)
        ty.fill(pose.y)
        trailReady = true
        drawTrail()
      } else {
        const dx = pose.x - tx[0]!
        const dy = pose.y - ty[0]!
        const d2 = dx * dx + dy * dy
        if (d2 > TRAIL_RESET_DIST * TRAIL_RESET_DIST) {
          tx.fill(pose.x)
          ty.fill(pose.y)
          drawTrail()
        } else if (d2 > TRAIL_STEP * TRAIL_STEP) {
          tx.pop()
          ty.pop()
          tx.unshift(pose.x)
          ty.unshift(pose.y)
          drawTrail()
        }
      }

      // HTML overlay anchored on the car (bubble / marker / flag)
      const px = pose.x * scale
      const py = pose.y * scale
      const anchorT = `translate3d(${r1(px)}px, ${r1(py)}px, 0)`
      if (anchorT !== lastAnchor) {
        anchor.style.transform = anchorT
        lastAnchor = anchorT
      }
      const shift = Math.round(
        px < BUBBLE_HALF_WIDTH ? BUBBLE_HALF_WIDTH - px : px > width - BUBBLE_HALF_WIDTH ? width - BUBBLE_HALF_WIDTH - px : 0,
      )
      if (shift !== lastShift) {
        anchor.style.setProperty('--tv-shift', `${shift}px`)
        lastShift = shift
      }
      // Flip below the car when the bubble would end up under the top HUD chips
      const flip = py < gap + HUD_TOP_CLEARANCE ? '1' : '0'
      if (flip !== lastFlip) {
        anchor.dataset.flip = flip
        lastFlip = flip
      }
      const side = px > width - 150 ? 'l' : 'r'
      if (side !== lastSide) {
        anchor.dataset.side = side
        lastSide = side
      }

      // Live timers (text written through refs, no React)
      if (frame.thinkingElapsedMs !== null) {
        const text = `${(frame.thinkingElapsedMs / 1000).toFixed(2)} s`
        if (text !== lastTimer) {
          timer.textContent = text
          lastTimer = text
        }
      }
      const tenths = Math.floor(frame.raceTimeMs / 100)
      if (tenths !== lastClock) {
        clock.textContent = formatClock(frame.raceTimeMs)
        lastClock = tenths
      }

      raf = requestAnimationFrame(tick)
    }

    tick(performance.now())

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      delete root.dataset.phase
    }
  }, [track.width, track.height])

  // ✓ / ✗ / ≈ marker, restarted by `key` whenever a new decision record arrives.
  // A record that was already there when the view mounted does not pop.
  const record = snapshot.lastRecord
  const [initialRecordId] = useState(() => record?.id ?? null)
  const marker = useMemo(
    () => (record && record.id !== initialRecordId ? describeRecord(record) : null),
    [record, initialRecordId],
  )

  const speed = SPEED_HUD[snapshot.speed]
  const progress = Math.max(0, Math.min(1, snapshot.progress)) * 100

  return (
    <div
      ref={rootRef}
      className="tv-root @container relative w-full select-none overflow-hidden rounded-xl bg-grass ring-1 ring-line"
      data-phase="idle"
      style={{ '--tv-accent': accent } as CSSProperties}
    >
      <svg
        viewBox={`0 0 ${track.width} ${track.height}`}
        className="block h-auto w-full"
        style={{ aspectRatio: `${track.width} / ${track.height}` }}
        role="img"
        aria-label={`${label} — circuito ${track.name}`}
      >
        {/* Static layer: only re-rendered when the track changes */}
        <TrackLayer track={track} uid={uid} />

        {/* Hazards of the current lap (fade in when they regenerate) */}
        <HazardLayer hazards={snapshot.hazards} lap={snapshot.lap} uid={uid} />

        {/* Dynamic layer: positions are written by the rAF loop */}
        <g ref={skidRef} className="tv-skid" fill="none" strokeLinecap="round">
          <path d="M-0.17 0.27C-0.36 0.08-0.32-0.2-0.06-0.32" className="stroke-oil" strokeWidth="0.045" strokeDasharray="0.2 0.05" />
          <path d="M0.03 0.3C-0.18 0.12-0.15-0.15 0.11-0.26" className="stroke-oil" strokeWidth="0.045" strokeDasharray="0.2 0.05" />
          <circle r="0.3" className="stroke-oil" strokeOpacity="0.5" strokeWidth="0.03" strokeDasharray="0.14 0.1" />
        </g>
        <g ref={trailRef} className="tv-trail" strokeLinecap="round">
          {Array.from({ length: TRAIL_POINTS - 1 }, (_, i) => {
            const t = i / (TRAIL_POINTS - 2)
            return (
              <line
                key={i}
                style={{ stroke: accent }}
                strokeWidth={0.1 - t * 0.085}
                strokeOpacity={0.3 * (1 - t) ** 1.4}
              />
            )
          })}
        </g>
        <g ref={fxRef}>
          <circle r="0.3" className="tv-think-ring" style={{ stroke: accent }} strokeWidth="0.03" fill="none" />
          <circle r="0.3" className="tv-think-ring-static" style={{ stroke: accent }} strokeWidth="0.018" fill="none" />
          <circle r="0.42" className="tv-crash-glow fill-bad" />
          <circle r="0.3" className="tv-finish-ring stroke-warn" strokeWidth="0.03" strokeDasharray="0.12 0.08" fill="none" />
          <circle cx="-0.14" cy="0.1" r="0.1" className="tv-smoke fill-kerb-b" />
          <circle cx="0.14" cy="0.14" r="0.1" className="tv-smoke tv-smoke-2 fill-kerb-b" />
          <circle cx="0" cy="0.24" r="0.1" className="tv-smoke tv-smoke-3 fill-kerb-b" />
        </g>
        <g ref={carRef}>
          <g ref={wobbleRef}>
            <CarSprite accent={accent} uid={uid} />
          </g>
        </g>
        {/* Outer group = position (attribute), inner group = CSS animation (CSS transform would override the attribute) */}
        <g ref={burstRef}>
          <g ref={burstFxRef} className="tv-burst">
            <polygon points={BURST_OUTER} className="fill-warn" fillOpacity="0.92" />
            <polygon points={BURST_INNER} className="fill-bad" />
            <circle r="0.09" className="fill-kerb-b" />
          </g>
        </g>
      </svg>

      {/* Crash flash (restarted by the rAF loop) */}
      <div ref={flashRef} className="tv-flash" />

      {/* HTML overlays that follow the car: thinking bubble, finish flag, decision marker */}
      <div ref={anchorRef} className="tv-anchor">
        <div className="tv-pop tv-bubble" style={{ borderColor: accent }}>
          <span className="tv-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span ref={timerRef} className="tv-timer">
            0.00 s
          </span>
        </div>
        <div className="tv-pop tv-flag">
          <span className="tv-checker" aria-hidden />
          <span>Meta</span>
        </div>
        {marker && (
          <div key={marker.id} className="tv-marker-pos">
            <div className="tv-marker" data-kind={marker.kind}>
              <span className="tv-marker-glyph">{marker.glyph}</span>
              <span className="tv-marker-text">
                <b>{marker.answer}</b>
                {marker.outcome && <i>{marker.outcome}</i>}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* HUD */}
      <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2 text-[11px] leading-none">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-panel/90 px-2 py-1.5 font-medium text-ink ring-1 ring-line">
            <i className="size-2 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
            <span className="truncate leading-[1.35]">{label}</span>
          </span>
          <span className="shrink-0 rounded-md bg-panel/90 px-2 py-1.5 text-ink-dim ring-1 ring-line">
            <span className="@max-[360px]:hidden">Vuelta </span>
            <b className="font-semibold text-ink">{snapshot.lap}</b>/{snapshot.totalLaps}
          </span>
        </div>
        <span
          ref={clockRef}
          className="shrink-0 rounded-md bg-panel/90 px-2 py-1.5 font-mono font-medium tabular-nums text-ink ring-1 ring-line"
          title="Reloj de carrera"
        />
      </div>
      <div className="pointer-events-none absolute bottom-2.5 left-2 flex items-center gap-1.5 text-[11px] leading-none">
        <span className="flex items-center gap-1.5 rounded-md bg-panel/90 px-2 py-1.5 font-medium text-ink ring-1 ring-line">
          <i className="tv-phase-dot" />
          <span ref={phaseRef} />
        </span>
        <span className={`rounded-md bg-panel/90 px-2 py-1.5 font-medium ring-1 ring-line ${speed.className}`}>
          {speed.label}
        </span>
        {snapshot.status === 'paused' && (
          <span className="rounded-md bg-panel/90 px-2 py-1.5 font-medium text-warn ring-1 ring-line">En pausa</span>
        )}
        {snapshot.status === 'aborted' && (
          <span className="rounded-md bg-panel/90 px-2 py-1.5 font-medium text-bad ring-1 ring-line">Detenida</span>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-line/70">
        <div className="h-full transition-[width] duration-300" style={{ width: `${progress}%`, backgroundColor: accent }} />
      </div>
    </div>
  )
}
