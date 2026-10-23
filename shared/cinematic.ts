/**
 * The pre-race cinematic, as data: a list of shots that the scene plays back while the
 * room is in its `intro` phase. Nothing here knows about cameras or entities, so the
 * server can validate a circuit's shots with the same code the scene plays them with.
 *
 * Shots are authored in the same scene-local metres as the track. A circuit may bring its
 * own hand-made shots (see `intros/`); any other gets `defaultIntro`, three shots computed
 * from its geometry, which is also the template for the hand-made ones.
 */

import { vadd, vscale, vsub, type Vec3 } from './math'
import type { PathPoint, Spawn, Surface, Trigger } from './tracks/types'

export type Shot = {
  /** Ruta de la cámara en metros de mundo, mínimo 2 puntos; Catmull-Rom entre ellos. */
  path: Vec3[]
  /**
   * A qué mira: un punto fijo, una ruta con tantos puntos como `path`, o 'cars' (el
   * centro de la parrilla, para el plano final).
   */
  look: Vec3 | Vec3[] | 'cars'
  seconds: number
  /** Campo de visión, 60 por defecto. */
  fov?: number
  /** Transición al entrar en este plano: 'cut' (por defecto) o 'fade'. */
  transition?: 'cut' | 'fade'
}

/** The part of a Track the default intro reads; structural so it needs no built Track. */
export type IntroTrack = {
  centreline: PathPoint[]
  spawns: Spawn[]
  triggers: Trigger[]
  extent: number
  surfaces?: Surface[]
}

export const DEFAULT_FOV = 60

/** How far the total may stray from the phase length before the shots are rejected. */
const TOLERANCE_S = 0.5

/**
 * Throws unless the shots add up to the intro phase, so a circuit whose cinematic ends
 * early (a frozen last frame) or late (cut off by the countdown) fails when it is built
 * rather than when somebody watches it.
 */
export function validateIntro(shots: Shot[], introMs: number): void {
  const total = shots.reduce((sum, s) => sum + s.seconds, 0)
  if (shots.length === 0 || Math.abs(total - introMs / 1000) > TOLERANCE_S) {
    throw new Error(
      `intro: shots add up to ${total.toFixed(2)} s, the phase lasts ${introMs / 1000} s (±${TOLERANCE_S})`
    )
  }
  shots.forEach((s, i) => {
    if (s.path.length < 2) throw new Error(`intro: shot ${i} needs at least 2 path points`)
    if (Array.isArray(s.look) && s.look.length !== s.path.length) {
      throw new Error(`intro: shot ${i} has ${s.path.length} path points but ${s.look.length} look points`)
    }
    if (!(s.seconds > 0)) throw new Error(`intro: shot ${i} has no duration`)
  })
}

// --- Splines ----------------------------------------------------------------

function catmullRomAxis(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3)
}

/**
 * Point on the Catmull-Rom spline through `points` at t in [0, 1] over the whole path.
 * The ends reuse their own point as the missing neighbour, so the curve starts and stops
 * exactly on the first and last point instead of overshooting them.
 */
export function splineAt(points: Vec3[], t: number): Vec3 {
  const last = points.length - 1
  const u = Math.min(Math.max(t, 0), 1) * last
  const i = Math.min(Math.floor(u), last - 1)
  const f = u - i
  const p0 = points[Math.max(i - 1, 0)]
  const p1 = points[i]
  const p2 = points[i + 1]
  const p3 = points[Math.min(i + 2, last)]
  return {
    x: catmullRomAxis(p0.x, p1.x, p2.x, p3.x, f),
    y: catmullRomAxis(p0.y, p1.y, p2.y, p3.y, f),
    z: catmullRomAxis(p0.z, p1.z, p2.z, p3.z, f)
  }
}

/** The middle of the grid, which is what a 'cars' shot looks at. */
export function gridCentre(spawns: Spawn[]): Vec3 {
  const sum = spawns.reduce((a, s) => vadd(a, s.pos), { x: 0, y: 0, z: 0 })
  return vscale(sum, 1 / Math.max(spawns.length, 1))
}

// --- Default intro ----------------------------------------------------------

const raised = (p: Vec3, y: number): Vec3 => ({ x: p.x, y: p.y + y, z: p.z })

/** The point of the racing line closest to `p` in the ground plane. */
function nearestIndex(line: Vec3[], p: Vec3): number {
  let best = 0
  let bestD = Infinity
  line.forEach((c, i) => {
    const d = Math.hypot(c.x - p.x, c.z - p.z)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

/**
 * The biggest thing on the lap: the inverted-roof trigger if there is one, otherwise the
 * jump, found as the longest 'ramp' surface (the flip's kicker is short, the jump's is not).
 */
function mainFeature(track: IntroTrack): Vec3 | null {
  const invert = track.triggers.find((t) => t.kind === 'invert')
  if (invert) return invert.pos
  const ramps = (track.surfaces ?? []).filter((s) => s.kind === 'ramp')
  if (ramps.length === 0) return null
  return ramps.reduce((a, b) => (b.size.z > a.size.z ? b : a)).pos
}

/**
 * Three shots for any circuit: a high sweep along the first half of the racing line, a low
 * pass over the main feature, and a pull-back to the grid looking at the cars. A circuit
 * with no feature gives that second shot's time to the sweep.
 */
export function defaultIntro(track: IntroTrack, introMs = 12000): Shot[] {
  const total = introMs / 1000
  const line = track.centreline.map((p) => p.pos)
  const at = (i: number): Vec3 => line[Math.min(Math.max(i, 0), line.length - 1)]
  const feature = mainFeature(track)
  const shots: Shot[] = []

  // 1. Sweep: six points over the first half of the line, a long way up so the whole
  //    layout reads, looking at the road a little further along than the camera is.
  const half = Math.floor(line.length / 2)
  const sweep = [0, 1, 2, 3, 4, 5].map((k) => Math.round((half * k) / 5))
  shots.push({
    path: sweep.map((i) => raised(at(i), track.extent * 0.09)),
    look: sweep.map((i) => at(i + 10)),
    seconds: total * (feature ? 0.42 : 0.75),
    fov: 70
  })

  // 2. Low pass over the feature, from the side so the camera is never on the racing line.
  if (feature) {
    const i = nearestIndex(line, feature)
    const along = vsub(at(i + 6), at(i - 6))
    const flat = Math.hypot(along.x, along.z) || 1
    const side: Vec3 = { x: along.z / flat, y: 0, z: -along.x / flat }
    const lift = (p: Vec3, y: number): Vec3 => raised(vadd(p, vscale(side, 14)), y)
    shots.push({
      path: [lift(at(i - 7), 3), lift(at(i - 2), 5), lift(at(i + 3), 7), lift(at(i + 8), 9)],
      look: feature,
      seconds: total * 0.33,
      fov: 60
    })
  }

  // 3. Pull-back: from just ahead of the front row, rising away, looking at the grid.
  const grid = gridCentre(track.spawns)
  const yaw = ((track.spawns[0]?.yaw ?? 0) * Math.PI) / 180
  const forward: Vec3 = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }
  shots.push({
    path: [raised(vadd(grid, vscale(forward, 16)), 3), raised(vadd(grid, vscale(forward, 42)), 9)],
    look: 'cars',
    seconds: total * 0.25,
    fov: 50
  })

  validateIntro(shots, introMs)
  return shots
}
