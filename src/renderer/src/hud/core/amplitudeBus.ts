/**
 * Tiny pub-sub singleton carrying live audio amplitude (mic while
 * listening, TTS playback while speaking) from the audio layer to the
 * three.js core. Deliberately not React/zustand state — this updates at
 * audio-callback rate and must never trigger a React re-render.
 *
 * `null` means "no live audio right now" — JarvisCore falls back to its
 * simulated per-state pulse (see JarvisCore.setExternalAmplitude). A
 * numeric 0 is a real (silent) sample, so the two are kept distinct.
 */
type Listener = (amplitude: number | null) => void

const listeners = new Set<Listener>()

export function setAmplitude(value: number | null): void {
  listeners.forEach((l) => l(value))
}

export function subscribeAmplitude(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
