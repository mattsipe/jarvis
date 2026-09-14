import { useEffect, useState } from 'react'
import { Panel, EmptyState, Row } from './Panel'

interface TransportStatus {
  provider: 'deepgram' | 'elevenlabs'
  state: string
  retryCount: number
  lastError: string | null
  updatedAt: number
}

const PROVIDER_LABEL: Record<TransportStatus['provider'], string> = { deepgram: 'STT (Deepgram)', elevenlabs: 'TTS (ElevenLabs)' }

/** Compact live connection diagnostics for both streaming voice transports — see voice/transport/status.ts. A real-PC report of "a random WebSocket error kills the conversation" is what this exists to make diagnosable: which provider, what state, how many reconnects, and the last error text. */
function VoiceTransportPanel(): React.JSX.Element {
  const [statuses, setStatuses] = useState<Record<string, TransportStatus>>({})

  useEffect(() => {
    return window.jarvis.onTransportStatus((status) => {
      setStatuses((prev) => ({ ...prev, [status.provider]: status as TransportStatus }))
    })
  }, [])

  const entries = Object.values(statuses)
  return (
    <Panel title="Voice Transport">
      {entries.length === 0 ? (
        <EmptyState text="No streaming connection yet this session." />
      ) : (
        entries.map((s) => (
          <Row
            key={s.provider}
            label={PROVIDER_LABEL[s.provider]}
            value={`${s.state}${s.retryCount > 0 ? ` (retry ${s.retryCount})` : ''}${s.state === 'error' && s.lastError ? ` — ${s.lastError}` : ''}`}
          />
        ))
      )}
    </Panel>
  )
}

interface LatencySnapshot {
  turnNumber: number
  marks: Partial<
    Record<
      | 'speechEnd'
      | 'sttFinal'
      | 'claudeRequest'
      | 'claudeFirstToken'
      | 'firstSpeakablePhrase'
      | 'ttsRequest'
      | 'firstTtsAudio'
      | 'playbackStart',
      number
    >
  >
  totalMs: number | null
}

/**
 * Turn-latency waterfall — see the plan's API-safeguards priority
 * ("measurements first, not optimization yet"). Shows the most recent
 * turn's timing from speech-end to actual playback start.
 */
export default function DiagnosticsPanel(): React.JSX.Element {
  const [latest, setLatest] = useState<LatencySnapshot | null>(null)

  useEffect(() => {
    return window.jarvis.onLatency((payload) => setLatest(payload as unknown as LatencySnapshot))
  }, [])

  if (!latest) {
    return (
      <>
        <VoiceTransportPanel />
        <Panel title="Latency (last turn)">
          <EmptyState text="No turn completed yet." />
        </Panel>
      </>
    )
  }

  const order = Object.keys(latest.marks) as Array<keyof LatencySnapshot['marks']>
  const rows: Array<[string, number]> = []
  for (let i = 1; i < order.length; i++) {
    const a = latest.marks[order[i - 1]]!
    const b = latest.marks[order[i]]!
    rows.push([`${order[i - 1]} → ${order[i]}`, b - a])
  }

  return (
    <>
      <VoiceTransportPanel />
      <Panel title={`Latency — turn #${latest.turnNumber}`}>
        {rows.map(([label, ms]) => (
          <Row key={label} label={label} value={`${ms}ms`} />
        ))}
        {latest.totalMs != null && <Row label="TOTAL" value={`${latest.totalMs}ms`} />}
      </Panel>
    </>
  )
}
