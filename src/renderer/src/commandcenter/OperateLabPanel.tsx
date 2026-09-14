import { useEffect, useState } from 'react'
import { Panel, EmptyState, Row } from './Panel'

interface WindowInfo {
  hwnd: number
  title: string
  processName: string
  processId: number
  bounds: { x: number; y: number; width: number; height: number }
}

interface ElementSummary {
  ref: string
  role: string | null
  name: string | null
  automationId: string | null
  enabled: boolean
  state: string | null
  patterns: string[]
}

interface ElementDetail extends ElementSummary {
  boundingRect?: { x: number; y: number; width: number; height: number }
}

interface InspectData {
  elements?: ElementSummary[]
  window?: { hwnd: number; title: string | null; processName: string | null }
  truncated?: boolean
  element?: ElementDetail
}

interface LabToolResult {
  ok: boolean
  message: string
  data?: InspectData & { ambiguous?: boolean; candidates?: ElementSummary[] }
}

const ACTIONS = ['invoke', 'toggle', 'set_value', 'select', 'expand', 'collapse', 'focus', 'scroll'] as const

/**
 * Self-contained real-PC validation for Operate (see the plan's "Operate
 * Lab" section) — pick a real window, inspect/query its UIA elements,
 * highlight one, and run an action against it, with the same SENT vs
 * VERIFIED result a voice call would get. Every action here goes through
 * the real ui_inspect/ui_act tools (main/tools/operate.ts) via
 * runToolStandalone, so it's identical to what Claude would do — no
 * separate testing code path to drift out of sync.
 */
export default function OperateLabPanel(): React.JSX.Element {
  const [windows, setWindows] = useState<WindowInfo[]>([])
  const [selectedHwnd, setSelectedHwnd] = useState<string>('active')
  const [query, setQuery] = useState('')
  const [elements, setElements] = useState<ElementSummary[]>([])
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  const [action, setAction] = useState<(typeof ACTIONS)[number]>('toggle')
  const [desiredState, setDesiredState] = useState<'on' | 'off'>('on')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastResult, setLastResult] = useState<LabToolResult | null>(null)
  const [trace, setTrace] = useState<unknown>(null)

  const refreshWindows = (): void => {
    window.jarvis.operateListWindows().then((list) => setWindows(list as WindowInfo[]))
  }

  useEffect(() => {
    refreshWindows()
  }, [])

  const windowParam = selectedHwnd === 'active' ? undefined : selectedHwnd

  const runInspect = async (): Promise<void> => {
    setBusy(true)
    setLastResult(null)
    try {
      const result = (await window.jarvis.operateInspect({ window: windowParam, query: query || undefined })) as LabToolResult
      setLastResult(result)
      setElements(result.data?.elements ?? [])
      setTrace(result)
    } finally {
      setBusy(false)
    }
  }

  const highlight = async (ref: string): Promise<void> => {
    setSelectedRef(ref)
    const detailResult = (await window.jarvis.operateInspect({ window: windowParam, ref })) as LabToolResult
    const rect = detailResult.data?.element?.boundingRect
    if (rect) await window.jarvis.operateHighlight(rect)
  }

  const runAct = async (): Promise<void> => {
    if (!selectedRef) return
    setBusy(true)
    setLastResult(null)
    try {
      const input: Record<string, unknown> = {
        target: { ref: selectedRef },
        action,
        intent: `Operate Lab: ${action} ${selectedRef}`
      }
      if (action === 'toggle') input.desiredState = desiredState
      if (action === 'set_value') input.value = value
      const result = (await window.jarvis.operateAct(input)) as LabToolResult
      setLastResult(result)
      setTrace(result)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Operate Lab" style={{ flex: 1 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <div style={labelStyle}>Window</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={selectedHwnd} onChange={(e) => setSelectedHwnd(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
              <option value="active">Active window</option>
              {windows.map((w) => (
                <option key={w.hwnd} value={String(w.hwnd)}>
                  {w.title || w.processName} ({w.processName})
                </option>
              ))}
            </select>
            <button onClick={refreshWindows} style={buttonStyle('var(--jarvis-cyan)')}>
              Refresh
            </button>
          </div>
        </div>

        <div>
          <div style={labelStyle}>Query / Inspect</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. bluetooth" style={{ ...inputStyle, flex: 1 }} />
            <button onClick={runInspect} disabled={busy} style={buttonStyle('var(--jarvis-cyan)')}>
              {busy ? 'Inspecting…' : 'Inspect'}
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6, maxHeight: 140, overflowY: 'auto' }}>
            {elements.length === 0 && <EmptyState text="No elements inspected yet." />}
            {elements.map((e) => (
              <div
                key={e.ref}
                onClick={() => highlight(e.ref)}
                style={{
                  fontSize: 10,
                  padding: '3px 4px',
                  cursor: 'pointer',
                  background: selectedRef === e.ref ? 'rgba(79, 216, 255, 0.15)' : 'transparent',
                  border: selectedRef === e.ref ? '1px solid var(--jarvis-cyan)' : '1px solid transparent',
                  borderRadius: 2
                }}
              >
                <span style={{ opacity: 0.6 }}>{e.ref}</span> {e.role} &quot;{e.name}&quot;
                {e.state ? ` [${e.state}]` : ''}
                {!e.enabled ? ' (disabled)' : ''}
              </div>
            ))}
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--jarvis-hairline)' }} />

        <div>
          <div style={labelStyle}>Act on selected ({selectedRef ?? 'none — click an element above'})</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={action} onChange={(e) => setAction(e.target.value as (typeof ACTIONS)[number])} style={inputStyle}>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            {action === 'toggle' && (
              <select value={desiredState} onChange={(e) => setDesiredState(e.target.value as 'on' | 'off')} style={inputStyle}>
                <option value="on">on</option>
                <option value="off">off</option>
              </select>
            )}
            {action === 'set_value' && (
              <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" style={inputStyle} />
            )}
            <button onClick={runAct} disabled={busy || !selectedRef} style={buttonStyle('var(--jarvis-amber)')}>
              {busy ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>

        {lastResult && (
          <div style={{ fontSize: 11 }}>
            <Row label="SENT" value={lastResult.ok ? 'yes' : 'no'} />
            <div style={{ opacity: 0.7, marginTop: 2 }}>{lastResult.message}</div>
          </div>
        )}

        {trace != null && (
          <button
            onClick={() => navigator.clipboard?.writeText(JSON.stringify(trace, null, 2))}
            style={{ ...buttonStyle('var(--jarvis-cyan)'), alignSelf: 'flex-start' }}
          >
            Copy trace
          </button>
        )}
      </div>
    </Panel>
  )
}

const labelStyle: React.CSSProperties = { fontSize: 10, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }

const inputStyle: React.CSSProperties = {
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
