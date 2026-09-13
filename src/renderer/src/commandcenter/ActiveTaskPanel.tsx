import { useToolStore } from '../state/toolStore'
import { Panel, EmptyState, Row } from './Panel'

const RISK_COLOR: Record<string, string> = {
  safe: 'var(--jarvis-emerald)',
  moderate: 'var(--jarvis-cyan)',
  elevated: 'var(--jarvis-amber)'
}

export default function ActiveTaskPanel(): React.JSX.Element {
  const activity = useToolStore((s) => s.activity)
  const pending = useToolStore((s) => s.pending)
  const active = activity.find((a) => a.status === 'started' || a.status === 'confirm-pending')

  return (
    <Panel title="Active Task">
      {!active && !pending && <EmptyState text="Idle — no tool running." />}
      {active && (
        <>
          <Row label="Tool" value={active.name} />
          <Row label="Risk" value={active.risk.toUpperCase()} />
          <div style={{ color: RISK_COLOR[active.risk], marginTop: 2 }}>
            {active.status === 'confirm-pending' ? 'Awaiting confirmation…' : 'Running…'}
          </div>
        </>
      )}
      {pending && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ color: 'var(--jarvis-amber)' }}>{pending.description}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => window.jarvis.respondToolConfirmation(pending.id, true)}
              style={buttonStyle('var(--jarvis-emerald)')}
            >
              Approve
            </button>
            <button
              onClick={() => window.jarvis.respondToolConfirmation(pending.id, false)}
              style={buttonStyle('var(--jarvis-amber)')}
            >
              Deny
            </button>
          </div>
        </div>
      )}
    </Panel>
  )
}

function buttonStyle(color: string): React.CSSProperties {
  return {
    fontFamily: 'inherit',
    fontSize: 11,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '5px 12px',
    background: 'transparent',
    border: `1px solid ${color}`,
    color,
    borderRadius: 3,
    cursor: 'pointer'
  }
}
