/**
 * CITY: the original circuit.
 *
 * A GP-style stadium bowl in the spirit of Cheste: counter-clockwise, one long main
 * straight, a fast opening sweep, a technical infield and a long final left that loads the
 * car onto the straight. It is not a surveyed copy of Ricardo Tormo — the proportions are
 * ours and the stunt sections have no business being on a MotoGP track — but the character
 * is the same: 14 corners, mostly left, and a lap you learn in sectors.
 *
 * Driving direction is counter-clockwise on the map (+X is right, +Z is up), so the main
 * straight runs +X along the south edge.
 */

import type { TrackDefinition } from './types'

export const CITY: TrackDefinition = {
  id: 'city',
  name: 'CITY',
  theme: 'city',
  laps: 3,
  /**
   * The lap, as corner apexes in driving order. `r` is the radius the apex is rounded to:
   * big numbers are flat-out sweeps, small ones are the slow corners you brake for.
   *
   * Sector 1 is the main straight and the fast run up the east side, sector 2 the infield,
   * sector 3 the long left that feeds the straight again.
   */
  shape: [
    { x: 358, z: 58, r: 46, name: 'T1' },
    { x: 404, z: 140, r: 38, name: 'T2' },
    { x: 396, z: 243, r: 46, name: 'T3' },
    { x: 336, z: 314, r: 34, name: 'T4' },
    { x: 268, z: 316, r: 30, name: 'T5' },
    { x: 236, z: 396, r: 26, name: 'T6' },
    { x: 166, z: 404, r: 32, name: 'T7' },
    { x: 108, z: 339, r: 26, name: 'T8' },
    { x: 132, z: 260, r: 24, name: 'T9' },
    { x: 192, z: 234, r: 22, name: 'T10' },
    { x: 218, z: 174, r: 26, name: 'T11' },
    { x: 150, z: 135, r: 28, name: 'T12' },
    { x: 92, z: 214, r: 28, name: 'T13' },
    { x: 62, z: 64, r: 42, name: 'T14' }
  ],
  // The launch ramp on the main straight, the flip on the next longest.
  features: ['start-jump', 'ceiling']
}
