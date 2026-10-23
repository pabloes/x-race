/**
 * The city circuit's cinematic, shot by shot: the main straight with the grid, the jump
 * and its pillars, the inverted run, and a closing push in on the cars.
 *
 * The points are read off the built track instead of typed in, so they stay on the feature
 * when a corner moves; only the offsets (how high, how far to the side) are authored here. Every
 * shot is at most a few metres from the road, so it should be re-checked in the explorer
 * after any change to the layout.
 */

import { gridCentre, validateIntro, type Shot } from '../cinematic'
import { vadd, vscale, type Vec3 } from '../math'
import type { Track } from '../tracks/types'

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

/** Unit forward and right vectors in the ground plane for a yaw in degrees. */
function frame(yawDeg: number): { fwd: Vec3; right: Vec3 } {
  const yaw = (yawDeg * Math.PI) / 180
  return { fwd: v(Math.sin(yaw), 0, Math.cos(yaw)), right: v(Math.cos(yaw), 0, -Math.sin(yaw)) }
}

/** `base` moved `along` metres forward, `across` to the right and `height` up. */
function place(base: Vec3, f: { fwd: Vec3; right: Vec3 }, along: number, across: number, height: number): Vec3 {
  const p = vadd(vadd(base, vscale(f.fwd, along)), vscale(f.right, across))
  return v(p.x, base.y + height, p.z)
}

export function cityIntro(track: Track): Shot[] {
  // The jump: the longest ramp, found by length so the flip's short kicker is not taken.
  const jump = track.surfaces
    .filter((s) => s.kind === 'ramp')
    .reduce((a, b) => (b.size.z > a.size.z ? b : a))
  const jumpFrame = frame(jump.rot[1])
  const takeoff = v(jump.pos.x, 0, jump.pos.z)

  // The flip: the inverted-roof zone, whose length runs along the slab.
  const zone = track.triggers.find((t) => t.kind === 'invert')
  if (!zone) throw new Error('city intro: the circuit has no invert zone')
  const zoneFrame = frame(zone.rot[1])
  const slab = v(zone.pos.x, 0, zone.pos.z)

  // The grid and the line, on the main straight.
  const grid = gridCentre(track.spawns)
  const gridFrame = frame(track.spawns[0].yaw)
  const line = track.surfaces.find((s) => s.kind === 'startline')
  const lineAt = line ? line.pos : grid

  const shots: Shot[] = [
    // 1. High over the main straight, flying along it from behind the jump to past the
    //    line, with the grid coming into frame. 3.5 s.
    {
      path: [
        place(takeoff, jumpFrame, -90, -26, 60),
        place(takeoff, jumpFrame, 0, -30, 52),
        place(grid, gridFrame, -10, -30, 44),
        place(lineAt, gridFrame, 25, -24, 38)
      ],
      look: [
        place(takeoff, jumpFrame, -20, 0, 2),
        place(takeoff, jumpFrame, 70, 0, 2),
        place(grid, gridFrame, 25, 0, 1),
        place(lineAt, gridFrame, 100, 0, 1)
      ],
      seconds: 3.5,
      fov: 70
    },
    // 2. Low and wide beside the ramp, panning with the car's flight over the pillars. 2.5 s.
    {
      path: [
        place(takeoff, jumpFrame, -12, -17, 2.5),
        place(takeoff, jumpFrame, 8, -19, 3.5),
        place(takeoff, jumpFrame, 32, -22, 6)
      ],
      look: [
        place(takeoff, jumpFrame, 4, 0, 1.5),
        place(takeoff, jumpFrame, 24, 0, 5),
        place(takeoff, jumpFrame, 52, 0, 5)
      ],
      seconds: 2.5,
      fov: 65,
      transition: 'cut'
    },
    // 3. The inverted run, from the infield side so the slab is seen from below as it passes. 3 s.
    {
      path: [
        place(slab, zoneFrame, -34, -22, 4),
        place(slab, zoneFrame, -6, -20, 8),
        place(slab, zoneFrame, 26, -22, 12)
      ],
      look: [
        place(slab, zoneFrame, -14, 0, 6),
        place(slab, zoneFrame, 8, 0, 9),
        place(slab, zoneFrame, 34, 0, 8)
      ],
      seconds: 3,
      fov: 70,
      transition: 'cut'
    },
    // 4. Back on the grid: in from the front and to the side, closing on the cars. 3 s.
    {
      path: [
        place(grid, gridFrame, 46, 16, 4),
        place(grid, gridFrame, 30, 12, 3.5),
        place(grid, gridFrame, 19, 9, 3)
      ],
      look: 'cars',
      seconds: 3,
      fov: 48,
      transition: 'cut'
    }
  ]

  validateIntro(shots)
  return shots
}
