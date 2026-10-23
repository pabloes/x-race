/**
 * SKYLINE: the stunt circuit, where the car's powers decide the lap.
 *
 * A ring round a block of towers, counter-clockwise like CITY, with a set piece on every
 * side. The main straight runs east along the south edge; the east side is the long
 * inverted tunnel; the north side climbs onto the rooftops, crosses a gap that takes the
 * boost or the thrusters, and comes back down; the west side is the corkscrew and then the
 * barrel-roll ramp, which drops the car onto the main straight again.
 *
 * Driving direction is counter-clockwise on the map (+X is right, +Z is up).
 */

import type { TrackDefinition } from './types'

export const SKYLINE: TrackDefinition = {
  id: 'skyline',
  name: 'SKYLINE',
  theme: 'neon',
  laps: 3,
  /**
   * Corner apexes in driving order. T3 and T4 are on the rooftops, 12 m up: the straights
   * either side of them are the climbs, and the one between them is level road on the roofs,
   * which is the only kind of straight a gap goes on. T3, T4 and T6 are kinks rather than
   * corners: they split a side into two straights, each long enough for its set piece.
   */
  shape: [
    { x: 400, z: -5, r: 36, name: 'T1' },
    { x: 400, z: 375, r: 32, name: 'T2' },
    { x: 280, z: 395, r: 60, name: 'T3', y: 12 },
    { x: 110, z: 395, r: 60, name: 'T4', y: 12 },
    { x: 0, z: 382, r: 30, name: 'T5' },
    { x: 14, z: 172, r: 50, name: 'T6' },
    { x: 0, z: -5, r: 32, name: 'T7' }
  ],
  // The gap claims the rooftop straight before anything else can; then the tunnel takes
  // the east side, the corkscrew the longer half of the west and the ramp what is left.
  features: ['start', 'gap', 'tunnel', 'corkscrew', 'bigramp'],
  /**
   * Longer than the generator's 18 m. At 18 a car flat out at 30 m/s without the boost
   * falls a few metres short, catches the far edge with its front wheels and bounces up
   * onto the roof, so the powers were optional. At 22 that car goes in; boosted, or on the
   * thrusters at half speed, it still clears with room.
   */
  gapLength: 22
}
