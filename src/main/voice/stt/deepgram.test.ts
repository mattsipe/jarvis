import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DeepgramStt, type DeepgramDeps } from './deepgram'
import { fakeSocketFactory } from '../transport/fakeSocket'
import type { TransportStatus } from '../transport/status'

function makeDeps(overrides: Partial<DeepgramDeps> = {}): DeepgramDeps {
  return {
    apiKey: 'test-key',
    checkBudget: () => ({ allowed: true }),
    logInfo: () => {},
    logError: () => {},
    ...overrides
  }
}

describe('voice/stt/deepgram DeepgramStt — failure injection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('reconnects (does not emit a fatal error) when the connection closes unexpectedly mid-listen', () => {
    const { factory, sockets } = fakeSocketFactory()
    const stt = new DeepgramStt(makeDeps(), factory)
    const onError = vi.fn()
    const statuses: TransportStatus['state'][] = []
    stt.on('error', onError)
    stt.on('status', (s) => statuses.push(s.state))

    stt.start(16000)
    sockets[0].open()
    sockets[0].remoteClose(1006) // abnormal closure — a real "random WebSocket error" shape

    expect(onError).not.toHaveBeenCalled()
    expect(statuses).toContain('reconnecting')

    vi.advanceTimersByTime(2000)
    expect(sockets.length).toBe(2) // a second socket was opened to reconnect
  })

  it('recovers fully after a temporary failure — a second socket opening clears the retry count and resumes transcripts', () => {
    const { factory, sockets } = fakeSocketFactory()
    const stt = new DeepgramStt(makeDeps(), factory)
    const transcripts: string[] = []
    const onError = vi.fn()
    stt.on('error', onError)
    stt.on('transcript', (e) => transcripts.push(e.text))

    stt.start(16000)
    sockets[0].open()
    sockets[0].remoteClose(1011) // server error
    vi.advanceTimersByTime(2000)

    expect(sockets.length).toBe(2)
    sockets[1].open()
    sockets[1].message({ type: 'Results', channel: { alternatives: [{ transcript: 'hello' }] }, is_final: true, speech_final: true })

    expect(onError).not.toHaveBeenCalled()
    expect(transcripts).toEqual(['hello'])
  })

  it('gives up and emits a fatal error after exceeding the reconnect limit', () => {
    const { factory, sockets } = fakeSocketFactory()
    const stt = new DeepgramStt(makeDeps(), factory)
    const onError = vi.fn()
    stt.on('error', onError)

    stt.start(16000)
    // Every connection attempt fails outright (never even opens) — the
    // realistic shape of a sustained outage, as opposed to "connects fine
    // then drops" (which the earlier test covers and which resets the
    // retry count on each successful open).
    for (let i = 0; i < 6 && onError.mock.calls.length === 0; i++) {
      const socket = sockets[sockets.length - 1]
      socket.remoteClose(1006)
      vi.advanceTimersByTime(2000)
    }

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toMatch(/after 3 attempts/)
    // Never reconnects past a fatal — no further sockets opened afterward.
    const socketCountAtFatal = sockets.length
    vi.advanceTimersByTime(10000)
    expect(sockets.length).toBe(socketCountAtFatal)
  })

  it('does not reconnect on an intentional close (stop()) — emits "closed", not "error"', () => {
    const { factory, sockets } = fakeSocketFactory()
    const stt = new DeepgramStt(makeDeps(), factory)
    const onError = vi.fn()
    const onClosed = vi.fn()
    stt.on('error', onError)
    stt.on('closed', onClosed)

    stt.start(16000)
    sockets[0].open()
    stt.stop() // e.g. "that's all" ending the session
    // stop() sends CloseStream then closes after 400ms.
    vi.advanceTimersByTime(500)
    sockets[0].remoteClose(1000)

    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect(sockets.length).toBe(1) // no reconnect attempted
  })

  it('treats an auth rejection (401) as immediately fatal, with no reconnect attempts', () => {
    const { factory, sockets } = fakeSocketFactory()
    const stt = new DeepgramStt(makeDeps(), factory)
    const onError = vi.fn()
    stt.on('error', onError)

    stt.start(16000)
    sockets[0].unexpectedResponse(401)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toMatch(/DEEPGRAM_API_KEY/)
    vi.advanceTimersByTime(5000)
    expect(sockets.length).toBe(1) // never retried
  })

  it('respects the budget gate — refuses to reconnect (fails fast) when the budget denies it', () => {
    const { factory, sockets } = fakeSocketFactory()
    const stt = new DeepgramStt(makeDeps({ checkBudget: () => ({ allowed: false, reason: 'Daily hard limit reached.' }) }), factory)
    const onError = vi.fn()
    stt.on('error', onError)

    stt.start(16000)
    sockets[0].open()
    sockets[0].remoteClose(1006)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('Daily hard limit reached.')
    expect(sockets.length).toBe(1)
  })

  it('ignores events from a stale (already-replaced) socket after a reconnect', () => {
    const { factory, sockets } = fakeSocketFactory()
    const stt = new DeepgramStt(makeDeps(), factory)
    const transcripts: string[] = []
    stt.on('transcript', (e) => transcripts.push(e.text))

    stt.start(16000)
    sockets[0].open()
    sockets[0].remoteClose(1006)
    vi.advanceTimersByTime(2000)
    expect(sockets.length).toBe(2)

    // The old, abandoned socket fires a late event — must be ignored.
    sockets[0].message({ type: 'Results', channel: { alternatives: [{ transcript: 'stale' }] }, is_final: true, speech_final: true })
    expect(transcripts).toEqual([])

    sockets[1].open()
    sockets[1].message({ type: 'Results', channel: { alternatives: [{ transcript: 'fresh' }] }, is_final: true, speech_final: true })
    expect(transcripts).toEqual(['fresh'])
  })

  it('queues audio while disconnected/reconnecting and flushes it once the new socket opens', () => {
    const { factory, sockets } = fakeSocketFactory()
    const stt = new DeepgramStt(makeDeps(), factory)
    stt.start(16000)
    sockets[0].open()
    sockets[0].remoteClose(1006)
    vi.advanceTimersByTime(2000)

    const chunk = Buffer.from([1, 2, 3])
    stt.sendAudio(chunk) // sent while the new socket is still connecting
    expect(sockets[1].sent).toHaveLength(0)

    sockets[1].open()
    expect(sockets[1].sent).toEqual([chunk])
  })
})
