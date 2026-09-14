import WebSocket from 'ws'

/**
 * The subset of `ws`'s WebSocket surface the streaming providers actually
 * use — extracted so a fake, in-memory implementation can stand in for it
 * in tests (see deepgram.test.ts/elevenlabs.test.ts) without opening a
 * real socket or mocking the `ws` module's internals.
 */
export interface SocketLike {
  readyState: number
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'close', listener: (code: number) => void): void
  on(event: 'unexpected-response', listener: (req: unknown, res: { statusCode?: number; resume: () => void }) => void): void
  send(data: string | Buffer): void
  close(): void
}

/** `ws.WebSocket.OPEN` is always 1 per the WebSocket spec — hardcoded so SocketLike doesn't need `ws`'s static members. */
export const SOCKET_OPEN = 1

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike

export const defaultSocketFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers }) as unknown as SocketLike
