import { useEffect, useState } from 'react'
import { Panel, EmptyState } from './Panel'

interface PersistentContextShape {
  routines: Array<{ name: string; description: string }>
}

/**
 * Foundation only — reads whatever's in ContextManager's persistent
 * routines list (empty until routines/skills are actually built). See the
 * plan's Context Manager priority: this panel exists so future routines
 * have somewhere to show up, not because routines are implemented yet.
 */
export default function RoutinesPanel(): React.JSX.Element {
  const [routines, setRoutines] = useState<Array<{ name: string; description: string }>>([])

  useEffect(() => {
    window.jarvis.getPersistentContext().then((ctx) => {
      setRoutines((ctx as PersistentContextShape).routines ?? [])
    })
  }, [])

  return (
    <Panel title="Routines & Skills">
      {routines.length === 0 && <EmptyState text="No routines configured yet." />}
      {routines.map((r) => (
        <div key={r.name} style={{ marginBottom: 4 }}>
          <div>{r.name}</div>
          <div style={{ opacity: 0.5, fontSize: 11 }}>{r.description}</div>
        </div>
      ))}
    </Panel>
  )
}
