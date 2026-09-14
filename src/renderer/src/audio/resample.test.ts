import { describe, it, expect } from 'vitest'
import { downsampleTo16k } from './resample'

describe('audio/resample downsampleTo16k', () => {
  it('returns the same array unchanged when already at the target rate', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(downsampleTo16k(input, 16000)).toBe(input)
  })

  it('halves the sample count when downsampling from 32000 to 16000', () => {
    const input = new Float32Array(3200)
    const out = downsampleTo16k(input, 32000)
    expect(out.length).toBe(1600)
  })

  it('produces the expected length for a real-world 48000 -> 16000 conversion', () => {
    const input = new Float32Array(4800) // 100ms @ 48kHz
    const out = downsampleTo16k(input, 48000)
    expect(out.length).toBe(1600) // 100ms @ 16kHz
  })

  it('preserves a constant signal exactly (DC stays DC)', () => {
    const input = new Float32Array(480).fill(0.5)
    const out = downsampleTo16k(input, 48000)
    expect(Array.from(out).every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true)
  })

  it('interpolates a linear ramp correctly at the endpoints', () => {
    const input = new Float32Array(48000)
    for (let i = 0; i < input.length; i++) input[i] = i / input.length // 0 -> ~1 ramp over 1 second
    const out = downsampleTo16k(input, 48000)
    expect(out[0]).toBeCloseTo(0, 3)
    expect(out[out.length - 1]).toBeCloseTo(input[input.length - 1], 2)
  })

  it('refuses to upsample (input rate below target) rather than silently producing garbage', () => {
    expect(() => downsampleTo16k(new Float32Array(100), 8000)).toThrow(/below/)
  })

  it('handles a short, real-callback-sized buffer without rounding to zero length', () => {
    const out = downsampleTo16k(new Float32Array(128), 44100)
    expect(out.length).toBeGreaterThan(0)
  })
})
