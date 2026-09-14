import { describe, it, expect, vi, afterEach } from 'vitest'
import { backoffDelayMs } from './backoff'

describe('voice/transport/backoff backoffDelayMs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never exceeds the exponential cap for that attempt', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    expect(backoffDelayMs(0, 300, 8000)).toBe(300)
    expect(backoffDelayMs(1, 300, 8000)).toBe(600)
    expect(backoffDelayMs(2, 300, 8000)).toBe(1200)
  })

  it('caps the exponential growth at capMs regardless of attempt number', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    expect(backoffDelayMs(10, 300, 8000)).toBe(8000)
    expect(backoffDelayMs(100, 300, 8000)).toBe(8000)
  })

  it('is always non-negative and at most the exponential value for that attempt', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(backoffDelayMs(3, 300, 8000)).toBe(0)
  })

  it('treats a negative attempt the same as attempt 0 (never a smaller-than-base delay)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    expect(backoffDelayMs(-5, 300, 8000)).toBe(300)
  })
})
