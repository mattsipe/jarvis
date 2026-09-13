import { create } from 'zustand'

export interface TranscriptTurn {
  role: 'user' | 'assistant'
  text: string
}

interface TranscriptState {
  userInterim: string
  userFinal: string
  assistantText: string
  /** Completed turns from earlier in the session — see resetForNewTurn. Used by the Command Center's conversation panel; Ambient's floating Transcript only ever shows the in-progress turn. */
  history: TranscriptTurn[]
  setUserTranscript: (text: string, isFinal: boolean) => void
  appendAssistantText: (sentence: string) => void
  resetForNewTurn: () => void
}

export const useTranscriptStore = create<TranscriptState>((set) => ({
  userInterim: '',
  userFinal: '',
  assistantText: '',
  history: [],

  setUserTranscript: (text, isFinal) =>
    set((s) =>
      isFinal
        ? { userFinal: `${s.userFinal} ${text}`.trim(), userInterim: '' }
        : { userInterim: text }
    ),

  appendAssistantText: (sentence) =>
    set((s) => ({ assistantText: `${s.assistantText} ${sentence}`.trim() })),

  resetForNewTurn: () =>
    set((s) => {
      const additions: TranscriptTurn[] = []
      if (s.userFinal.trim()) additions.push({ role: 'user', text: s.userFinal.trim() })
      if (s.assistantText.trim()) additions.push({ role: 'assistant', text: s.assistantText.trim() })
      return {
        userInterim: '',
        userFinal: '',
        assistantText: '',
        history: additions.length ? [...s.history, ...additions].slice(-40) : s.history
      }
    })
}))
