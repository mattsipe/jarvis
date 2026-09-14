import { describe, it, expect } from 'vitest'
import { imagePointToPhysicalScreen } from './coords'

describe('operate/coords imagePointToPhysicalScreen', () => {
  it('maps 1:1 (no downscale, 100% DPI) — image coords equal physical screen coords', () => {
    const result = imagePointToPhysicalScreen(50, 60, {
      imageWidth: 800,
      imageHeight: 600,
      region: { x: 0, y: 0, width: 800, height: 600 },
      dpiScale: 1
    })
    expect(result).toEqual({ x: 50, y: 60 })
  })

  it('accounts for a downscaled image (region larger than the delivered image)', () => {
    // Region was 1600x1200 but downscaled to 800x600 before being returned — a 2x image-to-region scale.
    const result = imagePointToPhysicalScreen(100, 100, {
      imageWidth: 800,
      imageHeight: 600,
      region: { x: 0, y: 0, width: 1600, height: 1200 },
      dpiScale: 1
    })
    expect(result).toEqual({ x: 200, y: 200 })
  })

  it('applies 125% DPI scaling on top of a 1:1 image', () => {
    const result = imagePointToPhysicalScreen(100, 100, {
      imageWidth: 800,
      imageHeight: 600,
      region: { x: 0, y: 0, width: 800, height: 600 },
      dpiScale: 1.25
    })
    expect(result).toEqual({ x: 125, y: 125 })
  })

  it('applies 150% DPI scaling', () => {
    const result = imagePointToPhysicalScreen(200, 200, {
      imageWidth: 800,
      imageHeight: 600,
      region: { x: 0, y: 0, width: 800, height: 600 },
      dpiScale: 1.5
    })
    expect(result).toEqual({ x: 300, y: 300 })
  })

  it('adds a positive region offset (a window not at the screen origin)', () => {
    const result = imagePointToPhysicalScreen(10, 10, {
      imageWidth: 100,
      imageHeight: 100,
      region: { x: 500, y: 300, width: 100, height: 100 },
      dpiScale: 1
    })
    expect(result).toEqual({ x: 510, y: 310 })
  })

  it('correctly handles a negative-offset secondary monitor (to the left of/above the primary)', () => {
    const result = imagePointToPhysicalScreen(10, 10, {
      imageWidth: 100,
      imageHeight: 100,
      region: { x: -1920, y: -200, width: 100, height: 100 },
      dpiScale: 1
    })
    expect(result).toEqual({ x: -1910, y: -190 })
  })

  it('combines downscale, DPI, and a monitor offset in one mapping', () => {
    const result = imagePointToPhysicalScreen(400, 300, {
      imageWidth: 800, // half of the 1600-wide region
      imageHeight: 600,
      region: { x: 2560, y: 0, width: 1600, height: 1200 },
      dpiScale: 1.5
    })
    // dip = 2560 + 400*2 = 3360, 0 + 300*2 = 600; physical = *1.5
    expect(result).toEqual({ x: 5040, y: 900 })
  })
})
