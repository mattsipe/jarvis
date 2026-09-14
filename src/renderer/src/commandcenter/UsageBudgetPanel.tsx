import { useEffect, useState } from 'react'
import { Panel, Row, EmptyState } from './Panel'

interface ModelUsageSnapshot {
  model: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requestCount: number
  estimatedCostUsd: number
}

interface PeriodSnapshot {
  anthropicByModel: ModelUsageSnapshot[]
  deepgramSeconds: number
  elevenLabsChars: number
  sessionCount: number
  estimatedCostUsd: number
}

interface UsageSnapshot {
  since: string
  today: PeriodSnapshot
  thisMonth: PeriodSnapshot
  allTime: PeriodSnapshot
}

interface BudgetConfig {
  protectionEnabled: boolean
  dailySoftUsd: number | null
  dailyHardUsd: number | null
  monthlySoftUsd: number | null
  monthlyHardUsd: number | null
  maxTurnTokens: number
  maxTurnWallMs: number
  routingPolicy: 'optimized' | 'legacy'
}

interface CallRecord {
  model: string
  purpose: 'chain' | 'plan' | 'replan' | 'summary' | 'autolearn'
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  costUsd: number
  unpriced: boolean
  contextTokens: number
}

interface TurnRecord {
  turnId: string
  route: string
  routeReason: string
  escalated: boolean
  replans: number
  calls: CallRecord[]
  totalCostUsd: number
  totalContextTokens: number
  localHandled: boolean
  startedAt: number
  endedAt: number
}

interface BudgetStatus {
  config: BudgetConfig
  usage: UsageSnapshot
  daily: { softCrossed: boolean; hardCrossed: boolean }
  monthly: { softCrossed: boolean; hardCrossed: boolean }
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

function statusColor(hardCrossed: boolean, softCrossed: boolean): string {
  if (hardCrossed) return 'var(--jarvis-amber)'
  if (softCrossed) return '#e0c34a'
  return 'var(--jarvis-emerald)'
}

const numberInputStyle: React.CSSProperties = {
  width: 70,
  fontFamily: 'inherit',
  fontSize: 11,
  background: 'rgba(0,0,0,0.35)',
  border: '1px solid var(--jarvis-hairline)',
  color: '#e6f2ff',
  borderRadius: 2,
  padding: '3px 5px',
  textAlign: 'right'
}

function LimitField({
  label,
  value,
  onCommit
}: {
  label: string
  value: number | null
  onCommit: (n: number | null) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value == null ? '' : String(value))

  useEffect(() => {
    setDraft(value == null ? '' : String(value))
  }, [value])

  const commit = (): void => {
    if (draft.trim() === '') {
      onCommit(null)
      return
    }
    const n = Number(draft)
    if (Number.isFinite(n) && n >= 0) onCommit(n)
    else setDraft(value == null ? '' : String(value))
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '2px 0' }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ opacity: 0.5 }}>$</span>
        <input
          value={draft}
          placeholder="unlimited"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          style={numberInputStyle}
        />
      </span>
    </div>
  )
}

/**
 * Command Center's window into the centralized usage/budget manager (see
 * main/usage/) — today's and this month's spend per provider/model against
 * the configured soft/hard limits, the master protection switch, and the
 * limits themselves (editable here rather than only via env vars). A
 * 50/75/90% warning broadcast (usage:warning) briefly highlights the
 * relevant period's row instead of a separate banner, per the "expose
 * cleanly" ask rather than adding more chrome.
 */
export default function UsageBudgetPanel(): React.JSX.Element {
  const [status, setStatus] = useState<BudgetStatus | null>(null)
  const [flash, setFlash] = useState<'daily' | 'monthly' | null>(null)
  const [turns, setTurns] = useState<TurnRecord[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = (): void => {
    window.jarvis.getBudgetStatus().then((s) => setStatus(s as BudgetStatus))
  }

  const refreshTurns = (): void => {
    window.jarvis.getRecentTurns().then((t) => setTurns(t as TurnRecord[]))
  }

  useEffect(() => {
    refresh()
    refreshTurns()
    const poll = setInterval(refresh, 15000)
    const unsubscribeWarning = window.jarvis.onBudgetWarning(({ period }) => {
      setFlash(period)
      refresh()
      setTimeout(() => setFlash(null), 4000)
    })
    const unsubscribeTurn = window.jarvis.onUsageTurn(() => refreshTurns())
    return () => {
      clearInterval(poll)
      unsubscribeWarning()
      unsubscribeTurn()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setConfig = (patch: Partial<BudgetConfig>): void => {
    window.jarvis.setBudgetConfig(patch).then((s) => setStatus(s as BudgetStatus))
  }

  if (!status) {
    return (
      <Panel title="Usage & Budget">
        <EmptyState text="Loading…" />
      </Panel>
    )
  }

  const { config, usage, daily, monthly } = status

  return (
    <Panel title="Usage & Budget" style={{ flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.7 }}>Protection</span>
        <button
          onClick={() => setConfig({ protectionEnabled: !config.protectionEnabled })}
          style={{
            fontFamily: 'inherit',
            fontSize: 10,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            padding: '3px 10px',
            background: config.protectionEnabled ? 'rgba(59, 240, 192, 0.12)' : 'rgba(255, 107, 74, 0.12)',
            border: `1px solid ${config.protectionEnabled ? 'var(--jarvis-emerald)' : 'var(--jarvis-amber)'}`,
            color: config.protectionEnabled ? 'var(--jarvis-emerald)' : 'var(--jarvis-amber)',
            borderRadius: 2,
            cursor: 'pointer'
          }}
        >
          {config.protectionEnabled ? 'On' : 'Off'}
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 8px' }}>
        <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.7 }} title="Validation-only A/B toggle for the Cost + Context Optimization milestone — 'legacy' is the frozen v0.10.0-test.1 behavior.">
          Routing policy
        </span>
        <button
          onClick={() => setConfig({ routingPolicy: config.routingPolicy === 'optimized' ? 'legacy' : 'optimized' })}
          style={{
            fontFamily: 'inherit',
            fontSize: 10,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            padding: '3px 10px',
            background: 'rgba(79, 216, 255, 0.08)',
            border: '1px solid var(--jarvis-cyan)',
            color: 'var(--jarvis-cyan)',
            borderRadius: 2,
            cursor: 'pointer'
          }}
        >
          {config.routingPolicy}
        </button>
      </div>

      <div
        style={{
          padding: '4px 0',
          borderTop: '1px solid var(--jarvis-hairline)',
          borderBottom: '1px solid var(--jarvis-hairline)',
          background: flash === 'daily' ? 'rgba(224, 195, 74, 0.1)' : 'transparent'
        }}
      >
        <Row
          label="Today"
          value={`${usd(usage.today.estimatedCostUsd)}${config.dailyHardUsd != null ? ` / ${usd(config.dailyHardUsd)}` : ''}`}
        />
      </div>
      <div style={{ height: 4 }} />
      <div style={{ background: flash === 'monthly' ? 'rgba(224, 195, 74, 0.1)' : 'transparent', paddingBottom: 4 }}>
        <Row
          label="This month"
          value={`${usd(usage.thisMonth.estimatedCostUsd)}${config.monthlyHardUsd != null ? ` / ${usd(config.monthlyHardUsd)}` : ''}`}
        />
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 10, marginBottom: 6 }}>
        <span style={{ color: statusColor(daily.hardCrossed, daily.softCrossed) }}>● daily</span>
        <span style={{ color: statusColor(monthly.hardCrossed, monthly.softCrossed) }}>● monthly</span>
      </div>

      {usage.today.anthropicByModel.length === 0 && usage.today.deepgramSeconds === 0 && usage.today.elevenLabsChars === 0 ? (
        <EmptyState text="No usage recorded yet today." />
      ) : (
        <>
          {usage.today.anthropicByModel.map((m) => (
            <Row key={m.model} label={m.model} value={`${(m.inputTokens + m.outputTokens).toLocaleString()} tok · ${usd(m.estimatedCostUsd)}`} />
          ))}
          <Row label="Deepgram (today)" value={`${(usage.today.deepgramSeconds / 60).toFixed(1)} min`} />
          <Row label="ElevenLabs (today)" value={`${usage.today.elevenLabsChars.toLocaleString()} chars`} />
        </>
      )}

      <div style={{ height: 8 }} />
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.7, marginBottom: 2 }}>Limits</div>
      <LimitField label="Daily soft" value={config.dailySoftUsd} onCommit={(n) => setConfig({ dailySoftUsd: n })} />
      <LimitField label="Daily hard" value={config.dailyHardUsd} onCommit={(n) => setConfig({ dailyHardUsd: n })} />
      <LimitField label="Monthly soft" value={config.monthlySoftUsd} onCommit={(n) => setConfig({ monthlySoftUsd: n })} />
      <LimitField label="Monthly hard" value={config.monthlyHardUsd} onCommit={(n) => setConfig({ monthlyHardUsd: n })} />

      <div style={{ height: 8 }} />
      <Row label="All-time" value={usd(usage.allTime.estimatedCostUsd)} />
      <Row label="Sessions (all-time)" value={String(usage.allTime.sessionCount)} />

      <div style={{ height: 8 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
        <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.7 }}>Recent turns</span>
        <button
          onClick={() => navigator.clipboard?.writeText(JSON.stringify(turns, null, 2))}
          style={{
            fontFamily: 'inherit',
            fontSize: 10,
            padding: '2px 8px',
            background: 'rgba(79, 216, 255, 0.08)',
            border: '1px solid var(--jarvis-hairline)',
            color: 'var(--jarvis-cyan)',
            borderRadius: 2,
            cursor: 'pointer'
          }}
        >
          Copy
        </button>
      </div>
      {turns.length === 0 ? (
        <EmptyState text="No turns recorded yet this session." />
      ) : (
        <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {turns.map((t) => (
            <div key={t.turnId} style={{ fontSize: 10, border: '1px solid var(--jarvis-hairline)', borderRadius: 2, padding: '3px 5px' }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', cursor: t.calls.length > 0 ? 'pointer' : 'default' }}
                onClick={() => t.calls.length > 0 && setExpanded(expanded === t.turnId ? null : t.turnId)}
              >
                <span>
                  <span style={{ color: t.localHandled ? 'var(--jarvis-emerald)' : 'var(--jarvis-cyan)' }}>{t.route}</span>
                  {t.escalated ? ' ↑' : ''}
                  {t.replans > 0 ? ` ↻${t.replans}` : ''}
                </span>
                <span style={{ opacity: 0.7 }}>{t.localHandled ? '0 tok' : `${usd(t.totalCostUsd)} · ${t.totalContextTokens.toLocaleString()} tok`}</span>
              </div>
              {expanded === t.turnId && (
                <div style={{ marginTop: 3, paddingLeft: 6, opacity: 0.75 }}>
                  {t.calls.map((c, i) => (
                    <div key={i}>
                      {c.purpose} · {c.model} · in {c.inputTokens} out {c.outputTokens} cacheR {c.cacheReadTokens} cacheW {c.cacheWriteTokens} · {c.unpriced ? 'unpriced' : usd(c.costUsd)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
