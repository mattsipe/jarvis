import { useEffect, useRef, useState } from 'react'
import { Panel, Row } from './Panel'

interface PresenceMicStatus {
  requestedSampleRate: number
  actualContextSampleRate: number
  trackSampleRate: number | null
  channelCount: number
  deviceLabel: string | null
  resampling: boolean
}

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
  sensitivity: number
  consecutiveFrames: number
  micChunksReceived: number
  mic: PresenceMicStatus | null
  engineFramesProcessed: number
  lastScore: number | null
  recentPeakScore: number
  threshold: number
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

function fmtTime(iso: string | null): string {
  if (!iso) return 'never'
  return new Date(iso).toLocaleTimeString()
}

function scoreColor(score: number | null, threshold: number): string {
  if (score == null) return 'inherit'
  if (score >= threshold) return 'var(--jarvis-emerald)'
  if (score >= threshold * 0.6) return 'var(--jarvis-amber)'
  return 'inherit'
}

/**
 * Command Center's window into Presence / hands-free (main/presence/).
 * Beyond the state/toggle basics, this exposes the full "why didn't it
 * wake" diagnostic chain end to end — mic device/rate, whether audio is
 * actually arriving, whether the engine is actually running frames
 * through the model, and the live/recent-peak "hey jarvis" score next to
 * the threshold it's being compared against — so a real report ("it
 * doesn't wake") can be narrowed to a specific stage without guessing.
 */
export default function PresencePanel(): React.JSX.Element {
  const [status, setStatus] = useState<PresenceStatus | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [sensitivityDraft, setSensitivityDraft] = useState<number | null>(null)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    // The score/frame-count diagnostics change many times a second while
    // audio is streaming — broadcasting on every single frame would flood
    // IPC, so those specifically are polled instead of pushed. Everything
    // else (toggles, wakes, mic-opened) still arrives instantly via
    // onPresenceState.
    const poll = setInterval(refresh, 1000)
    const unsubscribe = window.jarvis.onPresenceState((s) => setStatus(s as unknown as PresenceStatus))
    return () => {
      clearInterval(poll)
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commitSensitivity = (value: number): void => {
    setSensitivityDraft(value)
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      window.jarvis.setPresenceSensitivity(value).then((s) => setStatus(s as PresenceStatus))
    }, 250)
  }

  if (!status) {
    return (
      <Panel title="Presence">
        <div style={{ opacity: 0.4, fontStyle: 'italic' }}>Loading…</div>
      </Panel>
    )
  }

  const sensitivity = sensitivityDraft ?? status.sensitivity

  return (
    <Panel title="Presence" style={{ flex: 1 }}>
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
      <Row label="Cloud audio" value={status.cloudAudioActive ? 'Active (in conversation)' : 'Idle'} />
      <Row label="Wakes this run" value={`${status.wakeCount} (last: ${fmtTime(status.lastWakeAt)})`} />

      <div style={{ height: 8 }} />
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.7, marginBottom: 2 }}>
        Wake-word diagnostics
      </div>
      <Row label="Mic (wake-word)" value={status.micActive ? 'Listening' : 'Off'} />
      {status.mic ? (
        <>
          <Row
            label="Mic device"
            value={status.mic.deviceLabel || '(default)'}
          />
          <Row
            label="Sample rate"
            value={
              status.mic.resampling
                ? `${status.mic.actualContextSampleRate}Hz → resampled to 16000Hz`
                : '16000Hz (native)'
            }
          />
          <Row label="Channels" value={String(status.mic.channelCount)} />
        </>
      ) : (
        <Row label="Mic device" value="not opened yet" />
      )}
      <Row label="Audio chunks received" value={String(status.micChunksReceived)} />
      <Row label="Engine frames processed" value={String(status.engineFramesProcessed)} />
      <Row
        label="Current score"
        value={status.lastScore == null ? '—' : status.lastScore.toFixed(3)}
      />
      <div style={{ color: scoreColor(status.lastScore, status.threshold) }}>
        <Row label="Recent peak score" value={status.recentPeakScore.toFixed(3)} />
      </div>
      <Row label="Threshold (from sensitivity)" value={status.threshold.toFixed(3)} />

      <div style={{ height: 8 }} />
      <label style={{ fontSize: 10, opacity: 0.7, display: 'block', marginBottom: 2 }}>
        Sensitivity ({sensitivity.toFixed(2)}) — higher wakes more easily, at the cost of more false wakes
      </label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={sensitivity}
        onChange={(e) => commitSensitivity(parseFloat(e.target.value))}
        style={{ width: '100%' }}
      />
      <label style={{ fontSize: 10, opacity: 0.7, display: 'block', margin: '6px 0 2px' }}>
        Consecutive frames required ({status.consecutiveFrames}) — false-positive protection; each frame is 80ms
      </label>
      <input
        type="range"
        min={1}
        max={6}
        step={1}
        value={status.consecutiveFrames}
        onChange={(e) => window.jarvis.setPresenceConsecutiveFrames(parseInt(e.target.value, 10)).then((s) => setStatus(s as PresenceStatus))}
        style={{ width: '100%' }}
      />

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
