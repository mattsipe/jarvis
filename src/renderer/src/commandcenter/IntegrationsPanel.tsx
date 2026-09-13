import { useEffect, useState } from 'react'
import { Panel, Row } from './Panel'

interface ServicesStatus {
  anthropic: boolean
  elevenlabs: boolean
  deepgram: boolean
}

interface UsageSnapshot {
  sttSecondsTotal: number
  ttsCharsTotal: number
  sessionCount: number
}

function statusLabel(ok: boolean): string {
  return ok ? 'CONNECTED' : 'NOT CONFIGURED'
}

export default function IntegrationsPanel(): React.JSX.Element {
  const [services, setServices] = useState<ServicesStatus | null>(null)
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)

  useEffect(() => {
    window.jarvis.getServicesStatus().then(setServices)
    const poll = (): void => {
      window.jarvis.getUsageSnapshot().then((u) => setUsage(u as UsageSnapshot))
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <Panel title="Integrations">
      <Row label="Claude" value={services ? statusLabel(services.anthropic) : '…'} />
      <Row label="Deepgram (STT)" value={services ? statusLabel(services.deepgram) : '…'} />
      <Row label="ElevenLabs (TTS)" value={services ? statusLabel(services.elevenlabs) : '…'} />
      {usage && (
        <>
          <div style={{ height: 6 }} />
          <Row label="STT minutes used" value={(usage.sttSecondsTotal / 60).toFixed(1)} />
          <Row label="TTS characters used" value={usage.ttsCharsTotal.toLocaleString()} />
          <Row label="Sessions" value={String(usage.sessionCount)} />
        </>
      )}
    </Panel>
  )
}
