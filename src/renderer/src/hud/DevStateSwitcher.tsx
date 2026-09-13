import { useHudStore, type HudState } from '../state/hudStore'

const STATES: HudState[] = ['ambient', 'listening', 'thinking', 'acting', 'speaking', 'success', 'error']

/**
 * Dev-only control panel to force any HUD state on demand, so every state
 * and transition can be inspected without the voice pipeline (M2+). Forced
 * states are "held" — auto-revert timers (success/error) are suppressed —
 * see hudStore.devSetState.
 */
export default function DevStateSwitcher(): React.JSX.Element {
  const { state, devSetState, setState } = useHudStore()

  return (
    <div
      onMouseEnter={() => window.jarvis.setInteractive(true)}
      onMouseLeave={() => window.jarvis.setInteractive(false)}
      style={{
        position: 'absolute',
        left: 24,
        bottom: 100,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        border: '1px solid var(--jarvis-hairline)',
        background: 'rgba(5, 7, 12, 0.65)',
        backdropFilter: 'blur(6px)',
        borderRadius: 4,
        pointerEvents: 'auto'
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.18em',
          color: 'var(--jarvis-cyan)',
          opacity: 0.6,
          marginBottom: 2,
          textTransform: 'uppercase'
        }}
      >
        Dev · HUD State [{state}]
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 220 }}>
        {STATES.map((s) => (
          <button
            key={s}
            onClick={() => devSetState(s)}
            style={{
              fontFamily: 'inherit',
              fontSize: 9,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: '4px 7px',
              background: state === s ? 'rgba(79, 216, 255, 0.18)' : 'transparent',
              border: `1px solid ${state === s ? 'var(--jarvis-cyan)' : 'var(--jarvis-hairline)'}`,
              color: state === s ? 'var(--jarvis-cyan)' : '#9fb3c4',
              borderRadius: 3,
              cursor: 'pointer'
            }}
          >
            {s}
          </button>
        ))}
      </div>
      <button
        onClick={() => setState('success')}
        style={{
          fontFamily: 'inherit',
          fontSize: 9,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          padding: '4px 7px',
          marginTop: 4,
          background: 'transparent',
          border: '1px solid var(--jarvis-hairline)',
          color: '#9fb3c4',
          borderRadius: 3,
          cursor: 'pointer'
        }}
      >
        demo: auto-revert (success)
      </button>
    </div>
  )
}
