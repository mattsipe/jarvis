import { create } from 'zustand'

interface VoiceErrorState {
  message: string | null
  stage: string | null
  setError: (message: string, stage: string) => void
  clear: () => void
}

const AUTO_CLEAR_MS = 8000
let clearTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Surfaces a plain-language reason whenever voice startup/operation fails —
 * see ErrorBanner.tsx. Previously a voice error only ever turned the core
 * red with no explanation anywhere in the UI; this is the fix for that.
 */
export const useVoiceErrorStore = create<VoiceErrorState>((set) => ({
  message: null,
  stage: null,
  setError: (message, stage) => {
    if (clearTimer) clearTimeout(clearTimer)
    set({ message, stage })
    clearTimer = setTimeout(() => set({ message: null, stage: null }), AUTO_CLEAR_MS)
  },
  clear: () => {
    if (clearTimer) clearTimeout(clearTimer)
    set({ message: null, stage: null })
  }
}))
