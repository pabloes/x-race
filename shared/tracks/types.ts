/**
 * The shapes a circuit comes in: what a definition authors (`TrackDefinition`) and what the
 * generator turns it into (`Track`), which is what the server builds colliders from and
 * the scene draws. See docs/contracts/tracks.md.
 */

import type { Shot } from '../cinematic'
import type { Vec3 } from '../math'

export type { Shot }

/** Grows with every circuit added to `TRACKS`. */
export type TrackId = 'city' | 'skyline'

/** Which scenery kit dresses the circuit, see docs/contracts/kit.md. */
export type Theme = 'city' | 'neon'

/** Euler angles in degrees, same convention as Decentraland's Quaternion.fromEulerDegrees. */
export type Euler = [number, number, number]

/**
 * A corner apex in driving order. `r` is the radius the apex is rounded to. `y` is the
 * height of the circuit at the vertex (0 if missing), interpolated smoothly along the
 * racing line between vertices.
 */
export type Vertex = { x: number; z: number; r: number; name: string; y?: number }

export type FeatureKind =
  | 'start'
  | 'start-jump'
  | 'jump'
  | 'ceiling'
  | 'gap'
  | 'tunnel'
  | 'corkscrew'
  | 'bigramp'

export type TrackDefinition = {
  id: TrackId
  /** Shown in the menu and on the vote chips. */
  name: string
  theme: Theme
  laps: number
  /** Driving order; scaled and centred into the scene by the generator. */
  shape: Vertex[]
  /**
   * Features in priority order. The generator gives each one the longest straight that
   * can hold it and throws if one does not fit. Missing: the original rule (start on the
   * longest straight, a jump on it if it is long enough, the flip on the next one).
   */
  features?: FeatureKind[]
  /** Metres of missing road in every `gap`; 18 if missing. */
  gapLength?: number
  /**
   * Flyover for the `intro` phase, or a function that reads it off the built track (shots
   * placed on the features, see `intros/`). Missing: `defaultIntro`, built from the track.
   */
  intro?: Shot[] | ((track: Track) => Shot[])
}

/**
 * `barrier` is the low wall along the road's edges: solid for the cars, drawn by the scenery
 * kit (decor.ts) and not by the track renderer, and no collider for an avatar on foot.
 */
export type SurfaceKind = 'ground' | 'road' | 'ramp' | 'ceiling' | 'wall' | 'startline' | 'building' | 'barrier'

export type Surface = {
  kind: SurfaceKind
  /** Centre of the box. */
  pos: Vec3
  /** Full extents (not half-extents). */
  size: Vec3
  rot: Euler
  friction: number
}

export type Obstacle = {
  kind: 'pillar' | 'block'
  pos: Vec3
  size: Vec3
  rot: Euler
}

export type TriggerKind = 'checkpoint' | 'boost' | 'invert'

export type Trigger = {
  id: string
  kind: TriggerKind
  /** Lap order for checkpoints; undefined for the rest. */
  index?: number
  pos: Vec3
  size: Vec3
  rot: Euler
}

export type Spawn = { pos: Vec3; yaw: number }

/**
 * One sample of the racing line. `dir` is the direction of travel there; `hint` is what a
 * bot should do on the way through (thrusters before a gap, and so on).
 */
export type PathPoint = { pos: Vec3; dir: Vec3; hint?: 'boost' | 'thrust' | 'brake' }

export type Track = {
  /** `${base}-${fingerprint}`: changes whenever the geometry does. */
  id: string
  base: TrackId
  name: string
  theme: Theme
  laps: number
  intro: Shot[]
  /** Scene size in metres (square). */
  extent: number
  /** Lap distance along the centreline, in metres. */
  lapLength: number
  surfaces: Surface[]
  obstacles: Obstacle[]
  triggers: Trigger[]
  spawns: Spawn[]
  checkpointCount: number
  /**
   * The racing line, roughly one point every few metres, at the height a car's chassis
   * sits. It follows the ceiling run in 3D, so a point's index is a much finer measure of
   * race progress than the checkpoints, and it gives the bots and the test harness
   * something to drive.
   */
  centreline: PathPoint[]
}
