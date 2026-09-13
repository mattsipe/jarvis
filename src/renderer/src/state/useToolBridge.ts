import { useEffect } from 'react'
import { useToolStore, type ToolActivityEntry } from './toolStore'

/** Wires main's tool-confirmation/activity broadcasts into useToolStore. Call once per window (Ambient + Command Center each mount it). */
export function useToolBridge(): void {
  useEffect(() => {
    const { setPending, upsertActivity, setActivityHistory } = useToolStore.getState()

    window.jarvis.getToolActivityHistory().then((list) => setActivityHistory(list as ToolActivityEntry[]))

    const unsubscribers = [
      window.jarvis.onToolConfirmRequest((payload) => setPending(payload)),
      window.jarvis.onToolConfirmResolved(() => setPending(null)),
      window.jarvis.onToolActivity((payload) => upsertActivity(payload as unknown as ToolActivityEntry))
    ]
    return () => unsubscribers.forEach((unsub) => unsub())
  }, [])
}
