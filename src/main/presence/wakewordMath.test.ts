import { describe, it, expect } from 'vitest'
import { sensitivityToThreshold, ConsecutiveFrameGate } from './wakewordMath'

describe('presence/wakewordMath sensitivityToThreshold', () => {
  it('maps the default 0.5 sensitivity to a 0.5 threshold', () => {
    expect(sensitivityToThreshold(0.5)).toBeCloseTo(0.5, 6)
  })

  it('maps higher sensitivity to a lower threshold (triggers more easily)', () => {
    expect(sensitivityToThreshold(1)).toBeCloseTo(0.2, 6)
  })

  it('maps lower sensitivity to a higher threshold (triggers less easily)', () => {
    expect(sensitivityToThreshold(0)).toBeCloseTo(0.8, 6)
  })

  it('clamps out-of-range sensitivity values instead of extrapolating', () => {
    expect(sensitivityToThreshold(-1)).toBeCloseTo(0.8, 6)
    expect(sensitivityToThreshold(2)).toBeCloseTo(0.2, 6)
  })
})

describe('presence/wakewordMath ConsecutiveFrameGate', () => {
  it('does not fire on a single frame above threshold when more than one is required', () => {
    const gate = new ConsecutiveFrameGate(3)
    expect(gate.observe(0.9, 0.5)).toBe(false)
    expect(gate.observe(0.9, 0.5)).toBe(false)
  })

  it('fires exactly once the required number of consecutive frames clears the threshold', () => {
    const gate = new ConsecutiveFrameGate(3)
    gate.observe(0.9, 0.5)
    gate.observe(0.9, 0.5)
    expect(gate.observe(0.9, 0.5)).toBe(true)
  })

  it('resets the streak the moment a frame drops below threshold', () => {
    const gate = new ConsecutiveFrameGate(3)
    gate.observe(0.9, 0.5)
    gate.observe(0.9, 0.5)
    gate.observe(0.1, 0.5) // breaks the streak
    expect(gate.observe(0.9, 0.5)).toBe(false)
    expect(gate.observe(0.9, 0.5)).toBe(false)
    expect(gate.observe(0.9, 0.5)).toBe(true)
  })

  it('keeps firing true while the streak is sustained past the requirement', () => {
    const gate = new ConsecutiveFrameGate(2)
    gate.observe(0.9, 0.5)
    expect(gate.observe(0.9, 0.5)).toBe(true)
    expect(gate.observe(0.9, 0.5)).toBe(true)
  })

  it('a required count of 1 fires on the very first frame above threshold', () => {
    const gate = new ConsecutiveFrameGate(1)
    expect(gate.observe(0.9, 0.5)).toBe(true)
  })

  it('reset() clears the streak explicitly', () => {
    const gate = new ConsecutiveFrameGate(2)
    gate.observe(0.9, 0.5)
    gate.reset()
    expect(gate.observe(0.9, 0.5)).toBe(false)
  })
})
