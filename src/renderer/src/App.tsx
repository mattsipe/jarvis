import { useEffect, useRef } from 'react'
import Core from './hud/Core'
import Rings from './hud/Rings'
import Transcript from './hud/Transcript'
import DevStateSwitcher from './hud/DevStateSwitcher'
import { useHudStore, type HudState } from './state/hudStore'
import { useTranscriptStore } from './state/transcriptStore'
import { MicCapture } from './audio/capture'
import { TtsPlayback } from './audio/playback'

const HUD_STATES: readonly HudState[] = [
  'ambient',
  'listening',
  'thinking',
  'acting',
  'speaking',
  'success',
  'error'
]
function isHudState(v: string): v is HudState {
  return (HUD_STATES as readonly string[]).includes(v)
}

/**
 * M1 HUD shell (Core/Rings/DevStateSwitcher) plus the M2 voice loop: one
 * hotkey press starts a continuous conversation — each utterance
 * auto-submits on a pause (Deepgram speechFinal, main-side), listening
 * resumes automatically once JARVIS's reply has actually finished
 * *playing* (not just generating), and the same hotkey ends the session
 * at any point. See main/voice/session.ts for the session state machine.
 */
export default function App(): React.JSX.Element {
  const micRef = useRef<MicCapture | null>(null)
  const ttsRef = useRef<TtsPlayback | null>(null)

  useEffect(() => {
    function beginListening(): void {
      useTranscriptStore.getState().resetForNewTurn()
      useHudStore.getState().setState('listening')

      const mic = new MicCapture()
      micRef.current = mic
      mic
        .start()
        .then((sampleRate) => {
          // Guard against the session ending before the mic finished initializing.
          if (micRef.current !== mic) {
            mic.stop()
            return
          }
          window.jarvis.startListening(sampleRate)
          mic.beginStreaming()
        })
        .catch((err) => {
          console.error('[jarvis] microphone capture failed:', err)
          useHudStore.getState().setState('error')
          micRef.current = null
        })
    }

    function stopMic(): void {
      micRef.current?.stop()
      micRef.current = null
    }

    const unsubscribers = [
      // Session start/end (hotkey) — NOT per-turn anymore, see session.ts.
      window.jarvis.onToggleListening(({ listening }) => {
        if (listening) {
          beginListening()
        } else {
          stopMic()
        }
      }),

      // Main resumed the session for the next turn (previous reply finished
      // playing, or the user paused without saying anything).
      window.jarvis.onResumeListening(() => {
        beginListening()
      }),

      window.jarvis.onSessionEnded(() => {
        stopMic()
        ttsRef.current?.close()
        ttsRef.current = null
      }),

      window.jarvis.onTranscript(({ text, isFinal }) => {
        useTranscriptStore.getState().setUserTranscript(text, isFinal)
      }),

      window.jarvis.onAssistantText((sentence) => {
        useTranscriptStore.getState().appendAssistantText(sentence)
      }),

      window.jarvis.onHudState((state) => {
        if (!isHudState(state)) return
        if (state === 'thinking') {
          stopMic() // don't let the mic pick up JARVIS's own reply
          if (!ttsRef.current) ttsRef.current = new TtsPlayback()
        }
        useHudStore.getState().setState(state)
      }),

      window.jarvis.onTtsAudioChunk((chunk) => {
        ttsRef.current?.enqueue(chunk)
      }),

      window.jarvis.onTtsDone(() => {
        const tts = ttsRef.current
        if (!tts) return
        tts.markStreamEnded(() => {
          useHudStore.getState().setState('success')
          tts.close()
          if (ttsRef.current === tts) ttsRef.current = null
          // Only main knows whether the session is still active — let it
          // decide whether/when to resume listening.
          window.jarvis.notifyPlaybackFinished()
        })
      }),

      window.jarvis.onVoiceError(({ message, stage }) => {
        console.error(`[jarvis] voice error (${stage}):`, message)
        useHudStore.getState().setState('error')
      })
    ]

    return () => {
      unsubscribers.forEach((unsub) => unsub())
      micRef.current?.stop()
      ttsRef.current?.close()
    }
  }, [])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Rings />
      <Core />
      <Transcript />
      <DevStateSwitcher />
    </div>
  )
}
