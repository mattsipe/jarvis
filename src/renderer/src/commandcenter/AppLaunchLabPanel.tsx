import { useEffect, useMemo, useState } from 'react'
import { Panel, EmptyState, Row } from './Panel'

interface InstalledApplication {
  canonicalId: string
  displayName: string
  registrationSource: string
  launchKind: string
  appId: string
}

interface LaunchTraceCandidate {
  displayName: string
  canonicalId: string
  launchKind: string
  score: number
}

interface LaunchTrace {
  request: string
  normalizedQuery: string
  preference: { query: string; canonicalId: string | null; status: 'applied' | 'none' | 'ignored-not-installed' }
  candidates: LaunchTraceCandidate[]
  selected: { displayName: string; canonicalId: string } | null
  registrationSource: string | null
  activationMethod: string | null
  activationTarget: string | null
  activationResult: 'ok' | { error: string } | null
  observed: { pid: number; processName: string } | null
  confidence: 'confirmed' | 'existing-instance' | 'unverified' | null
  finalResult: 'launched' | 'accepted' | 'failed' | 'ambiguous' | 'not-installed'
}

interface LabResult {
  ok: boolean
  message: string
  trace?: LaunchTrace
  diagnostics?: { launchTrace?: LaunchTrace }
}

const FINAL_RESULT_COLOR: Record<LaunchTrace['finalResult'], string> = {
  launched: 'var(--jarvis-emerald)',
  accepted: 'var(--jarvis-emerald)',
  failed: 'var(--jarvis-amber)',
  ambiguous: 'var(--jarvis-amber)',
  'not-installed': 'var(--jarvis-amber)'
}

function activationResultText(r: LaunchTrace['activationResult']): string {
  if (r === null) return '—'
  if (r === 'ok') return 'ok'
  return `error: ${r.error}`
}

/**
 * Self-contained real-PC validation for the app-launch rebuild (see the
 * plan's "App Launch Lab" section) — search the actual Windows catalog,
 * inspect canonical IDs, resolve without launching, or launch for real,
 * with the full LaunchTrace shown for each: candidates considered,
 * selected app, registration source, activation method/target/result,
 * observed process, verification confidence, and final result. Exists so
 * Weston can validate this end to end from inside JARVIS itself, without
 * running PowerShell by hand.
 */
export default function AppLaunchLabPanel(): React.JSX.Element {
  const [catalog, setCatalog] = useState<InstalledApplication[]>([])
  const [search, setSearch] = useState('')
  const [appName, setAppName] = useState('')
  const [busy, setBusy] = useState<'resolve' | 'launch' | null>(null)
  const [result, setResult] = useState<LabResult | null>(null)

  const refreshCatalog = (): void => {
    window.jarvis.getAppCatalog().then((list) => setCatalog(list as InstalledApplication[]))
  }

  useEffect(() => {
    refreshCatalog()
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return catalog.slice(0, 12)
    return catalog.filter((a) => a.displayName.toLowerCase().includes(q) || a.canonicalId.toLowerCase().includes(q)).slice(0, 12)
  }, [catalog, search])

  const runResolve = async (): Promise<void> => {
    if (!appName.trim()) return
    setBusy('resolve')
    setResult(null)
    try {
      const r = (await window.jarvis.resolveApp(appName.trim())) as LabResult
      setResult({ ...r, trace: r.trace })
    } finally {
      setBusy(null)
    }
  }

  const runLaunch = async (): Promise<void> => {
    if (!appName.trim()) return
    setBusy('launch')
    setResult(null)
    try {
      const r = (await window.jarvis.launchApp(appName.trim())) as LabResult
      setResult({ ...r, trace: r.diagnostics?.launchTrace })
    } finally {
      setBusy(null)
    }
  }

  const trace = result?.trace

  return (
    <Panel title="App Launch Lab" style={{ flex: 1 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <div style={labelStyle}>Search installed applications</div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. outlook, excel, chrome…"
            style={inputStyle}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6, maxHeight: 140, overflowY: 'auto' }}>
            {filtered.length === 0 && <EmptyState text="No installed apps match — the catalog may still be refreshing." />}
            {filtered.map((a) => (
              <div key={a.canonicalId} style={{ fontSize: 10, opacity: 0.75, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  {a.displayName} <span style={{ opacity: 0.6 }}>({a.launchKind})</span>
                </span>
                <span style={{ opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }} title={a.canonicalId}>
                  {a.canonicalId}
                </span>
              </div>
            ))}
          </div>
          {catalog.length > 0 && <div style={{ fontSize: 10, opacity: 0.4, marginTop: 4 }}>{catalog.length} total in catalog</div>}
        </div>

        <div style={{ height: 1, background: 'var(--jarvis-hairline)' }} />

        <div>
          <div style={labelStyle}>Resolve or launch by name</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              placeholder='e.g. "Outlook"'
              style={{ ...inputStyle, flex: 1 }}
            />
            <button onClick={runResolve} disabled={busy !== null} style={buttonStyle('var(--jarvis-cyan)')}>
              {busy === 'resolve' ? 'Resolving…' : 'Resolve'}
            </button>
            <button onClick={runLaunch} disabled={busy !== null} style={buttonStyle('var(--jarvis-amber)')}>
              {busy === 'launch' ? 'Launching…' : 'Launch'}
            </button>
          </div>
        </div>

        {result && !trace && <div style={{ fontSize: 11, opacity: 0.7 }}>{result.message}</div>}

        {trace && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
            <Row label="Request" value={trace.request} />
            <Row label="Normalized" value={trace.normalizedQuery} />
            <Row
              label="Preference"
              value={
                trace.preference.status === 'none'
                  ? 'none'
                  : `${trace.preference.canonicalId} (${trace.preference.status})`
              }
            />
            <Row label="Candidates" value={trace.candidates.length === 0 ? 'none' : `${trace.candidates.length} considered`} />
            {trace.candidates.map((c) => (
              <div key={c.canonicalId} style={{ fontSize: 10, opacity: 0.55, paddingLeft: 8 }}>
                {c.displayName} — {c.launchKind} — score {c.score}
              </div>
            ))}
            <Row label="Selected" value={trace.selected ? `${trace.selected.displayName}` : '—'} />
            <Row label="Registration source" value={trace.registrationSource ?? '—'} />
            <Row label="Activation method" value={trace.activationMethod ?? '—'} />
            <Row label="Activation target" value={trace.activationTarget ?? '—'} />
            <Row label="Activation result" value={activationResultText(trace.activationResult)} />
            <Row label="Observed" value={trace.observed ? `pid ${trace.observed.pid} (${trace.observed.processName})` : '—'} />
            <Row label="Confidence" value={trace.confidence ?? '—'} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              <span style={{ fontWeight: 600 }}>Final result</span>
              <span style={{ color: FINAL_RESULT_COLOR[trace.finalResult], textTransform: 'uppercase', fontSize: 10 }}>
                {trace.finalResult}
              </span>
            </div>
          </div>
        )}
      </div>
    </Panel>
  )
}

const labelStyle: React.CSSProperties = { fontSize: 10, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }

const inputStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: 'inherit',
  fontSize: 11,
  background: 'rgba(0,0,0,0.35)',
  border: '1px solid var(--jarvis-hairline)',
  color: '#e6f2ff',
  borderRadius: 2,
  padding: '5px 7px',
  boxSizing: 'border-box'
}

function buttonStyle(color: string): React.CSSProperties {
  return {
    fontFamily: 'inherit',
    fontSize: 10,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    padding: '5px 10px',
    background: 'rgba(79, 216, 255, 0.08)',
    border: `1px solid ${color}`,
    color,
    borderRadius: 2,
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  }
}
