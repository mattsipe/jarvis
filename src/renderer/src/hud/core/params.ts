import { Color } from 'three'

export type HudState =
  | 'ambient'
  | 'listening'
  | 'thinking'
  | 'acting'
  | 'speaking'
  | 'success'
  | 'error'

export interface CoreVisualParams {
  /** Overall visual scale of the sphere within its fixed canvas (ambient = small, expanded = large). */
  scale: number
  /** Radius jitter amplitude — organic "breathing"/wobble strength. */
  noiseAmp: number
  /** How fast the wobble animates. */
  noiseFreq: number
  /** Constant rotation speed of the whole point cloud (radians/sec); negative = reverse. */
  rotSpeed: number
  pointOpacity: number
  lineOpacity: number
  pointSize: number
  color: Color
  /** 0-1, drives an amplitude-style pulse (real mic/TTS amplitude wires in at M2; simulated for now). */
  energy: number
  /** Random, non-harmonic jitter instead of smooth wobble (error state). */
  chaos: number
  /** Rings/expanded-HUD visibility, 0 = collapsed to ambient orb, 1 = fully expanded. */
  expanded: number
}

const CYAN = new Color('#4fd8ff')
const VIOLET = new Color('#8b7cff')
const EMERALD = new Color('#3bf0c0')
const AMBER = new Color('#ff6b4a')
const CYAN_EMERALD = new Color('#4fe8d8')

export const CORE_PARAMS: Record<HudState, CoreVisualParams> = {
  ambient: {
    scale: 0.2,
    noiseAmp: 0.045,
    noiseFreq: 0.5,
    rotSpeed: 0.06,
    pointOpacity: 0.5,
    lineOpacity: 0.22,
    pointSize: 1.0,
    color: CYAN,
    energy: 0,
    chaos: 0,
    expanded: 0
  },
  listening: {
    scale: 1.05,
    noiseAmp: 0.1,
    noiseFreq: 0.85,
    rotSpeed: 0.16,
    pointOpacity: 0.95,
    lineOpacity: 0.55,
    pointSize: 1.15,
    color: CYAN,
    energy: 1,
    chaos: 0,
    expanded: 1
  },
  thinking: {
    scale: 0.68,
    noiseAmp: 0.2,
    noiseFreq: 2.4,
    rotSpeed: 0.7,
    pointOpacity: 0.9,
    lineOpacity: 0.6,
    pointSize: 0.9,
    color: VIOLET,
    energy: 0.15,
    chaos: 0,
    expanded: 1
  },
  acting: {
    scale: 0.95,
    noiseAmp: 0.14,
    noiseFreq: 1.2,
    rotSpeed: 0.4,
    pointOpacity: 0.9,
    lineOpacity: 0.65,
    pointSize: 1.05,
    color: EMERALD,
    energy: 0.35,
    chaos: 0,
    expanded: 1
  },
  speaking: {
    scale: 0.92,
    noiseAmp: 0.1,
    noiseFreq: 1.0,
    rotSpeed: 0.2,
    pointOpacity: 0.95,
    lineOpacity: 0.55,
    pointSize: 1.1,
    color: CYAN_EMERALD,
    energy: 1,
    chaos: 0,
    expanded: 1
  },
  success: {
    scale: 1.0,
    noiseAmp: 0.06,
    noiseFreq: 0.6,
    rotSpeed: 0.1,
    pointOpacity: 1,
    lineOpacity: 0.6,
    pointSize: 1.2,
    color: EMERALD,
    energy: 0.4,
    chaos: 0,
    expanded: 1
  },
  error: {
    scale: 0.88,
    noiseAmp: 0.3,
    noiseFreq: 3.2,
    rotSpeed: -0.12,
    pointOpacity: 0.9,
    lineOpacity: 0.5,
    pointSize: 1.0,
    color: AMBER,
    energy: 0.2,
    chaos: 1,
    expanded: 1
  }
}

/** How quickly each numeric param chases its target — higher = snappier. Tuned per-field. */
export const DAMPING = {
  scale: 3.2,
  noiseAmp: 4,
  noiseFreq: 4,
  rotSpeed: 2.5,
  pointOpacity: 5,
  lineOpacity: 5,
  pointSize: 5,
  energy: 6,
  chaos: 3,
  expanded: 3,
  color: 4
}
