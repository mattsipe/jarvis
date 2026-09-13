import { useToolStore } from '../state/toolStore'

/**
 * Elevated-risk tool gate — shown whenever main is awaiting an explicit
 * confirmation (see main/tools/confirmation.ts). Approve/Deny click here
 * resolves it immediately; saying "yes"/"no" out loud resolves it too
 * (VoiceSession briefly re-opens listening for exactly that — see
 * session.ts's requestToolConfirmation), so this is a visual affordance,
 * not the only way to respond.
 */
export default function ToolConfirm(): React.JSX.Element | null {
  const pending = useToolStore((s) => s.pending)
  if (!pending) return null

  const respond = (approved: boolean): void => window.jarvis.respondToolConfirmation(pending.id, approved)

  return (
    <div
      onMouseEnter={() => window.jarvis.setInteractive(true)}
      onMouseLeave={() => window.jarvis.setInteractive(false)}
      style={{
        position: 'absolute',
        left: '50%',
        bottom: '14%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        padding: '14px 22px',
        border: '1px solid var(--jarvis-amber)',
        background: 'rgba(5, 7, 12, 0.82)',
        backdropFilter: 'blur(8px)',
        borderRadius: 4,
        pointerEvents: 'auto',
        minWidth: 280
      }}
    >
      <div style={{ fontSize: 10, letterSpacing: '0.18em', color: 'var(--jarvis-amber)', textTransform: 'uppercase' }}>
        Confirmation required
      </div>
      <div style={{ fontSize: 13, color: '#e6f2ff', textAlign: 'center' }}>{pending.description}</div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={() => respond(true)}
          style={{
            fontFamily: 'inherit',
            fontSize: 11,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '6px 16px',
            background: 'rgba(59, 240, 192, 0.15)',
            border: '1px solid var(--jarvis-emerald)',
            color: 'var(--jarvis-emerald)',
            borderRadius: 3,
            cursor: 'pointer'
          }}
        >
          Approve
        </button>
        <button
          onClick={() => respond(false)}
          style={{
            fontFamily: 'inherit',
            fontSize: 11,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '6px 16px',
            background: 'rgba(255, 107, 74, 0.12)',
            border: '1px solid var(--jarvis-amber)',
            color: 'var(--jarvis-amber)',
            borderRadius: 3,
            cursor: 'pointer'
          }}
        >
          Deny
        </button>
      </div>
    </div>
  )
}
