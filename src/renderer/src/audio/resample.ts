/**
 * Pure linear-interpolation resampler — no DOM/AudioContext APIs, so it's
 * directly unit-testable. Exists because `new AudioContext({ sampleRate:
 * 16000 })` is a REQUEST, not a guarantee: Chromium is free to give back a
 * context running at the device's native rate instead (commonly 44100 or
 * 48000 on Windows), and the previous version of presenceCapture.ts sent
 * whatever came out assuming it was already 16kHz. The wake-word engine
 * requires exactly 16kHz input — audio at the wrong rate doesn't error,
 * it just silently never matches "hey jarvis" (wrong pitch/timing reaches
 * the model), which is exactly the "no error, just doesn't work" report
 * that prompted writing this. Not audiophile-grade (no anti-aliasing
 * filter), but more than sufficient for a keyword-spotting model trained
 * on synthetic/reverberated speech in the first place.
 */
export function downsampleTo16k(input: Float32Array, inputSampleRate: number, targetSampleRate = 16000): Float32Array {
  if (inputSampleRate === targetSampleRate) return input
  if (inputSampleRate < targetSampleRate) {
    throw new Error(`downsampleTo16k: input rate ${inputSampleRate}Hz is below the ${targetSampleRate}Hz target — upsampling isn't supported here`)
  }
  const ratio = inputSampleRate / targetSampleRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio
    const i0 = Math.floor(srcIndex)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = srcIndex - i0
    output[i] = input[i0] + (input[i1] - input[i0]) * frac
  }
  return output
}
