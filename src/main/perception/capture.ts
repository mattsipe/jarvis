import { desktopCapturer, screen, type NativeImage } from 'electron'
import { contextManager } from '../context'

export interface CaptureResult {
  base64: string
  mediaType: 'image/png'
  /** What was actually captured, in the same coordinate space as ContextManager.getActiveWindow()'s cursor/bounds — for future tools (Phase 3's click-mapping) to reuse without re-deriving it. */
  region: { x: number; y: number; width: number; height: number }
}

/** Anthropic's vision guidance caps usefully-processed resolution around here — sending more just costs tokens for no accuracy gain. */
const MAX_LONG_EDGE = 1568
const CURSOR_CROP_SIZE = 480

function downscale(image: NativeImage): NativeImage {
  const { width, height } = image.getSize()
  const longEdge = Math.max(width, height)
  if (longEdge <= MAX_LONG_EDGE || longEdge === 0) return image
  const scale = MAX_LONG_EDGE / longEdge
  return image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
}

function clampRect(
  rect: { x: number; y: number; width: number; height: number },
  bounds: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(rect.x, bounds.width - 1))
  const y = Math.max(0, Math.min(rect.y, bounds.height - 1))
  const width = Math.max(1, Math.min(rect.width, bounds.width - x))
  const height = Math.max(1, Math.min(rect.height, bounds.height - y))
  return { x, y, width, height }
}

async function captureFullScreen(): Promise<{ image: NativeImage; region: { x: number; y: number; width: number; height: number } }> {
  const primary = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: primary.size })
  const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('No screen source available to capture — check screen-recording permission.')
  return { image: source.thumbnail, region: { x: 0, y: 0, width: primary.size.width, height: primary.size.height } }
}

/**
 * Backs the look_at_screen tool (tools/perception.ts). Screenshots only
 * happen on request, never continuously, per the capability-phase plan.
 *
 * DPI note: window bounds/cursor position come from ContextManager's
 * ActiveWindowContext, which on Windows is the native helper's Win32
 * coordinates. The helper has no DPI-awareness manifest (so Windows
 * virtualizes its coordinates the same way Electron's own `screen` module
 * reports them by default), which should align on a single 100%-scaled
 * display — this has NOT been verified on a scaled or multi-monitor
 * Windows setup. If crops look offset in real testing, that's the first
 * place to look.
 */
export async function captureScreen(focus: 'full' | 'active_window' | 'cursor'): Promise<CaptureResult> {
  const { image, region } = await captureFullScreen()

  if (focus === 'full') {
    const scaled = downscale(image)
    return { base64: scaled.toPNG().toString('base64'), mediaType: 'image/png', region }
  }

  const active = await contextManager.getActiveWindow()

  if (focus === 'active_window' && active?.bounds) {
    const rect = clampRect(active.bounds, { width: region.width, height: region.height })
    const cropped = downscale(image.crop(rect))
    return { base64: cropped.toPNG().toString('base64'), mediaType: 'image/png', region: rect }
  }

  if (focus === 'cursor' && active?.cursor) {
    const rect = clampRect(
      {
        x: active.cursor.x - CURSOR_CROP_SIZE / 2,
        y: active.cursor.y - CURSOR_CROP_SIZE / 2,
        width: CURSOR_CROP_SIZE,
        height: CURSOR_CROP_SIZE
      },
      { width: region.width, height: region.height }
    )
    const cropped = downscale(image.crop(rect))
    return { base64: cropped.toPNG().toString('base64'), mediaType: 'image/png', region: rect }
  }

  // No window bounds/cursor available (e.g. helper down, or macOS dev) — full screen is still a useful answer.
  const scaled = downscale(image)
  return { base64: scaled.toPNG().toString('base64'), mediaType: 'image/png', region }
}
