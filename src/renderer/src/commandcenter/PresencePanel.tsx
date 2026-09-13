import { useEffect, useState } from 'react'
import { Panel, Row } from './Panel'

interface PresenceStatus {
  state: 'disabled' | 'sleeping' | 'muted' | 'active'
  enabled: boolean
  launchAtLogin: boolean
  muted: boolean
  wakeEngineReady: boolean
  wakeEngineError: string | null
  micActive: boolean
  cloudAudioActive: boolean
  wakeCount: number
  lastWakeAt: string | null
}

const STATE_LABEL: Record<PresenceStatus['state'], string> = {
  disabled: 'Off (hotkey only)',
  sleeping: 'Listening for "Jarvis"',
  muted: 'Muted',
  active: 'In conversation'
}

const STATE_COLOR: Record<PresenceStatus['state'], string> = {
  disabled: 'var(--jarvis-hairline)',
  sleeping: 'var(--jarvis-emerald)',
  muted: 'var(--jarvis-amber)',
  active: 'var(--jarvis-cyan)'
}

function toggleStyle(active: boolean): React.CSSProperties {
  return {
    fontFamily: 'inherit',
    fontSize: 10,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '3px 10px',
    background: active ? 'rgba(59, 240, 192, 0.12)' : 'transparent',
    border: `1px solid ${active ? 'var(--jarvis-emerald)' : 'var(--jarvis-hairline)'}`,
    color: active ? 'var(--jarvis-emerald)' : 'inherit',
    opacity: active ? 1 : 0.7,
    borderRadius: 2,
    cursor: 'pointer'
  }
}

/**
 * Command Center's window into Presence / hands-free (main/presence/) —
 * the concise diagnostics the plan asked for (Presence state, wake-word
 * engine status, mic state, whether cloud audio is active) plus the
 * enabled/launch-at-login/mute toggles. Mirrors the tray's state so the
 * same information is visible whether or not a window is open at all.
 */
export default function PresencePanel(): React.JSX.Element {
  const [status, setStatus] = useState<PresenceStatus | null>(null)
  const [retrying, setRetrying] = useState(false)

  const refresh = (): void => {
    window.jarvis.getPresenceStatus().then((s) => setStatus(s as PresenceStatus))
  }

  const retryEngine = async (): Promise<void> => {
    setRetrying(true)
    try {
      const s = await window.jarvis.retryPresenceEngine()
      setStatus(s as PresenceStatus)
    } finally {
      setRetrying(false)
    }
  }

  useEffect(() => {
    refresh()
    return window.jarvis.onPresenceState((s) => setStatus(s as unknown as PresenceStatus))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!status) {
    return (
      <Panel title="Presence">
        <div style={{ opacity: 0.4, fontStyle: 'italic' }}>Loading…</div>
      </Panel>
    )
  }

  return (
    <Panel title="Presence">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ color: STATE_COLOR[status.state], fontSize: 14, lineHeight: 1 }}>●</span>
        <span style={{ fontSize: 12 }}>{STATE_LABEL[status.state]}</span>
      </div>

      <Row label="Wake-word engine" value={status.wakeEngineReady ? 'Ready (local, offline)' : 'Not available'} />
      {!status.wakeEngineReady && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          {status.wakeEngineError && <div style={{ fontSize: 10, opacity: 0.6, flex: 1 }}>{status.wakeEngineError}</div>}
          <button onClick={retryEngine} disabled={retrying} style={toggleStyle(false)}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      <Row label="Mic (wake-word)" value={status.micActive ? 'Listening' : 'Off'} />
      <Row label="Cloud audio" value={status.cloudAudioActive ? 'Active (in conversation)' : 'Idle'} />
      <Row label="Wakes this run" value={String(status.wakeCount)} />

      <div style={{ height: 8 }} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={() => window.jarvis.setPresenceEnabled(!status.enabled).then((s) => setStatus(s as PresenceStatus))}
          style={toggleStyle(status.enabled)}
        >
          {status.enabled ? 'Presence On' : 'Presence Off'}
        </button>
        <button
          onClick={() => window.jarvis.setPresenceMuted(!status.muted).then((s) => setStatus(s as PresenceStatus))}
          style={toggleStyle(!status.muted)}
        >
          {status.muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          onClick={() => window.jarvis.setPresenceLaunchAtLogin(!status.launchAtLogin).then((s) => setStatus(s as PresenceStatus))}
          style={toggleStyle(status.launchAtLogin)}
        >
          {status.launchAtLogin ? 'Launches at Login' : 'Launch at Login'}
        </button>
      </div>
    </Panel>
  )
}
