import { useHudStore } from '../state/hudStore'
import { useTranscriptStore } from '../state/transcriptStore'

/**
 * Live transcript beneath the core — the user's speech as it's recognized
 * (interim dimmer, final full-brightness) and JARVIS's reply as it's
 * spoken, per the reference media. Visible only while there's something
 * to show; fades with the rest of the expanded HUD otherwise.
 */
export default function Transcript(): React.JSX.Element {
  const state = useHudStore((s) => s.state)
  const { userInterim, userFinal, assistantText } = useTranscriptStore()

  const showUser = state === 'listening' || (state === 'thinking' && Boolean(userFinal))
  const showAssistant = state === 'speaking' || state === 'success'
  const text = showAssistant ? assistantText : showUser ? `${userFinal} ${userInterim}`.trim() : ''
  const visible = Boolean(text)

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: 780,
        marginLeft: -390,
        marginTop: 340,
        textAlign: 'center',
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transform: `translateY(${visible ? 0 : 8}px)`,
        transition: 'opacity 400ms ease, transform 400ms ease'
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: showAssistant ? 'var(--jarvis-cyan-emerald)' : 'var(--jarvis-cyan)',
          opacity: 0.55,
          marginBottom: 8
        }}
      >
        {showAssistant ? 'Jarvis' : 'You'}
      </div>
      <div
        style={{
          fontSize: 20,
          lineHeight: 1.5,
          color: '#e8f3f9',
          textShadow: '0 0 24px rgba(79, 216, 255, 0.35)'
        }}
      >
        {text || ' '}
      </div>
    </div>
  )
}
