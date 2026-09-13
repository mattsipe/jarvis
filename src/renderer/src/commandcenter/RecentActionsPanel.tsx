import { useToolStore } from '../state/toolStore'
import { Panel, EmptyState } from './Panel'

const STATUS_COLOR: Record<string, string> = {
  started: 'var(--jarvis-cyan)',
  'confirm-pending': 'var(--jarvis-amber)',
  success: 'var(--jarvis-emerald)',
  error: 'var(--jarvis-amber)',
  denied: 'var(--jarvis-amber)'
}

export default function RecentActionsPanel(): React.JSX.Element {
  const activity = useToolStore((s) => s.activity)

  return (
    <Panel title="Recent Actions" style={{ flex: 1 }}>
      {activity.length === 0 && <EmptyState text="No actions yet." />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {activity.map((a) => (
          <div key={a.id} style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{a.name}</span>
              <span style={{ color: STATUS_COLOR[a.status], fontSize: 10, textTransform: 'uppercase' }}>
                {a.status}
              </span>
            </div>
            {a.message && <div style={{ opacity: 0.55, fontSize: 11 }}>{a.message}</div>}
          </div>
        ))}
      </div>
    </Panel>
  )
}
