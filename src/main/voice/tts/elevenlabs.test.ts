import { describe, it, expect, vi } from 'vitest'
import { ElevenLabsTts, type ElevenLabsDeps } from './elevenlabs'
import { fakeSocketFactory } from '../transport/fakeSocket'

function makeDeps(overrides: Partial<ElevenLabsDeps> = {}): ElevenLabsDeps {
  return { apiKey: 'test-key', voiceId: 'test-voice', logError: () => {}, ...overrides }
}

describe('voice/tts/elevenlabs ElevenLabsTts — failure injection', () => {
  it('plays audio and emits done normally when the stream completes cleanly', () => {
    const { factory, sockets } = fakeSocketFactory()
    const tts = new ElevenLabsTts(makeDeps(), factory)
    const audio: Buffer[] = []
    const onDone = vi.fn()
    tts.on('audio', (chunk) => audio.push(chunk))
    tts.on('done', onDone)

    tts.connect()
    sockets[0].open()
    tts.sendText('hello')
    sockets[0].message({ audio: Buffer.from('hi').toString('base64') })
    sockets[0].message({ isFinal: true })

    expect(audio).toHaveLength(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('always emits done after an error mid-response, so the turn is never left stuck', () => {
    const { factory, sockets } = fakeSocketFactory()
    const tts = new ElevenLabsTts(makeDeps(), factory)
    const onDone = vi.fn()
    const onError = vi.fn()
    tts.on('done', onDone)
    tts.on('error', onError)

    tts.connect()
    sockets[0].open()
    tts.sendText('hello')
    sockets[0].error(new Error('socket hiccup'))

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1) // never destroys the conversation — the turn still unblocks
  })

  it('never destroys the conversation on a close before ready (treated as an error, but still resolves the turn)', () => {
    const { factory, sockets } = fakeSocketFactory()
    const tts = new ElevenLabsTts(makeDeps(), factory)
    const onDone = vi.fn()
    const onError = vi.fn()
    tts.on('done', onDone)
    tts.on('error', onError)

    tts.connect()
    sockets[0].remoteClose(1006) // never opened at all

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('surfaces an auth rejection as a specific error and still unblocks the turn', () => {
    const { factory, sockets } = fakeSocketFactory()
    const tts = new ElevenLabsTts(makeDeps(), factory)
    const onDone = vi.fn()
    const onError = vi.fn()
    tts.on('done', onDone)
    tts.on('error', onError)

    tts.connect()
    sockets[0].unexpectedResponse(401)

    expect(onError.mock.calls[0][0].message).toMatch(/ELEVENLABS_API_KEY/)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('never emits done twice, even if both an error and a later clean close occur', () => {
    const { factory, sockets } = fakeSocketFactory()
    const tts = new ElevenLabsTts(makeDeps(), factory)
    const onDone = vi.fn()
    tts.on('done', onDone)
    tts.on('error', () => {}) // Node's EventEmitter throws an unhandled 'error' with no listener at all

    tts.connect()
    sockets[0].open()
    sockets[0].error(new Error('boom'))
    sockets[0].remoteClose(1000) // a subsequent close after the error — must not double-fire done

    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('queues text sent before the socket is ready and flushes it on open', () => {
    const { factory, sockets } = fakeSocketFactory()
    const tts = new ElevenLabsTts(makeDeps(), factory)
    tts.connect()
    tts.sendText('queued before open')
    expect(sockets[0].sent).toHaveLength(0)
    sockets[0].open()
    // The initial handshake message plus the queued text.
    expect(sockets[0].sent.length).toBeGreaterThanOrEqual(2)
    expect(sockets[0].sent.some((s) => String(s).includes('queued before open'))).toBe(true)
  })
})
