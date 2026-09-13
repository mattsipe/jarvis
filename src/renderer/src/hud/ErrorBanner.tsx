import { useVoiceErrorStore } from '../state/voiceErrorStore'

const STAGE_LABEL: Record<string, string> = {
  mic: 'Microphone',
  stt: 'Speech recognition',
  tts: 'Voice output',
  agent: 'Claude'
}

/**
 * Plain-language voice error, shown in both Ambient and Command Center —
 * previously a failure only ever turned the core red with no indication of
 * why (see the Windows voice-startup bug report). Auto-clears after a
 * while (see voiceErrorStore) but stays interactive so it can be dismissed
 * immediately too.
 */
export default function ErrorBanner(): React.JSX.Element | null {
  const message = useVoiceErrorStore((s) => s.message)
  const stage = useVoiceErrorStore((s) => s.stage)
  const clear = useVoiceErrorStore((s) => s.clear)
  if (!message) return null

  return (
    <div
      onMouseEnter={() => window.jarvis.setInteractive(true)}
      onMouseLeave={() => window.jarvis.setInteractive(false)}
      style={{
        position: 'absolute',
        left: '50%',
        top: '8%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 18px',
        border: '1px solid var(--jarvis-amber)',
        background: 'rgba(20, 8, 6, 0.85)',
        backdropFilter: 'blur(8px)',
        borderRadius: 4,
        pointerEvents: 'auto',
        maxWidth: 520,
        zIndex: 50
      }}
    >
      <div style={{ fontSize: 12, color: '#ffd9c9' }}>
        <span style={{ color: 'var(--jarvis-amber)', letterSpacing: '0.08em', textTransform: 'uppercase', fontSize: 10 }}>
          {stage ? (STAGE_LABEL[stage] ?? stage) : 'Error'}
        </span>
        {' — '}
        {message}
      </div>
      <button
        onClick={clear}
        style={{
          fontFamily: 'inherit',
          fontSize: 10,
          background: 'transparent',
          border: 'none',
          color: 'var(--jarvis-amber)',
          cursor: 'pointer',
          opacity: 0.7
        }}
      >
        ✕
      </button>
    </div>
  )
}
