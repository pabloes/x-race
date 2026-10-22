/**
 * CITY's set pieces: the launch ramp on the main straight, the thrusters, the
 * self-righting assist and the inverted ceiling run.
 */

import { InputBit } from '../../../shared/protocol'
import type { Track } from '../../../shared/tracks'
import { approach, BOOST, checkpointAfter, nearestIndex, THROTTLE, type Scenario } from './common'

export function cityScenarios(track: Track): Scenario[] {
  // Where the set pieces actually are on the generated circuit.
  const ramps = track.surfaces.filter((s) => s.kind === 'ramp')
  const invertZone = track.triggers.find((t) => t.kind === 'invert')
  const invertIndex = invertZone ? nearestIndex(track, invertZone.pos) : 0
  // Of the two ramps, the kicker is the one that feeds the invert zone; the other is the jump.
  const kicker = ramps.reduce((a, b) =>
    Math.abs(nearestIndex(track, b.pos) - invertIndex) < Math.abs(nearestIndex(track, a.pos) - invertIndex) ? b : a
  )
  const jump = ramps.find((r) => r !== kicker) ?? kicker
  const jumpIndex = nearestIndex(track, jump.pos)
  const kickerIndex = nearestIndex(track, kicker.pos)
  /** Flat road, for the tests that only need a surface: the front row of the grid. */
  const grid = track.spawns[0]

  return [
    // Jump: approach the launch ramp at a range of speeds. Fast runs must clear the pillars
    // and land on the road beyond; slow runs are expected to fall short.
    ...[18, 22, 26, 30, 34].map((speed) => ({
      name: `jump @ ${speed} m/s`,
      start: approach(track, jumpIndex, 30),
      speed,
      seconds: 7,
      bits: speed > 28 ? BOOST : THROTTLE,
      requireCp: checkpointAfter(track, jumpIndex)
    })),
    // Thrusters: the space bar has to beat gravity from a standstill and extend a jump.
    {
      name: 'thrust standstill',
      start: { pos: { ...grid.pos, y: 0.95 }, yaw: grid.yaw },
      speed: 0,
      seconds: 2.5,
      bits: InputBit.Thrust,
      requireHeight: 4
    },
    {
      name: 'thrust at speed',
      start: { pos: { ...grid.pos, y: 0.95 }, yaw: grid.yaw },
      speed: 20,
      seconds: 2.5,
      bits: InputBit.Thrust | InputBit.Throttle,
      requireHeight: 4
    },
    // Self-righting: thrown into the air spinning, with no input, the car should still be
    // on its wheels by the time it stops.
    {
      name: 'recover roll',
      start: { pos: { ...grid.pos, y: 6 }, yaw: grid.yaw },
      speed: 12,
      seconds: 6,
      bits: 0,
      spin: { x: 0, y: 0, z: 5 },
      requireUpright: true
    },
    {
      name: 'recover pitch',
      start: { pos: { ...grid.pos, y: 6 }, yaw: grid.yaw },
      speed: 12,
      seconds: 6,
      bits: 0,
      spin: { x: 4, y: 1, z: 0 },
      requireUpright: true
    },
    // Ceiling run: the kicker throws the car into the invert zone, the server half-rolls it
    // and inverted gravity should hold it under the slab all the way to the exit ramp.
    ...[20, 24, 28, 32].map((speed) => ({
      name: `ceiling @ ${speed} m/s`,
      start: approach(track, kickerIndex, 30),
      speed,
      seconds: 7,
      bits: BOOST,
      // Not a checkpoint: the gate after the zone is round the next corner, and a scenario
      // holding one fixed input cannot steer to it. What is being tested is the slab — wheels
      // in contact while upside down — and that the car comes off it back onto its wheels.
      requireCeiling: true,
      requireUpright: true
    }))
  ]
}
