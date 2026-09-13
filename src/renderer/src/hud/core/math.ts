import { Vector3 } from 'three'

/** Deterministic PRNG so the core's point cloud is stable across reloads. */
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Evenly distributed points on a unit sphere via the golden-angle spiral. */
export function fibonacciSphere(n: number): Vector3[] {
  const points: Vector3[] = []
  const offset = 2 / n
  const increment = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = i * offset - 1 + offset / 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const phi = i * increment
    points.push(new Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r))
  }
  return points
}

/** Two unit vectors orthogonal to `normal` and to each other, for tangential jitter. */
export function tangentBasis(normal: Vector3): [Vector3, Vector3] {
  const helper = Math.abs(normal.y) < 0.99 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
  const t1 = new Vector3().crossVectors(normal, helper).normalize()
  const t2 = new Vector3().crossVectors(normal, t1).normalize()
  return [t1, t2]
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Framerate-independent exponential smoothing toward `target`. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt))
}
