/**
 * Maps a point in a *captured, possibly-downscaled* image back to a real
 * physical-pixel screen coordinate — what pointer_act's SendInput call
 * needs (see Input.cs's NormalizeToVirtualDesktop, which itself expects
 * physical pixels). Two separate scale factors are involved and must not
 * be conflated:
 *  1. image → DIP: perception/capture.ts's downscale() can shrink the
 *     captured region before it's returned to Claude, so a point in that
 *     image isn't 1:1 with the region it was cropped from.
 *  2. DIP → physical: Electron's `screen` module reports region/display
 *     coordinates in device-independent pixels; the helper (now
 *     PerMonitorV2-aware) expects physical ones, related by the display's
 *     own DPI scale factor (1.0 at 100%, 1.25 at 125%, 1.5 at 150%, ...).
 *
 * Both a region at a positive offset (primary monitor) and one at a
 * negative offset (a secondary monitor to the left of/above the primary)
 * are handled the same way — region.x/y are just added after scaling, no
 * special-casing of sign.
 */
export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface CoordMapParams {
  /** The actual delivered image's pixel dimensions — after any downscale, not the raw capture. */
  imageWidth: number
  imageHeight: number
  /** The screen region that was captured, in DIP screen coordinates (as Electron's `screen` module reports). */
  region: CaptureRegion
  /** Physical pixels per DIP for the display the region is on. */
  dpiScale: number
}

export function imagePointToPhysicalScreen(imageX: number, imageY: number, params: CoordMapParams): { x: number; y: number } {
  const scaleX = params.region.width / params.imageWidth
  const scaleY = params.region.height / params.imageHeight
  const dipX = params.region.x + imageX * scaleX
  const dipY = params.region.y + imageY * scaleY
  return { x: Math.round(dipX * params.dpiScale), y: Math.round(dipY * params.dpiScale) }
}
