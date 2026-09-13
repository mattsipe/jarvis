import { useEffect, useRef } from 'react'
import { useTranscriptStore } from '../state/transcriptStore'
import { Panel, EmptyState } from './Panel'

const ROLE_LABEL = { user: 'WESTON', assistant: 'JARVIS' } as const

export default function TranscriptPanel(): React.JSX.Element {
  const history = useTranscriptStore((s) => s.history)
  const userInterim = useTranscriptStore((s) => s.userInterim)
  const userFinal = useTranscriptStore((s) => s.userFinal)
  const assistantText = useTranscriptStore((s) => s.assistantText)
  const scrollRef = useRef<HTMLDivElement>(null)

  const liveUser = `${userFinal} ${userInterim}`.trim()

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [history, liveUser, assistantText])

  const hasAnything = history.length > 0 || liveUser || assistantText

  return (
    <Panel title="Conversation" style={{ flex: 1 }}>
      <div ref={scrollRef} style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', overflow: 'auto' }}>
        {!hasAnything && <EmptyState text="No conversation yet — press the hotkey or start from below." />}
        {history.map((turn, i) => (
          <div key={i}>
            <span style={{ opacity: 0.5, letterSpacing: '0.08em', fontSize: 10 }}>{ROLE_LABEL[turn.role]}</span>
            <div style={{ color: turn.role === 'assistant' ? 'var(--jarvis-cyan)' : '#e6f2ff' }}>{turn.text}</div>
          </div>
        ))}
        {liveUser && (
          <div>
            <span style={{ opacity: 0.5, letterSpacing: '0.08em', fontSize: 10 }}>WESTON</span>
            <div style={{ color: '#e6f2ff', opacity: userInterim ? 0.6 : 1 }}>{liveUser}</div>
          </div>
        )}
        {assistantText && (
          <div>
            <span style={{ opacity: 0.5, letterSpacing: '0.08em', fontSize: 10 }}>JARVIS</span>
            <div style={{ color: 'var(--jarvis-cyan)' }}>{assistantText}</div>
          </div>
        )}
      </div>
    </Panel>
  )
}
