/**
 * What a physics scenario is, and the helpers that anchor one to a generated circuit.
 *
 * Scenarios are anchored to the track rather than to literal coordinates: the circuit is
 * generated, so the first time it was regenerated every hand-written start position ended
 * up in a field, and sixteen of eighteen scenarios failed for that reason alone.
 */

import type { Vec3 } from '../../../shared/math'
import { InputBit } from '../../../shared/protocol'
import { checkpointsOf, spawnHeightAt, type Track } from '../../../shared/tracks'

export type Scenario = {
  name: string
  start: { pos: Vec3; yaw: number }
  speed: number
  seconds: number
  bits: number
  /** Checkpoint that proves the feature was completed. */
  requireCp?: number
  /** Initial angular velocity, for testing the self-righting assist. */
  spin?: Vec3
  /** Scenario passes if the car ends the run upright and on its wheels. */
  requireUpright?: boolean
  /** Scenario passes if the car got at least this high. */
  requireHeight?: number
  /** Scenario passes if the car drove upside down on the ceiling slab. */
  requireCeiling?: boolean
  /** Checkpoint the car last passed, which is where a respawn puts it back. */
  lastCp?: number
  /**
   * The car is meant to fall: it passes if it respawned and, a second later, sits upright
   * on the road. Input is released at the respawn, so the car is not driven straight back in.
   */
  requireRespawn?: boolean
  /** Scenario passes if the car never went below this height. */
  requireMinY?: number
  /** Scenario passes if the car came within `radius` metres of `pos`. */
  requirePass?: { pos: Vec3; radius: number }
  /** Scenario passes if this trick was scored. */
  requireTrick?: string
  /** Fire the thrusters wherever the racing line says so, as a bot does. */
  thrustOnHint?: boolean
  /** Hold the barrel roll key (E) only until the first trick, as a player taps it. */
  flipOnce?: boolean
  /** Keep the boost lit in the air instead of letting go of everything on take-off. */
  boostInAir?: boolean
  /** Scenario passes if its first landing is this much further on than another scenario's. */
  requireFartherThan?: { scenario: string; metres: number }
  /**
   * The car is meant to run into a barrier: it passes if it touched one, never went past
   * 60 degrees of roll or pitch, and kept at least `keep` of its speed for 1.5 s after.
   */
  requireScrape?: { keep: number }
}

export const THROTTLE = InputBit.Throttle
export const BOOST = InputBit.Throttle | InputBit.Boost

/** Index of the point on the racing line closest to `p`, in the XZ plane. */
export function nearestIndex(track: Track, p: Vec3): number {
  const path = track.centreline
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = (path[i].pos.x - p.x) ** 2 + (path[i].pos.z - p.z) ** 2
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  }
  return best
}

/** A grid slot `metres` of road *before* the point at `index`, facing along the line. */
export function approach(track: Track, index: number, metres: number): { pos: Vec3; yaw: number } {
  const path = track.centreline
  let i = index
  let walked = 0
  while (walked < metres) {
    const previous = (i - 1 + path.length) % path.length
    walked += Math.hypot(path[i].pos.x - path[previous].pos.x, path[i].pos.z - path[previous].pos.z)
    i = previous
  }
  const here = path[i].pos
  const next = path[(i + 1) % path.length].pos
  return {
    pos: { x: here.x, y: spawnHeightAt(track, here.x, here.z), z: here.z },
    yaw: (Math.atan2(next.x - here.x, next.z - here.z) * 180) / Math.PI
  }
}

/** The first checkpoint the car meets after `index`: the one that proves it got through. */
export function checkpointAfter(track: Track, index: number): number {
  const length = track.centreline.length
  const marks = checkpointsOf(track).map((cp) => ({
    index: cp.index ?? 0,
    gap: (nearestIndex(track, cp.pos) - index + length) % length
  }))
  return marks.reduce((a, b) => (b.gap < a.gap ? b : a)).index
}

/**
 * A start `across` metres to the right of the line at `index` (negative: left), turned
 * `degrees` to the right of the line's heading.
 */
export function beside(track: Track, index: number, across: number, degrees: number): { pos: Vec3; yaw: number } {
  const p = track.centreline[index]
  const x = p.pos.x + p.dir.z * across
  const z = p.pos.z - p.dir.x * across
  return { pos: { x, y: spawnHeightAt(track, x, z), z }, yaw: (Math.atan2(p.dir.x, p.dir.z) * 180) / Math.PI + degrees }
}

/**
 * The barriers are solid: grazing one, in a corner at 25 m/s and on a straight at 35, must
 * not roll the car or stop it. Both are laid on the generated circuit: the first corner of
 * the lap, its outside edge, and the middle of the main straight, its right-hand edge.
 */
export function barrierScenarios(track: Track): Scenario[] {
  const line = track.centreline
  // The first corner: the lap starts with its arc. Which way it turns says which side the
  // outside is; a car started near that edge and driven straight drifts into it at ~10 deg.
  const a = line[1].dir
  const b = line[3].dir
  const outside = a.x * b.z - a.z * b.x > 0 ? 1 : -1
  const grid = nearestIndex(track, track.spawns[0].pos)
  return [
    {
      name: 'barrier corner @ 25 m/s',
      start: beside(track, 1, outside * 7, 0),
      speed: 25,
      seconds: 4,
      bits: THROTTLE,
      requireScrape: { keep: 0.6 }
    },
    {
      name: 'barrier straight @ 35 m/s',
      start: beside(track, grid, 4, 8),
      speed: 35,
      seconds: 4,
      bits: BOOST,
      requireScrape: { keep: 0.6 }
    }
  ]
}
