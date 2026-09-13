import { create } from 'zustand'

interface TranscriptState {
  userInterim: string
  userFinal: string
  assistantText: string
  setUserTranscript: (text: string, isFinal: boolean) => void
  appendAssistantText: (sentence: string) => void
  resetForNewTurn: () => void
}

export const useTranscriptStore = create<TranscriptState>((set) => ({
  userInterim: '',
  userFinal: '',
  assistantText: '',

  setUserTranscript: (text, isFinal) =>
    set((s) =>
      isFinal
        ? { userFinal: `${s.userFinal} ${text}`.trim(), userInterim: '' }
        : { userInterim: text }
    ),

  appendAssistantText: (sentence) =>
    set((s) => ({ assistantText: `${s.assistantText} ${sentence}`.trim() })),

  resetForNewTurn: () => set({ userInterim: '', userFinal: '', assistantText: '' })
}))
