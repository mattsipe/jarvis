import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer
} from 'three'
import { getCoreGeometry } from './geometry'
import { CORE_PARAMS, DAMPING, type HudState } from './params'
import { damp } from './math'
import { POINT_FRAGMENT_SHADER, POINT_VERTEX_SHADER } from './shaders'

const BASE_RADIUS = 1.0

/**
 * Owns the three.js scene for the living core: a point cloud with fixed
 * nearest-neighbor connectivity (computed once, see geometry.ts) that
 * wobbles organically and re-colors/re-shapes as the HUD state changes.
 * All numeric params are damped toward per-state targets every frame (see
 * params.ts) so state changes read as one continuous motion, never a cut.
 *
 * Not React — a plain class driven by Core.tsx's effect, so the animation
 * loop is untouched by React re-renders.
 */
export class JarvisCore {
  private renderer: WebGLRenderer
  private scene = new Scene()
  private camera: PerspectiveCamera
  private group = new Group()
  private points: Points
  private lines: LineSegments
  private pointMaterial: ShaderMaterial
  private lineMaterial: LineBasicMaterial

  private geo = getCoreGeometry()
  private current = { ...CORE_PARAMS.ambient, color: CORE_PARAMS.ambient.color.clone() }
  private targetState: HudState = 'ambient'
  private clock = { last: performance.now(), time: 0 }
  private rafId: number | null = null
  private externalAmplitude: number | null = null
  private disposed = false

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(width, height, false)

    this.camera = new PerspectiveCamera(35, width / height, 0.1, 100)
    this.camera.position.set(0, 0, 4.2)
    this.camera.lookAt(0, 0, 0)

    const positions = new Float32Array(this.geo.count * 3)
    const pointGeometry = new BufferGeometry()
    pointGeometry.setAttribute('position', new BufferAttribute(positions, 3))
    pointGeometry.setAttribute('aBrightness', new BufferAttribute(this.geo.brightness, 1))

    this.pointMaterial = new ShaderMaterial({
      uniforms: {
        uColor: { value: this.current.color },
        uOpacity: { value: this.current.pointOpacity },
        uPointSize: { value: this.current.pointSize }
      },
      vertexShader: POINT_VERTEX_SHADER,
      fragmentShader: POINT_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
    this.points = new Points(pointGeometry, this.pointMaterial)

    const linePositions = new Float32Array(this.geo.lineIndices.length * 3)
    const lineGeometry = new BufferGeometry()
    lineGeometry.setAttribute('position', new BufferAttribute(linePositions, 3))

    this.lineMaterial = new LineBasicMaterial({
      color: this.current.color,
      transparent: true,
      opacity: this.current.lineOpacity,
      blending: AdditiveBlending,
      depthWrite: false
    })
    this.lines = new LineSegments(lineGeometry, this.lineMaterial)

    this.group.add(this.points, this.lines)
    this.group.scale.setScalar(this.current.scale)
    this.scene.add(this.group)

    this.tick = this.tick.bind(this)
    this.rafId = requestAnimationFrame(this.tick)
  }

  setState(state: HudState): void {
    this.targetState = state
  }

  /** M2 wires real mic/TTS amplitude in here; null falls back to a simulated pulse. */
  setExternalAmplitude(amplitude: number | null): void {
    this.externalAmplitude = amplitude
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    this.disposed = true
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.points.geometry.dispose()
    this.lines.geometry.dispose()
    this.pointMaterial.dispose()
    this.lineMaterial.dispose()
    this.renderer.dispose()
  }

  private tick(now: number): void {
    if (this.disposed) return
    const dt = Math.min((now - this.clock.last) / 1000, 1 / 20)
    this.clock.last = now
    this.clock.time += dt

    this.updateParams(dt)
    this.updateGeometry()
    this.renderer.render(this.scene, this.camera)

    this.rafId = requestAnimationFrame(this.tick)
  }

  private updateParams(dt: number): void {
    const target = CORE_PARAMS[this.targetState]
    const c = this.current
    c.scale = damp(c.scale, target.scale, DAMPING.scale, dt)
    c.noiseAmp = damp(c.noiseAmp, target.noiseAmp, DAMPING.noiseAmp, dt)
    c.noiseFreq = damp(c.noiseFreq, target.noiseFreq, DAMPING.noiseFreq, dt)
    c.rotSpeed = damp(c.rotSpeed, target.rotSpeed, DAMPING.rotSpeed, dt)
    c.pointOpacity = damp(c.pointOpacity, target.pointOpacity, DAMPING.pointOpacity, dt)
    c.lineOpacity = damp(c.lineOpacity, target.lineOpacity, DAMPING.lineOpacity, dt)
    c.pointSize = damp(c.pointSize, target.pointSize, DAMPING.pointSize, dt)
    c.energy = damp(c.energy, target.energy, DAMPING.energy, dt)
    c.chaos = damp(c.chaos, target.chaos, DAMPING.chaos, dt)
    c.expanded = damp(c.expanded, target.expanded, DAMPING.expanded, dt)
    c.color.lerp(target.color as Color, 1 - Math.exp(-DAMPING.color * dt))

    this.group.scale.setScalar(c.scale)
    this.group.rotation.y += c.rotSpeed * dt

    const amplitude =
      this.externalAmplitude ?? (0.5 + 0.5 * Math.sin(this.clock.time * 6.0)) * c.energy

    this.pointMaterial.uniforms.uColor.value = c.color
    this.pointMaterial.uniforms.uOpacity.value = c.pointOpacity * (0.85 + 0.15 * amplitude)
    this.pointMaterial.uniforms.uPointSize.value = c.pointSize * (0.9 + 0.25 * amplitude)
    this.lineMaterial.color.copy(c.color)
    this.lineMaterial.opacity = c.lineOpacity * (0.85 + 0.15 * amplitude)

    this.lastAmplitude = amplitude
  }

  private lastAmplitude = 0

  private updateGeometry(): void {
    const { count, basePositions, radiusJitter, tangents, seeds, lineIndices } = this.geo
    const c = this.current
    const t = this.clock.time
    const amp = c.noiseAmp * (1 + 0.4 * this.lastAmplitude)
    const positions = this.points.geometry.attributes.position as BufferAttribute
    const arr = positions.array as Float32Array

    for (let i = 0; i < count; i++) {
      const bx = basePositions[i * 3]
      const by = basePositions[i * 3 + 1]
      const bz = basePositions[i * 3 + 2]
      const rj = radiusJitter[i] * BASE_RADIUS

      const phaseA = seeds[i * 4]
      const freqA = seeds[i * 4 + 1]
      const phaseB = seeds[i * 4 + 2]
      const freqB = seeds[i * 4 + 3]

      const rWobble = 1 + amp * Math.sin(t * freqA * c.noiseFreq + phaseA)
      let wobbleT1 = amp * 0.6 * Math.sin(t * freqB * c.noiseFreq + phaseB)
      let wobbleT2 = amp * 0.6 * Math.cos(t * freqB * c.noiseFreq * 0.7 + phaseA * 1.3)

      if (c.chaos > 0.01) {
        wobbleT1 += c.chaos * amp * 0.8 * Math.sin(t * 13.7 + phaseA * 37)
        wobbleT2 += c.chaos * amp * 0.8 * Math.sin(t * 9.3 + phaseB * 17)
      }

      const t1x = tangents[i * 6]
      const t1y = tangents[i * 6 + 1]
      const t1z = tangents[i * 6 + 2]
      const t2x = tangents[i * 6 + 3]
      const t2y = tangents[i * 6 + 4]
      const t2z = tangents[i * 6 + 5]

      const px = bx * rj * rWobble + t1x * wobbleT1 + t2x * wobbleT2
      const py = by * rj * rWobble + t1y * wobbleT1 + t2y * wobbleT2
      const pz = bz * rj * rWobble + t1z * wobbleT1 + t2z * wobbleT2

      arr[i * 3] = px
      arr[i * 3 + 1] = py
      arr[i * 3 + 2] = pz
    }
    positions.needsUpdate = true

    const linePos = this.lines.geometry.attributes.position as BufferAttribute
    const larr = linePos.array as Float32Array
    for (let i = 0; i < lineIndices.length; i++) {
      const p = lineIndices[i]
      larr[i * 3] = arr[p * 3]
      larr[i * 3 + 1] = arr[p * 3 + 1]
      larr[i * 3 + 2] = arr[p * 3 + 2]
    }
    linePos.needsUpdate = true
  }
}
