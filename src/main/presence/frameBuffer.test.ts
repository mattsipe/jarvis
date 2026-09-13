import { describe, it, expect } from 'vitest'
import { FrameBuffer } from './frameBuffer'

function range(start: number, len: number): Int16Array {
  const arr = new Int16Array(len)
  for (let i = 0; i < len; i++) arr[i] = start + i
  return arr
}

describe('presence/frameBuffer', () => {
  it('emits nothing until a full frame has accumulated', () => {
    const fb = new FrameBuffer(512)
    expect(fb.push(range(0, 200))).toEqual([])
    expect(fb.push(range(200, 200))).toEqual([])
  })

  it('emits exactly one frame once enough samples have arrived, carrying the remainder forward', () => {
    const fb = new FrameBuffer(512)
    fb.push(range(0, 400))
    const frames = fb.push(range(400, 200)) // 600 total: one full frame + 88 left over
    expect(frames.length).toBe(1)
    expect(frames[0].length).toBe(512)
    expect(Array.from(frames[0])).toEqual(Array.from(range(0, 512)))

    // The 88-sample remainder should still be there for the next push.
    const more = fb.push(range(600, 424)) // 88 + 424 = 512, exactly one more frame
    expect(more.length).toBe(1)
    expect(Array.from(more[0])).toEqual(Array.from(range(512, 512)))
  })

  it('emits multiple frames from one large chunk, in order', () => {
    const fb = new FrameBuffer(512)
    const frames = fb.push(range(0, 512 * 3 + 100))
    expect(frames.length).toBe(3)
    expect(Array.from(frames[0])).toEqual(Array.from(range(0, 512)))
    expect(Array.from(frames[1])).toEqual(Array.from(range(512, 512)))
    expect(Array.from(frames[2])).toEqual(Array.from(range(1024, 512)))
  })

  it('never drops or duplicates a sample across many small chunks', () => {
    const fb = new FrameBuffer(512)
    const allFrames: Int16Array[] = []
    let cursor = 0
    // 37 is coprime-ish with 512, so chunk boundaries land at varied offsets relative to frame boundaries.
    for (let i = 0; i < 100; i++) {
      allFrames.push(...fb.push(range(cursor, 37)))
      cursor += 37
    }
    const reconstructed = allFrames.flatMap((f) => Array.from(f))
    const expected = Array.from(range(0, reconstructed.length))
    expect(reconstructed).toEqual(expected)
  })

  it('reset() discards a pending partial frame instead of carrying it forward', () => {
    const fb = new FrameBuffer(512)
    fb.push(range(0, 300))
    fb.reset()
    const frames = fb.push(range(1000, 512)) // if the old 300 leaked in, this would emit early with wrong content
    expect(frames.length).toBe(1)
    expect(Array.from(frames[0])).toEqual(Array.from(range(1000, 512)))
  })
})
