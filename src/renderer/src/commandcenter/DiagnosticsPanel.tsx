import { useEffect, useState } from 'react'
import { Panel, EmptyState, Row } from './Panel'

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
      <Panel title="Latency (last turn)">
        <EmptyState text="No turn completed yet." />
      </Panel>
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
    <Panel title={`Latency — turn #${latest.turnNumber}`}>
      {rows.map(([label, ms]) => (
        <Row key={label} label={label} value={`${ms}ms`} />
      ))}
      {latest.totalMs != null && <Row label="TOTAL" value={`${latest.totalMs}ms`} />}
    </Panel>
  )
}
