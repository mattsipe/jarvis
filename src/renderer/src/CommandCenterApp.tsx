import { useEffect, useState } from 'react'
import Core from './hud/Core'
import Rings from './hud/Rings'
import ErrorBanner from './hud/ErrorBanner'
import { useHudStore, type HudState } from './state/hudStore'
import { useTranscriptStore } from './state/transcriptStore'
import { useToolBridge } from './state/useToolBridge'
import { useVoiceErrorStore } from './state/voiceErrorStore'
import { setAmplitude } from './hud/core/amplitudeBus'
import SystemTelemetryPanel from './commandcenter/SystemTelemetryPanel'
import IntegrationsPanel from './commandcenter/IntegrationsPanel'
import TranscriptPanel from './commandcenter/TranscriptPanel'
import ActiveTaskPanel from './commandcenter/ActiveTaskPanel'
import RecentActionsPanel from './commandcenter/RecentActionsPanel'
import RoutinesPanel from './commandcenter/RoutinesPanel'
import DiagnosticsPanel from './commandcenter/DiagnosticsPanel'

const HUD_STATES: readonly HudState[] = ['ambient', 'listening', 'thinking', 'acting', 'speaking', 'success', 'error']
function isHudState(v: string): v is HudState {
  return (HUD_STATES as readonly string[]).includes(v)
}

/**
 * The second first-class surface (see the plan's two-mode UI priority): a
 * real, resizable/maximizable window built around the same Core/Rings and
 * voice/tool state as Ambient — but it never owns the mic or TTS playback
 * itself (Ambient does; see App.tsx). It only mirrors main's broadcasts and
 * offers a couple of controls (start/stop conversation, back to Ambient)
 * that act on the one shared session through IPC.
 */
export default function CommandCenterApp(): React.JSX.Element {
  const [sessionActive, setSessionActive] = useState(false)
  useToolBridge()

  useEffect(() => {
    const unsubscribers = [
      window.jarvis.onToggleListening(({ listening }) => setSessionActive(listening)),
      window.jarvis.onSessionEnded(() => setSessionActive(false)),
      window.jarvis.onTranscript(({ text, isFinal }) => useTranscriptStore.getState().setUserTranscript(text, isFinal)),
      window.jarvis.onAssistantText((sentence) => useTranscriptStore.getState().appendAssistantText(sentence)),
      window.jarvis.onHudState((state) => {
        if (isHudState(state)) useHudStore.getState().setState(state)
      }),
      window.jarvis.onAmplitudeRelay((value) => setAmplitude(value)),
      window.jarvis.onVoiceError(({ message, stage }) => {
        console.error(`[jarvis] voice error (${stage}):`, message)
        useHudStore.getState().setState('error')
        useVoiceErrorStore.getState().setError(message, stage)
      })
    ]
    return () => unsubscribers.forEach((unsub) => unsub())
  }, [])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--jarvis-bg)',
        color: '#e6f2ff',
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        gap: 0
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 18px',
          borderBottom: '1px solid var(--jarvis-hairline)'
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: '0.24em', color: 'var(--jarvis-cyan)' }}>JARVIS — COMMAND CENTER</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => window.jarvis.toggleVoiceSession()} style={headerButtonStyle(sessionActive)}>
            {sessionActive ? 'End Conversation' : 'Start Conversation'}
          </button>
          <button onClick={() => window.jarvis.switchToAmbient()} style={headerButtonStyle(false)}>
            Ambient Mode
          </button>
        </div>
      </header>
      <ErrorBanner />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '260px 1fr 300px',
          gap: 14,
          padding: 14,
          minHeight: 0
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <SystemTelemetryPanel />
          <IntegrationsPanel />
          <RoutinesPanel />
        </div>

        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <div style={{ position: 'relative', flex: '0 0 260px', overflow: 'hidden' }}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                transform: 'scale(0.27)',
                transformOrigin: 'center'
              }}
            >
              <Rings />
              <Core />
            </div>
          </div>
          <ActiveTaskPanel />
          <TranscriptPanel />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <DiagnosticsPanel />
          <RecentActionsPanel />
        </div>
      </div>
    </div>
  )
}

function headerButtonStyle(active: boolean): React.CSSProperties {
  return {
    fontFamily: 'inherit',
    fontSize: 10,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    padding: '6px 14px',
    background: active ? 'rgba(255, 107, 74, 0.12)' : 'rgba(79, 216, 255, 0.1)',
    border: `1px solid ${active ? 'var(--jarvis-amber)' : 'var(--jarvis-hairline)'}`,
    color: active ? 'var(--jarvis-amber)' : 'var(--jarvis-cyan)',
    borderRadius: 3,
    cursor: 'pointer'
  }
}
