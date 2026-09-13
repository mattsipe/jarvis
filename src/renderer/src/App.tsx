import { useState } from 'react'

/**
 * M0 placeholder — proves the overlay is transparent, click-through, and
 * that the interactive-region handoff to main works. The real living core
 * (three.js particle sphere, state machine, rings/telemetry) lands in M1;
 * see src/renderer/src/hud/.
 */
export default function App(): React.JSX.Element {
  const [hover, setHover] = useState(false)

  return (
    <div
      onMouseEnter={() => {
        setHover(true)
        window.jarvis.setInteractive(true)
      }}
      onMouseLeave={() => {
        setHover(false)
        window.jarvis.setInteractive(false)
      }}
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: 120,
        height: 120,
        marginLeft: -60,
        marginTop: -60,
        borderRadius: '50%',
        border: '1px solid var(--jarvis-hairline)',
        boxShadow: hover
          ? '0 0 40px 4px rgba(79, 216, 255, 0.35)'
          : '0 0 24px 2px rgba(79, 216, 255, 0.18)',
        background:
          'radial-gradient(circle, rgba(79,216,255,0.25) 0%, rgba(79,216,255,0.05) 60%, transparent 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--jarvis-cyan)',
        fontSize: 10,
        letterSpacing: '0.2em',
        textTransform: 'uppercase',
        animation: 'jarvis-pulse 3.2s ease-in-out infinite',
        cursor: 'default'
      }}
    >
      <style>{`
        @keyframes jarvis-pulse {
          0%, 100% { transform: scale(1); opacity: 0.85; }
          50% { transform: scale(1.06); opacity: 1; }
        }
      `}</style>
      JARVIS
    </div>
  )
}
