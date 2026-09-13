import { useEffect, useRef } from 'react'
import Core from './hud/Core'
import Rings from './hud/Rings'
import Transcript from './hud/Transcript'
import DevStateSwitcher from './hud/DevStateSwitcher'
import ToolConfirm from './hud/ToolConfirm'
import CommandCenterLauncher from './hud/CommandCenterLauncher'
import { useHudStore, type HudState } from './state/hudStore'
import { useTranscriptStore } from './state/transcriptStore'
import { useToolBridge } from './state/useToolBridge'
import { subscribeAmplitude } from './hud/core/amplitudeBus'
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
 * at any point. The mic is a single instance for the whole session (not
 * recreated per turn) so it can also just *monitor* for barge-in while
 * JARVIS is thinking/speaking, without streaming to Deepgram — see
 * audio/capture.ts's mode switch and main/voice/session.ts's bargeIn().
 */
export default function App(): React.JSX.Element {
  const micRef = useRef<MicCapture | null>(null)
  const ttsRef = useRef<TtsPlayback | null>(null)

  useToolBridge()

  // Ambient is the only window with a real audio graph — forward its live
  // amplitude (throttled) so Command Center's core can react to it too,
  // without giving Command Center its own mic/TTS pipeline.
  useEffect(() => {
    let lastSent = 0
    return subscribeAmplitude((value) => {
      const now = performance.now()
      if (now - lastSent < 33 && value !== null) return
      lastSent = now
      window.jarvis.reportAmplitude(value)
    })
  }, [])

  useEffect(() => {
    function beginListening(mic: MicCapture): void {
      useTranscriptStore.getState().resetForNewTurn()
      useHudStore.getState().setState('listening')
      mic.setMode('stream')
      window.jarvis.startListening(mic.sampleRate)
    }

    function handleBargeIn(preroll: ArrayBuffer[]): void {
      const mic = micRef.current
      if (!mic) return
      ttsRef.current?.abort()
      ttsRef.current = null // abort() permanently mutes this instance — drop it so 'thinking' creates a fresh one
      beginListening(mic)
      window.jarvis.notifyBargeIn(mic.sampleRate, preroll)
    }

    function teardown(): void {
      micRef.current?.stop()
      micRef.current = null
      ttsRef.current?.close()
      ttsRef.current = null
    }

    const unsubscribers = [
      // Session start/end (hotkey) — not per-turn, see session.ts.
      window.jarvis.onToggleListening(({ listening }) => {
        if (!listening) {
          teardown()
          return
        }

        const mic = new MicCapture()
        micRef.current = mic
        mic
          .start()
          .then(() => {
            if (micRef.current !== mic) {
              mic.stop() // session ended before the mic finished initializing
              return
            }
            mic.setBargeInHandler(handleBargeIn)
            mic.beginStreaming()
            beginListening(mic)
          })
          .catch((err) => {
            console.error('[jarvis] microphone capture failed:', err)
            useHudStore.getState().setState('error')
            micRef.current = null
          })
      }),

      // Main resumed the session for the next turn (previous reply finished
      // playing, or the user paused without saying anything). Same mic
      // instance throughout — just flip it back to full streaming.
      window.jarvis.onResumeListening(() => {
        if (micRef.current) beginListening(micRef.current)
      }),

      window.jarvis.onSessionEnded(() => {
        teardown()
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
          // Don't stop the mic — just stop streaming it, so barge-in can
          // still watch for the user talking over JARVIS.
          micRef.current?.setMode('monitor')
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
      teardown()
    }
  }, [])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Rings />
      <Core />
      <Transcript />
      <ToolConfirm />
      <CommandCenterLauncher />
      {import.meta.env.DEV && <DevStateSwitcher />}
    </div>
  )
}
