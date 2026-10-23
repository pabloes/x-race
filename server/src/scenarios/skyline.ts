/**
 * SKYLINE's set pieces: the rooftop gap, the long inverted tunnel, the corkscrew and the
 * barrel-roll ramp. Each is found on the generated circuit from what it leaves behind
 * (hints on the racing line, its ramps, its invert zone), never from coordinates.
 */

import { InputBit } from '../../../shared/protocol'
import type { Track } from '../../../shared/tracks'
import { approach, BOOST, checkpointAfter, nearestIndex, THROTTLE, type Scenario } from './common'

export function skylineScenarios(track: Track): Scenario[] {
  const line = track.centreline
  const n = line.length
  const before = (index: number): number => (checkpointAfter(track, index) - 1 + track.checkpointCount) % track.checkpointCount

  // The gap: where the bots' thrust hint starts is 6 m before the lip.
  const thrustFrom = line.findIndex((p) => p.hint === 'thrust')
  const roof = line[thrustFrom].pos.y
  // Landed means still up on the roof: anything a couple of metres under it is in the gap.
  const onRoof = roof - 3

  // The tunnel's invert zone, and the checkpoint halfway along its slab.
  const invert = track.triggers.find((t) => t.kind === 'invert')!
  const tunnelIndex = nearestIndex(track, invert.pos)
  const kickerIndex = (tunnelIndex - Math.round(invert.size.z / 2 / 6) + n) % n
  const tunnelCp = track.triggers.find((t) => t.kind === 'checkpoint' && t.pos.y > 6)!.index!

  // The corkscrew: the first point of the line that climbs while hinted to boost.
  const loopFrom = line.findIndex((p, i) => i > 0 && p.hint === 'boost' && p.pos.y > line[i - 1].pos.y + 0.5)
  // Out of the loop and on the exit road beside it: the first point after the loop that is
  // back down at road height.
  const loopTo = loopFrom + line.slice(loopFrom).findIndex((p) => p.hint === undefined)
  const exit = line[(loopTo + 2) % n].pos

  // The big ramp: its steepest pitch, and the first one before it.
  const steep = track.surfaces.find((s) => s.kind === 'ramp' && s.rot[0] < -20)!
  const rampIndex = nearestIndex(track, steep.pos) - 2

  return [
    // Gap, flat out with the boost: clears it on speed alone and stays on the roof.
    ...[38, 40].map((speed) => ({
      name: `gap @ ${speed} m/s boosted`,
      start: approach(track, thrustFrom, 40),
      speed,
      seconds: 3,
      bits: BOOST,
      requireMinY: onRoof,
      requireUpright: true
    })),
    // Gap at half speed on the thrusters, lit where the bots light them. Coasting, so it
    // starts close enough for the speed to be what it says at the lip.
    ...[18, 22].map((speed) => ({
      name: `gap @ ${speed} m/s thrust`,
      start: approach(track, thrustFrom, 10),
      speed,
      seconds: 6,
      bits: 0,
      thrustOnHint: true,
      requireMinY: onRoof,
      requireUpright: true
    })),
    // Gap flat out without the boost or the thrusters: 30 m/s is not enough, by design.
    {
      name: 'gap @ 30 m/s falls',
      start: approach(track, thrustFrom, 40),
      speed: 30,
      seconds: 10,
      bits: THROTTLE,
      lastCp: before(thrustFrom),
      requireRespawn: true
    },
    // Gap too slow: in it goes, and the respawn has to put it back on the roof, upright,
    // before the gap and not in it.
    {
      name: 'gap @ 12 m/s falls',
      start: approach(track, thrustFrom, 20),
      speed: 12,
      seconds: 10,
      bits: 0,
      lastCp: before(thrustFrom),
      requireRespawn: true
    },
    // Tunnel: kicker, half roll onto the slab, 120 m upside down, and back on the wheels.
    ...[24, 28, 32].map((speed) => ({
      name: `tunnel @ ${speed} m/s`,
      start: approach(track, kickerIndex, 30),
      speed,
      seconds: 9,
      bits: BOOST,
      requireCp: tunnelCp,
      requireCeiling: true,
      requireUpright: true
    })),
    // Corkscrew: boosted the whole way, or on the throttle alone from 24 m/s (a bot with an
    // empty battery), out of it on the exit road and on the wheels.
    ...[24, 28, 32, -20, -24].map((signed) => ({
      name: `corkscrew @ ${Math.abs(signed)} m/s${signed < 0 ? ' no boost' : ''}`,
      start: approach(track, loopFrom, 30),
      speed: Math.abs(signed),
      seconds: 6,
      bits: signed < 0 ? THROTTLE : BOOST,
      // Anywhere on the exit road: boosted, the car comes out a few metres wide of the line.
      requirePass: { pos: exit, radius: 6 },
      requireUpright: true
    })),
    // Big ramp: E in the air is a barrel roll worth points, and the car lands it.
    ...[30, 36].map((speed) => ({
      name: `bigramp roll @ ${speed} m/s`,
      start: approach(track, rampIndex, 30),
      speed,
      seconds: 5,
      bits: speed > 30 ? BOOST : THROTTLE,
      flipOnce: true,
      requireTrick: 'Barrel Roll',
      requireUpright: true
    })),
    // Thrusters from a standstill, up on the roof as on the ground.
    {
      name: 'thrust standstill',
      start: approach(track, thrustFrom, 70),
      speed: 0,
      seconds: 2.5,
      bits: InputBit.Thrust,
      requireHeight: roof + 4
    }
  ]
}
