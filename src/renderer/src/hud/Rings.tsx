import { useMemo } from 'react'
import { useHudStore, type HudState } from '../state/hudStore'
import { CORE_BOX_PX } from './Core'

const SIZE = CORE_BOX_PX
const CENTER = SIZE / 2

const RING_COLOR: Record<HudState, string> = {
  ambient: 'var(--jarvis-cyan)',
  listening: 'var(--jarvis-cyan)',
  thinking: 'var(--jarvis-violet)',
  acting: 'var(--jarvis-emerald)',
  speaking: 'var(--jarvis-cyan-emerald)',
  success: 'var(--jarvis-emerald)',
  error: 'var(--jarvis-amber)'
}

/** Rotation durations (seconds) per state — faster while "working", slower at rest. */
const RING_TIMING: Record<HudState, { slow: number; fast: number }> = {
  ambient: { slow: 90, fast: 50 },
  listening: { slow: 48, fast: 26 },
  thinking: { slow: 10, fast: 5 },
  acting: { slow: 16, fast: 8 },
  speaking: { slow: 24, fast: 13 },
  success: { slow: 30, fast: 16 },
  error: { slow: 7, fast: 4 }
}

function isExpanded(state: HudState): boolean {
  return state !== 'ambient'
}

function polarPoint(radius: number, angleDeg: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180
  return [CENTER + radius * Math.cos(a), CENTER + radius * Math.sin(a)]
}

type Corner = 'tl' | 'tr' | 'bl' | 'br'

/** Small L-shaped corner bracket, matching the reference panels' corner-tick style. */
function CornerBracket({ x, y, corner, size = 26 }: { x: number; y: number; corner: Corner; size?: number }): React.JSX.Element {
  const dx = corner === 'tl' || corner === 'bl' ? 1 : -1
  const dy = corner === 'tl' || corner === 'tr' ? 1 : -1
  const path = `M ${x} ${y + size * dy} L ${x} ${y} L ${x + size * dx} ${y}`
  return <path d={path} fill="none" stroke="var(--ring-color)" strokeWidth={1.5} opacity={0.85} />
}

function TickRing({ radius, count, length, opacity }: { radius: number; count: number; length: number; opacity: number }): React.JSX.Element {
  const ticks = useMemo(() => {
    const arr: React.ReactNode[] = []
    for (let i = 0; i < count; i++) {
      const angle = (360 / count) * i
      const isMajor = i % (count / 12) === 0
      const [x1, y1] = polarPoint(radius, angle)
      const [x2, y2] = polarPoint(radius - (isMajor ? length * 1.8 : length), angle)
      arr.push(
        <line
          key={i}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="var(--ring-color)"
          strokeWidth={isMajor ? 1.4 : 0.7}
          opacity={isMajor ? opacity : opacity * 0.55}
        />
      )
    }
    return arr
  }, [radius, count, length, opacity])
  return <g>{ticks}</g>
}

/**
 * Concentric technical rings framing the core: tick ring, a slow dashed
 * rotating ring, a fast bright scan arc, quadrant markers, and corner
 * brackets — the "controlled complexity" vocabulary from the reference
 * media. Fades/scales in as the HUD leaves ambient (see App.tsx layering).
 */
export default function Rings(): React.JSX.Element {
  const state = useHudStore((s) => s.state)
  const expanded = isExpanded(state)
  const timing = RING_TIMING[state]
  const color = RING_COLOR[state]

  const bracketOffset = 400
  const brackets: [number, number, Corner][] = [
    [CENTER - bracketOffset, CENTER - bracketOffset, 'tl'],
    [CENTER + bracketOffset, CENTER - bracketOffset, 'tr'],
    [CENTER + bracketOffset, CENTER + bracketOffset, 'br'],
    [CENTER - bracketOffset, CENTER + bracketOffset, 'bl']
  ]

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: SIZE,
        height: SIZE,
        marginLeft: -SIZE / 2,
        marginTop: -SIZE / 2,
        pointerEvents: 'none',
        // @ts-expect-error -- custom property
        '--ring-color': color,
        opacity: expanded ? 1 : 0,
        transform: `scale(${expanded ? 1 : 0.55})`,
        transition: 'opacity 700ms cubic-bezier(0.16, 1, 0.3, 1), transform 700ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      <TickRing radius={380} count={72} length={10} opacity={0.55} />

      <g style={{ transformOrigin: `${CENTER}px ${CENTER}px`, animation: `jarvis-spin ${timing.slow}s linear infinite` }}>
        <circle
          cx={CENTER}
          cy={CENTER}
          r={330}
          fill="none"
          stroke="var(--ring-color)"
          strokeWidth={1}
          strokeDasharray="2 10"
          opacity={0.5}
        />
      </g>

      <g style={{ transformOrigin: `${CENTER}px ${CENTER}px`, animation: `jarvis-spin-reverse ${timing.fast}s linear infinite` }}>
        <circle
          cx={CENTER}
          cy={CENTER}
          r={355}
          fill="none"
          stroke="var(--ring-color)"
          strokeWidth={2.5}
          strokeDasharray="90 1000"
          strokeLinecap="round"
          opacity={0.8}
        />
      </g>

      <circle cx={CENTER} cy={CENTER} r={290} fill="none" stroke="var(--ring-color)" strokeWidth={1} opacity={0.35} />

      {[0, 90, 180, 270].map((angle) => {
        const [x, y] = polarPoint(380, angle)
        return (
          <rect
            key={angle}
            x={x - 4}
            y={y - 4}
            width={8}
            height={8}
            transform={`rotate(45 ${x} ${y})`}
            fill="var(--ring-color)"
            opacity={0.75}
          />
        )
      })}

      {brackets.map(([x, y, corner]) => (
        <CornerBracket key={corner} x={x} y={y} corner={corner} />
      ))}
    </svg>
  )
}
