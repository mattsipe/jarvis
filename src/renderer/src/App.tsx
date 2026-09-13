import { useEffect, useRef } from 'react'
import Core from './hud/Core'
import Rings from './hud/Rings'
import Transcript from './hud/Transcript'
import DevStateSwitcher from './hud/DevStateSwitcher'
import ToolConfirm from './hud/ToolConfirm'
import CommandCenterLauncher from './hud/CommandCenterLauncher'
import ErrorBanner from './hud/ErrorBanner'
import { useHudStore, type HudState } from './state/hudStore'
import { useTranscriptStore } from './state/transcriptStore'
import { useToolBridge } from './state/useToolBridge'
import { useVoiceErrorStore } from './state/voiceErrorStore'
import { subscribeAmplitude } from './hud/core/amplitudeBus'
import { MicCapture, describeMicError } from './audio/capture'
import { PresenceMicCapture } from './audio/presenceCapture'
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
  const presenceMicRef = useRef<PresenceMicCapture | null>(null)
  const presenceMicStartingRef = useRef(false)

  useToolBridge()

  // Presence's always-on wake-word mic — strictly driven by main's
  // presence:state broadcasts (micActive is only ever true while Presence
  // is 'sleeping': enabled, engine ready, no session active, not muted).
  // Never started/stopped from any local guess about state, so it can
  // never disagree with main about whether the wake-word mic should be
  // running — see presence/index.ts's state precedence.
  useEffect(() => {
    async function syncPresenceMic(micActive: boolean): Promise<void> {
      if (micActive) {
        if (presenceMicRef.current || presenceMicStartingRef.current) return
        presenceMicStartingRef.current = true
        const mic = new PresenceMicCapture()
        try {
          await mic.start()
          presenceMicRef.current = mic
        } catch (err) {
          console.error('[jarvis] presence mic capture failed:', err)
          window.jarvis.reportVoiceError({ message: describeMicError(err), stage: 'presence-mic' })
        } finally {
          presenceMicStartingRef.current = false
        }
      } else {
        presenceMicRef.current?.stop()
        presenceMicRef.current = null
      }
    }

    const unsubscribe = window.jarvis.onPresenceState((status) => {
      void syncPresenceMic(Boolean(status.micActive))
    })
    // The first presence:state broadcast can race this window's own
    // load (main calls presence.start() right after creating it) — ask
    // directly too, so Presence doesn't silently stay off until the next
    // state change happens to fire.
    window.jarvis.getPresenceStatus().then((status) => {
      void syncPresenceMic(Boolean((status as { micActive?: boolean }).micActive))
    })

    return () => {
      unsubscribe()
      presenceMicRef.current?.stop()
      presenceMicRef.current = null
    }
  }, [])

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
            const message = describeMicError(err)
            console.error('[jarvis] microphone capture failed:', err)
            window.jarvis.reportVoiceError({ message, stage: 'mic' })
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
        useVoiceErrorStore.getState().setError(message, stage)
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
      <ErrorBanner />
      <CommandCenterLauncher />
      {import.meta.env.DEV && <DevStateSwitcher />}
    </div>
  )
}
