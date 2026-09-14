import type { SocketLike } from './socket'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (...args: any[]) => void

/**
 * Minimal in-memory stand-in for a `ws` WebSocket, driven entirely by test
 * code (no real network) — shared by deepgram.test.ts and
 * elevenlabs.test.ts so both providers' reconnect/error-handling state
 * machines can be exercised deterministically. `readyState` starts at 0
 * (CONNECTING) like a real socket; call `open()` to flip it to 1 (OPEN)
 * and fire the 'open' event, matching real WebSocket sequencing.
 */
export class FakeSocket implements SocketLike {
  readyState = 0
  sent: (string | Buffer)[] = []
  closed = false
  private listeners = new Map<string, AnyListener[]>()

  on(event: string, listener: AnyListener): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args)
  }

  send(data: string | Buffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  open(): void {
    this.readyState = 1
    this.fire('open')
  }

  message(payload: unknown): void {
    this.fire('message', typeof payload === 'string' ? payload : JSON.stringify(payload))
  }

  error(err: Error): void {
    this.fire('error', err)
  }

  unexpectedResponse(statusCode: number): void {
    this.fire('unexpected-response', {}, { statusCode, resume: () => {} })
  }

  /** Simulates the server dropping the connection — readyState back to CLOSED (3) first, like a real socket. */
  remoteClose(code: number): void {
    this.readyState = 3
    this.fire('close', code)
  }
}

/** A SocketFactory that hands out FakeSockets in order and records the (url, headers) each was created with — for asserting reconnect behavior actually opens a fresh connection each time. */
export function fakeSocketFactory(): { factory: (url: string, headers: Record<string, string>) => SocketLike; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  return {
    sockets,
    factory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    }
  }
}
