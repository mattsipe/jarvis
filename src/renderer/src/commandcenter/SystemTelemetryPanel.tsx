import { useEffect, useState } from 'react'
import { Panel, Row } from './Panel'

// Mirrors main/platform/types.ts's SystemStatusInfo — duplicated rather than
// imported since the renderer and main TS projects are separate program
// roots (see tsconfig.web.json's `include`).
interface SystemStatusInfo {
  platform: string
  hostname: string
  uptimeSec: number
  cpuLoad1m: number
  memUsedPct: number
  memTotalGB: number
  batteryPct: number | null
}

const POLL_MS = 3000

export default function SystemTelemetryPanel(): React.JSX.Element {
  const [status, setStatus] = useState<SystemStatusInfo | null>(null)

  useEffect(() => {
    let alive = true
    const poll = (): void => {
      window.jarvis
        .getLiveContext()
        .then((ctx) => {
          if (alive) setStatus((ctx as { system: SystemStatusInfo | null }).system)
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  return (
    <Panel title="System Telemetry">
      {!status ? (
        <Row label="Status" value="reading…" />
      ) : (
        <>
          <Row label="Platform" value={status.platform} />
          <Row label="Host" value={status.hostname} />
          <Row label="CPU load (1m)" value={status.cpuLoad1m.toFixed(2)} />
          <Row label="Memory" value={`${status.memUsedPct.toFixed(0)}% of ${status.memTotalGB.toFixed(0)} GB`} />
          <Row label="Uptime" value={`${Math.round(status.uptimeSec / 60)}m`} />
          {status.batteryPct != null && <Row label="Battery" value={`${Math.round(status.batteryPct)}%`} />}
        </>
      )}
    </Panel>
  )
}
