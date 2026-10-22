/**
 * What a physics scenario is, and the helpers that anchor one to a generated circuit.
 *
 * Scenarios are anchored to the track rather than to literal coordinates: the circuit is
 * generated, so the first time it was regenerated every hand-written start position ended
 * up in a field, and sixteen of eighteen scenarios failed for that reason alone.
 */

import type { Vec3 } from '../../../shared/math'
import { InputBit } from '../../../shared/protocol'
import { checkpointsOf, type Track } from '../../../shared/tracks'

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
    pos: { x: here.x, y: 0.95, z: here.z },
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
