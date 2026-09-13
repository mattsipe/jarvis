import { useEffect, useMemo, useState } from 'react'
import { Panel, EmptyState } from './Panel'

interface MemoryRecord {
  id: string
  kind: string
  subject: string
  content: string
  source: 'explicit' | 'learned'
  confidence: number
  updatedAt: string
}

const FILTERS = ['all', 'explicit', 'learned'] as const
type Filter = (typeof FILTERS)[number]

/**
 * Lists everything JARVIS remembers (context/memory.ts) — every record
 * the remember/recall_memory/update_memory/forget_memory tools use, so an
 * edit or delete here is visible to JARVIS on its very next turn. The
 * "learned" filter is what makes silent auto-learning (see
 * context/autolearn.ts) auditable, per the confirmed policy.
 */
export default function MemoryPanel(): React.JSX.Element {
  const [records, setRecords] = useState<MemoryRecord[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const refresh = (): void => {
    window.jarvis.getMemoryList().then((list) => setRecords(list as MemoryRecord[]))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visible = useMemo(() => (filter === 'all' ? records : records.filter((r) => r.source === filter)), [records, filter])

  const startEdit = (r: MemoryRecord): void => {
    setEditingId(r.id)
    setDraft(r.content)
  }

  const saveEdit = async (id: string): Promise<void> => {
    await window.jarvis.updateMemory(id, draft)
    setEditingId(null)
    refresh()
  }

  const remove = async (id: string): Promise<void> => {
    await window.jarvis.deleteMemory(id)
    refresh()
  }

  return (
    <Panel title="Memory" style={{ flex: 1 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              fontFamily: 'inherit',
              fontSize: 10,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '3px 8px',
              background: filter === f ? 'rgba(79, 216, 255, 0.15)' : 'transparent',
              border: '1px solid var(--jarvis-hairline)',
              color: filter === f ? 'var(--jarvis-cyan)' : 'inherit',
              opacity: filter === f ? 1 : 0.6,
              borderRadius: 2,
              cursor: 'pointer'
            }}
          >
            {f === 'learned' ? 'Learned this week' : f}
          </button>
        ))}
      </div>

      {visible.length === 0 && <EmptyState text="Nothing remembered yet." />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {visible.map((r) => (
          <div key={r.id} style={{ borderBottom: '1px solid var(--jarvis-hairline)', paddingBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, opacity: 0.6 }}>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {r.kind} · {r.subject}
              </span>
              <span>{r.source === 'learned' ? `learned (${Math.round(r.confidence * 100)}%)` : 'explicit'}</span>
            </div>
            {editingId === r.id ? (
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  style={{
                    flex: 1,
                    fontFamily: 'inherit',
                    fontSize: 11,
                    background: 'rgba(0,0,0,0.35)',
                    border: '1px solid var(--jarvis-hairline)',
                    color: '#e6f2ff',
                    borderRadius: 2,
                    padding: '4px 6px'
                  }}
                />
                <button onClick={() => saveEdit(r.id)} style={linkButtonStyle('var(--jarvis-emerald)')}>
                  Save
                </button>
                <button onClick={() => setEditingId(null)} style={linkButtonStyle()}>
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginTop: 2 }}>
                <span style={{ fontSize: 12 }}>{r.content}</span>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button onClick={() => startEdit(r)} style={linkButtonStyle()}>
                    Edit
                  </button>
                  <button onClick={() => remove(r.id)} style={linkButtonStyle('var(--jarvis-amber)')}>
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  )
}

function linkButtonStyle(color = 'var(--jarvis-cyan)'): React.CSSProperties {
  return {
    fontFamily: 'inherit',
    fontSize: 10,
    letterSpacing: '0.04em',
    background: 'none',
    border: 'none',
    color,
    opacity: 0.85,
    cursor: 'pointer',
    padding: 0
  }
}
