import { fibonacciSphere, mulberry32, tangentBasis } from './math'

export interface CoreGeometryData {
  count: number
  /** Base (unperturbed) unit-sphere direction per point. */
  basePositions: Float32Array
  /** Per-point radial jitter so the shell isn't perfectly smooth (volumetric look). */
  radiusJitter: Float32Array
  /** Per-point tangent basis for organic wobble, flattened [t1x,t1y,t1z,t2x,t2y,t2z] * count. */
  tangents: Float32Array
  /** Per-point animation phase/frequency seeds, so motion doesn't look uniform. */
  seeds: Float32Array
  /** Per-point brightness variance. */
  brightness: Float32Array
  /** Deduplicated nearest-neighbor line index pairs. */
  lineIndices: Uint32Array
}

/**
 * Builds the point cloud + connectivity once at startup. Connectivity is a
 * one-time O(n^2) nearest-neighbor search (n ~ 700, well under a millisecond
 * budget worth worrying about) — per-frame cost is just moving points and
 * copying their positions into the line buffer.
 */
export function buildCoreGeometry(count: number, seed = 7): CoreGeometryData {
  const rand = mulberry32(seed)
  const dirs = fibonacciSphere(count)

  const basePositions = new Float32Array(count * 3)
  const radiusJitter = new Float32Array(count)
  const tangents = new Float32Array(count * 6)
  const seeds = new Float32Array(count * 4)
  const brightness = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    const d = dirs[i]
    basePositions[i * 3] = d.x
    basePositions[i * 3 + 1] = d.y
    basePositions[i * 3 + 2] = d.z
    radiusJitter[i] = 0.82 + rand() * 0.18

    const [t1, t2] = tangentBasis(d)
    tangents[i * 6] = t1.x
    tangents[i * 6 + 1] = t1.y
    tangents[i * 6 + 2] = t1.z
    tangents[i * 6 + 3] = t2.x
    tangents[i * 6 + 4] = t2.y
    tangents[i * 6 + 5] = t2.z

    seeds[i * 4] = rand() * Math.PI * 2 // phase A
    seeds[i * 4 + 1] = 0.6 + rand() * 0.9 // freq A
    seeds[i * 4 + 2] = rand() * Math.PI * 2 // phase B
    seeds[i * 4 + 3] = 0.4 + rand() * 0.7 // freq B

    brightness[i] = 0.55 + rand() * 0.45
  }

  // k-nearest-neighbor connectivity (k=3), deduplicated.
  const k = 3
  const seen = new Set<number>()
  const pairs: number[] = []
  for (let i = 0; i < count; i++) {
    const di = dirs[i]
    const dists: { j: number; d: number }[] = []
    for (let j = 0; j < count; j++) {
      if (j === i) continue
      dists.push({ j, d: di.distanceToSquared(dirs[j]) })
    }
    dists.sort((a, b) => a.d - b.d)
    for (let n = 0; n < k && n < dists.length; n++) {
      const j = dists[n].j
      const key = i < j ? i * count + j : j * count + i
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push(i, j)
    }
  }

  return {
    count,
    basePositions,
    radiusJitter,
    tangents,
    seeds,
    brightness,
    lineIndices: new Uint32Array(pairs)
  }
}

export const CORE_POINT_COUNT = 640

// Module-scope cache — the geometry is deterministic and expensive enough
// (k-NN search) that it should only be computed once per process, not once
// per mount (React 18 StrictMode double-invokes effects in dev).
let cached: CoreGeometryData | null = null
export function getCoreGeometry(): CoreGeometryData {
  if (!cached) cached = buildCoreGeometry(CORE_POINT_COUNT)
  return cached
}
