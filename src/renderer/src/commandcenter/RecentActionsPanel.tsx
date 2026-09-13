import { useState } from 'react'
import { useToolStore } from '../state/toolStore'
import { Panel, EmptyState } from './Panel'

const STATUS_COLOR: Record<string, string> = {
  started: 'var(--jarvis-cyan)',
  'confirm-pending': 'var(--jarvis-amber)',
  success: 'var(--jarvis-emerald)',
  error: 'var(--jarvis-amber)',
  denied: 'var(--jarvis-amber)'
}

function formatArgs(input: unknown): string | null {
  if (input == null) return null
  const str = typeof input === 'object' ? JSON.stringify(input) : String(input)
  return str && str !== '{}' ? str : null
}

interface SelfTestResult {
  ok: boolean
  message: string
}

/**
 * Tool activity feed, plus a "Run Self-Test" trigger for the Windows
 * platform diagnostics (see main/platform/windows.ts's selfTest()) — the
 * one action in this panel that runs without a voice turn at all, per the
 * "self-test without requiring voice" requirement. Every entry now also
 * shows its arguments and (on failure) the adapter/duration/exit
 * code/stderr captured by ToolRegistry.execute, so a real-Windows failure
 * is diagnosable straight from this panel instead of just "it failed."
 */
export default function RecentActionsPanel(): React.JSX.Element {
  const activity = useToolStore((s) => s.activity)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const runSelfTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = (await window.jarvis.runSelfTest()) as SelfTestResult
      setTestResult(result.message)
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Panel title="Recent Actions" style={{ flex: 1 }}>
      <button
        onClick={runSelfTest}
        disabled={testing}
        style={{
          fontFamily: 'inherit',
          fontSize: 10,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          padding: '5px 10px',
          background: 'rgba(79, 216, 255, 0.1)',
          border: '1px solid var(--jarvis-hairline)',
          color: 'var(--jarvis-cyan)',
          borderRadius: 2,
          cursor: testing ? 'default' : 'pointer',
          alignSelf: 'flex-start'
        }}
      >
        {testing ? 'Running Self-Test…' : 'Run Self-Test'}
      </button>
      {testResult && <div style={{ fontSize: 11, opacity: 0.7 }}>{testResult}</div>}

      <div style={{ height: 2 }} />
      {activity.length === 0 && <EmptyState text="No actions yet." />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {activity.map((a) => {
          const args = formatArgs(a.input)
          const d = a.diagnostics
          const showDiagnostics = d && (d.stderr || d.exitCode != null || d.durationMs != null)
          return (
            <div key={a.id} style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{a.name}</span>
                <span style={{ color: STATUS_COLOR[a.status], fontSize: 10, textTransform: 'uppercase' }}>
                  {a.status}
                </span>
              </div>
              {args && <div style={{ opacity: 0.4, fontSize: 10 }}>{args}</div>}
              {a.message && <div style={{ opacity: 0.55, fontSize: 11 }}>{a.message}</div>}
              {showDiagnostics && (
                <div style={{ opacity: 0.4, fontSize: 10 }}>
                  {[
                    d?.adapter,
                    d?.durationMs != null ? `${d.durationMs}ms` : null,
                    d?.exitCode != null ? `exit ${d.exitCode}` : null,
                    d?.stderr ? d.stderr.slice(0, 160) : null
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
