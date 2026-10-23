/**
 * Turns a `TrackDefinition` into a `Track`, authored once and consumed by both sides:
 *  - the server turns every `Surface` / `Obstacle` into a Rapier collider
 *  - the scene turns the same list into boxes with MeshRenderer + MeshCollider
 *
 * Scene-local coordinates of a 32 x 32 parcel scene (512 x 512 m), Y up, road surfaces at
 * y = 0.1 so they do not z-fight with the parcel floor.
 *
 * ## How the layout is authored
 *
 * Not as hand-placed straights and corners — that only works for a rectangle. The lap is a
 * closed polygon of corner vertices (`shape`), and each vertex is rounded off with a
 * tangent arc of its own radius, the way a real circuit is drawn. Two things fall out for
 * free: the loop always closes, because the polygon does, and every straight is exactly the
 * gap left between two arcs. Move a vertex and the whole circuit re-flows around it.
 *
 * `fillet()` fails loudly if a corner's radius is too big for the straights feeding it,
 * which is the one way this kind of layout goes wrong silently.
 *
 * Everything here is a pure function of the definition: no `Math.random`, no module
 * state. Server and scene each run it on their own machine and have to agree to the metre.
 */

import { BUILDING_CATALOG, CAR, RACE } from '../constants'
import { quatConjugate, quatFromEulerDegrees, quatRotate, vadd, vdot, vscale, vsub, type Vec3 } from '../math'
import type {
  Euler,
  FeatureKind,
  Obstacle,
  PathPoint,
  Spawn,
  Surface,
  SurfaceKind,
  Track,
  TrackDefinition,
  Trigger
} from './types'

// --- Layout constants -------------------------------------------------------

const EXTENT = 512
const ROAD_W = 15
/** Corners are wider than the straights, so running wide is recoverable. */
const CORNER_W = 19
const ROAD_T = 0.6
/** Top surface of every road piece. */
const ROAD_Y = 0.1
const DEFAULT_FRICTION = 1.1

/**
 * Spawn height. The car settles at y = 0.94 on its springs; spawning higher leaves it
 * briefly airborne, which would hand mid-air controls to a car sitting on the grid.
 */
const RIDE_HEIGHT = 0.95

/** Straights are cut into pieces this long, so the explorer can cull them per piece. */
const STRAIGHT_PIECE = 30
/** Arc segment chord. Short enough that the scalloped edge is not felt through the wheels. */
const ARC_PIECE = 6

/** Inverted ceiling run heights. */
const CEILING_Y = 10
const CEILING_EXIT_Y = 5

const CHECKPOINT_COUNT = 12

/**
 * Features are assigned by how long a straight turns out to be, not by index: the longest
 * straight is the main straight and gets the line and the grid, the next one is long enough
 * for the flip, the one after that takes the jump. Move a corner and they follow.
 */
type Feature = FeatureKind
/**
 * The launch ramp, sized from the car rather than by eye: a 15 degree ramp at top speed
 * throws the Roadster about 45 m, and the landing hill is put exactly there.
 */
const RAMP_RUN = 16
const RAMP_ANGLE = (15 * Math.PI) / 180
const RAMP_RISE = RAMP_RUN * Math.tan(RAMP_ANGLE)
const FLIGHT = (CAR.maxSpeed * CAR.maxSpeed * Math.sin(2 * RAMP_ANGLE)) / 9.81

/** How much straight the jump and the flip each need, end to end. */
const JUMP_SPAN = RAMP_RUN + FLIGHT + 20
const CEILING_SPAN = 70
/** Road either side of a feature, so nothing starts in the middle of a corner exit. */
const FEATURE_MARGIN = 26

// --- Height profile ---------------------------------------------------------
//
// Vertex heights are metres, not shape units: the shape is scaled to fit the scene, a
// rooftop is not. Corners are flat at their vertex's height and the straight between two
// corners eases from one height to the other with a smoothstep, whose slope is zero where it
// meets each corner, so neither end of a climb is felt as a crest. A straight whose ends
// differ is a climb and holds no feature: every set piece is built for level road.

/** Chord of a climb. At 12 m over 100 m the kink between two chords is under 2 degrees. */
const SLOPE_PIECE = 6

/**
 * Road higher than this has no parcel floor under it, nor for `VOID_MARGIN` either side.
 * A car that goes off a rooftop or into a gap falls out of the world and respawns at its
 * checkpoint, instead of landing on the gravel underneath and driving about under a circuit
 * it cannot get back onto: nothing down there leads up, and the checkpoints are overhead.
 */
const VOID_ABOVE = 3
const VOID_MARGIN = 14
/** Resolution of the holes cut in the floor. */
const GROUND_TILE = 8

// --- Gap --------------------------------------------------------------------

/** Missing road, by default. A definition can ask for another length (`gapLength`). */
const GAP_LENGTH = 18
/**
 * The kicker in front of a gap: 6 m at 6 degrees, a 0.63 m lip. Shallow on purpose, so the
 * throw comes from speed and not from the ramp. Range from the lip down to the landing, with
 * g = 16:
 *   12 m/s:  6 m   falls in, as it should
 *   30 m/s: 16 m   flat out is not enough; the boost is
 *   40 m/s: 26 m   boosted, clears it with a car's length to spare
 * The front wheels reach the far edge 3 to 4 m before the car's centre does and the springs
 * lift it onto the road, so a gap a car should not clear is a few metres longer than that
 * range (SKYLINE uses 22 m). With the thrusters lit the chassis has no gravity at all and
 * climbs at 11 m/s² instead, which is what crosses it at half speed.
 */
const GAP_KICK_RUN = 6
const GAP_KICK_RISE = GAP_KICK_RUN * Math.tan((6 * Math.PI) / 180)
/** The charge pad that pays for the crossing, this far before the lip. */
const GAP_PAD_BEFORE = 60
/** Road before the lip: the pad, and the corner exit behind it. */
const GAP_RUNUP = GAP_PAD_BEFORE + 10
/** Road after the gap: landing, and a straight line to gather the car before the corner. */
const GAP_RUNOUT = 40
/**
 * Where bots light the thrusters: from 6 m before the lip to 8 m past it. A burst, not the
 * whole way: lit, the car loses 30 % of its speed a second and gains 11 m/s² of climb, so
 * held across 18 m at 18 m/s it ends up 20 m over the roof. Let go 8 m out, it flies on and
 * clears 22 m from anything between 18 and 30 m/s, for a fifth of a bar or less.
 */
const GAP_THRUST_FROM = 6
const GAP_THRUST_TO = 8

// --- Tunnel -----------------------------------------------------------------

/**
 * The long inverted run. The entry and exit are the ceiling's, which is known to work from
 * 20 to 32 m/s: a 14 m kicker to 5 m, the slab 4 m further on at 10 m, and 20 m of slab
 * coming back down to 5 m before the invert zone ends and the car is rolled back upright.
 */
const TUNNEL_SLAB = 120
const TUNNEL_RUN = 18 + TUNNEL_SLAB + 20

// --- Big ramp ---------------------------------------------------------------

/**
 * A 22 degree ramp for barrel rolls, in three pitches rather than one crease: arriving at
 * 22 degrees from flat at 30 m/s puts the springs on their stops in a single tick. The lip is
 * 4.0 m up; from there, with g = 16:
 *   30 m/s: 1.7 s in the air, lands 47 m on, 8 m at the top
 *   40 m/s: 2.1 s, lands 78 m on
 * The assisted roll (E) takes 0.6 s, so there is time for it and to come out of it level.
 */
const BIGRAMP: [run: number, degrees: number][] = [
  [4, 8],
  [4, 15],
  [6, 22]
]
const BIGRAMP_RUN = BIGRAMP.reduce((total, [run]) => total + run, 0)
/** Flat road after the lip, for the longest boosted throw. */
const BIGRAMP_LANDING = 80

// --- Corkscrew --------------------------------------------------------------
//
// The only loop that can be built (README, "Por qué no hay loop de 360°"): a vertical loop
// whose exit is shifted sideways by `CORK_OFFSET`, so it does not come back down onto its own
// entry. Parametrised by the angle θ round the loop:
//
//   forward  R sin θ          height  R (1 - cos θ)          side  s(θ) = Δ (θ - sin θ) / 2π
//
// s' and s'' are both zero at θ = 0 and 2π, so the loop leaves and rejoins the road exactly
// along the straight. Each chord is a box oriented with the curve's Frenet frame: forward the
// tangent, up the principal normal (towards the centre of curvature, where the car is) and
// across the binormal. On a ribbon laid that way the centre line is a geodesic, so a car
// driving straight ahead with no steering follows it, shift included: the road banks up to
// 16 degrees one way on the climb and back on the descent, and that bank is what carries the
// car across. Euler angles cannot be read off the curve for that; they come from the basis.

/**
 * Loop radius. With g = 16 the car needs √(g R) = 14.4 m/s at the top to stay on the road;
 * coasting, that is 32 m/s on arrival for the 26 m climb. The engine pays for most of the
 * climb while the throttle is held: measured, the throttle alone carries the car round from
 * 20 m/s and the boost from 24. Smaller, and the bottom of the loop loads the car with more
 * than the 5 g it already takes at 30 m/s, which has the springs nearly on their stops;
 * larger, and the top asks for more speed than the climb leaves.
 */
const CORK_R = 13
/**
 * Sideways shift over the loop: the corner width plus 5 m. Where the loop comes back down it
 * is 23 m to the side of its entry road, so a 19 m wide loop and a 15 m road leave 6 m of air
 * between them (checked when the piece is built).
 */
const CORK_OFFSET = CORNER_W + 5
/** Chord of the loop: 15 degrees each at R = 13, short enough for the springs to follow. */
const CORK_CHORD = 3.5
/**
 * Each loop chord is this much longer at both ends. The path crosses the loop on the skew,
 * up to 34 degrees at the top, so two chords' square ends do not meet where their faces
 * cross: with 0.3 m of overlap the road had 0.6 m steps at its edges and 0.15 m three metres
 * off the centre line. With 2 m they are under 2 cm out to 7 m. The overlap is hidden on the
 * outside of the loop, under the next chord.
 */
const CORK_OVERLAP = 2
/** Straight before the loop's footprint, so its descending half clears the corner behind. */
const CORK_BEFORE = 40
/**
 * The S that brings the exit road back onto the line: a smoothstep over this length, which
 * for a 24 m shift has a tightest radius of 60 m, about 24 m/s for a bot.
 */
const CORK_RETURN = 93

/**
 * Metres of straight each feature needs, margins included: a feature only goes on a
 * straight longer than this. The start needs room for the grid behind the line. A gap's
 * span depends on its length, see `spanOf`.
 */
const SPAN: Partial<Record<Feature, number>> = {
  start: 60,
  'start-jump': 200,
  jump: JUMP_SPAN + 12,
  ceiling: CEILING_SPAN + 12,
  tunnel: TUNNEL_RUN + 2 * 16,
  bigramp: FEATURE_MARGIN + BIGRAMP_RUN + BIGRAMP_LANDING + 10,
  corkscrew: CORK_BEFORE + CORK_R + 4 + CORK_RETURN + 20
}

function spanOf(kind: Feature, gapLength: number): number | undefined {
  return kind === 'gap' ? GAP_RUNUP + gapLength + GAP_RUNOUT : SPAN[kind]
}

/** Clear space kept between the circuit and the parcel edge. */
const MARGIN = 54

/**
 * The shape is authored in its own space; this scales that design uniformly into the
 * scene and centres it, so the only number that decides how big the circuit is is
 * EXTENT. Uniform, because a non-uniform fit would turn the round corners into ovals the
 * arcs cannot follow.
 */
function fitted(def: TrackDefinition): { x: number; z: number; r: number; name: string; y: number }[] {
  const xs = def.shape.map((v) => v.x)
  const zs = def.shape.map((v) => v.z)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minZ = Math.min(...zs)
  const maxZ = Math.max(...zs)
  const k = (EXTENT - 2 * MARGIN) / Math.max(maxX - minX, maxZ - minZ)
  const dx = EXTENT / 2 - ((minX + maxX) / 2) * k
  const dz = EXTENT / 2 - ((minZ + maxZ) / 2) * k
  // Heights are not scaled: they are metres of rooftop, not units of the drawing.
  return def.shape.map((v) => ({ x: v.x * k + dx, z: v.z * k + dz, r: v.r * k, name: v.name, y: v.y ?? 0 }))
}

// --- Small vector helpers ---------------------------------------------------

type P2 = { x: number; z: number }

const sub = (a: P2, b: P2): P2 => ({ x: a.x - b.x, z: a.z - b.z })
const add = (a: P2, b: P2): P2 => ({ x: a.x + b.x, z: a.z + b.z })
const scale = (a: P2, k: number): P2 => ({ x: a.x * k, z: a.z * k })
const len = (a: P2): number => Math.hypot(a.x, a.z)
const unit = (a: P2): P2 => scale(a, 1 / (len(a) || 1))
/** Signed cross product in the XZ plane; its sign is the turn direction. */
const crossXZ = (a: P2, b: P2): number => a.x * b.z - a.z * b.x
/** The yaw that `strip` would give a box pointing along `d`. */
const yawOf = (d: P2): number => (Math.atan2(d.x, d.z) * 180) / Math.PI

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
})
const norm = (a: Vec3): Vec3 => vscale(a, 1 / (Math.hypot(a.x, a.y, a.z) || 1))
const DEG = 180 / Math.PI

/**
 * Euler angles (degrees, `quatFromEulerDegrees` order: roll, then pitch, then yaw) of the
 * rotation that takes the box axes X, Y, Z onto `right`, `up`, `forward`. Needed wherever a
 * box is rolled as well as pitched, which `strip` cannot describe. When the forward axis is
 * vertical, yaw and roll turn about the same axis and only their sum is defined, so roll is
 * taken as zero and the yaw read from the right axis instead.
 */
function eulerFromBasis(right: Vec3, up: Vec3, forward: Vec3): Euler {
  const pitch = Math.asin(Math.max(-1, Math.min(1, -forward.y)))
  if (Math.abs(Math.cos(pitch)) < 1e-6) return [pitch * DEG, Math.atan2(-right.z, right.x) * DEG, 0]
  return [pitch * DEG, Math.atan2(forward.x, forward.z) * DEG, Math.atan2(right.y, up.y) * DEG]
}

// --- Builders ---------------------------------------------------------------

/**
 * Offsets a box centre away from its drive surface along the box's own up axis, so the
 * authored points describe the surface the car touches rather than the box middle.
 * `under` flips it for ceilings, where the drive surface is the bottom face.
 */
function offsetFromSurface(pos: Vec3, rot: Euler, thickness: number, under: boolean): Vec3 {
  const q = quatFromEulerDegrees(rot[0], rot[1], rot[2])
  const d = quatRotate(q, { x: 0, y: (under ? 1 : -1) * (thickness / 2), z: 0 })
  return { x: pos.x + d.x, y: pos.y + d.y, z: pos.z + d.z }
}

/**
 * A straight piece of track between two points. The horizontal heading becomes yaw and
 * the slope becomes pitch, so this builds flat road, ramps and ceiling ramps alike.
 */
function strip(
  kind: SurfaceKind,
  from: Vec3,
  to: Vec3,
  width = ROAD_W,
  under = false,
  friction = DEFAULT_FRICTION
): Surface {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const horizontal = Math.hypot(dx, dz)
  const yaw = (Math.atan2(dx, dz) * 180) / Math.PI
  // Positive pitch dips the nose, so a climb needs a negative pitch.
  const pitch = (-Math.atan2(dy, horizontal) * 180) / Math.PI
  const rot: Euler = [pitch, yaw, 0]
  const mid: Vec3 = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 }
  return {
    kind,
    pos: offsetFromSurface(mid, rot, ROAD_T, under),
    size: { x: width, y: ROAD_T, z: Math.hypot(horizontal, dy) },
    rot,
    friction
  }
}

/** A city block. Solid, so it both decorates the skyline and closes off a shortcut. */
function building(x: number, z: number, width: number, depth: number, height: number): Surface {
  return {
    kind: 'building',
    pos: { x, y: height / 2, z },
    size: { x: width, y: height, z: depth },
    rot: [0, 0, 0],
    friction: 0.4
  }
}

// --- Laying out the lap -----------------------------------------------------

type Arc = {
  centre: P2
  radius: number
  /** Radians, signed: the sweep runs from `from` to `from + sweep`. */
  from: number
  sweep: number
  entry: P2
  exit: P2
  name: string
}

/**
 * Rounds one corner of the polygon: finds where the arc of radius `r` leaves the incoming
 * straight and rejoins the outgoing one.
 */
function fillet(prev: P2, here: P2, next: P2, r: number, name: string): Arc {
  const din = unit(sub(here, prev))
  const dout = unit(sub(next, here))
  const turn = Math.asin(Math.max(-1, Math.min(1, crossXZ(din, dout))))
  const dotp = din.x * dout.x + din.z * dout.z
  // asin alone cannot tell a 30 degree turn from a 150 degree one.
  const angle = dotp >= 0 ? turn : Math.sign(turn) * (Math.PI - Math.abs(turn))
  const tangent = r * Math.tan(Math.abs(angle) / 2)
  const entry = add(here, scale(din, -tangent))
  const exit = add(here, scale(dout, tangent))
  // The centre sits perpendicular to the incoming straight, on the *inside* of the turn:
  // left of the car for a left-hander, right for a right-hander. A positive cross product
  // is a left turn here, and the left normal of (x, z) is (-z, x).
  const side = Math.sign(angle) || 1
  const normal: P2 = { x: -din.z * side, z: din.x * side }
  const centre = add(entry, scale(normal, r))
  const from = Math.atan2(entry.z - centre.z, entry.x - centre.x)
  // Sweeping the same way the car turns keeps the arc tangent to both straights.
  return { centre, radius: r, from, sweep: angle, entry, exit, name }
}

/** Point on an arc at parameter t in [0, 1]. */
function arcPoint(a: Arc, t: number): P2 {
  const angle = a.from + a.sweep * t
  return { x: a.centre.x + a.radius * Math.cos(angle), z: a.centre.z + a.radius * Math.sin(angle) }
}

function arcTangent(a: Arc, t: number): P2 {
  const angle = a.from + a.sweep * t
  const dir = Math.sign(a.sweep)
  return unit({ x: -Math.sin(angle) * dir, z: Math.cos(angle) * dir })
}

// --- The circuit ------------------------------------------------------------

type Hint = NonNullable<PathPoint['hint']>

/**
 * A racing line sample while the lap is walked; `distance` is metres from the line.
 * `inverted` marks the samples upside down under a slab, `noCp` the ones inside a set piece,
 * where neither a checkpoint nor the respawn 10 m behind it belongs, and `cpHere` the one
 * point of an inverted run that gets a checkpoint of its own. `floor` is 0 if missing.
 */
type Sample = {
  pos: Vec3
  dir: P2
  distance: number
  hint?: Hint
  inverted?: boolean
  noCp?: boolean
  cpHere?: boolean
  /** Height of the level road there, under whatever the set piece lifts the line onto. */
  floor?: number
}
type SampleFlags = Omit<Sample, 'pos' | 'dir' | 'distance'>

/** A rectangle of parcel floor left out, centred on `centre` and turned to `yaw` degrees. */
type Void = { centre: P2; yaw: number; halfLength: number; halfWidth: number }

/** What the straight builders write into, and the definition's numbers they need. */
type Build = {
  surfaces: Surface[]
  obstacles: Obstacle[]
  triggers: Trigger[]
  voids: Void[]
  sample: (pos: Vec3, dir: P2, at: number, flags?: SampleFlags) => void
  gapLength: number
}

export function buildTrack(def: TrackDefinition): Track {
  if (def.intro && def.intro.length > 0) {
    // The flyover runs against the server's `intro` phase, so a list that does not fill it
    // either cuts off mid-shot or leaves the camera parked before the countdown.
    const seconds = def.intro.reduce((total, shot) => total + shot.seconds, 0)
    if (Math.abs(seconds - RACE.introMs / 1000) > 0.5) {
      throw new Error(`track ${def.id}: intro lasts ${seconds} s, the intro phase ${RACE.introMs / 1000} s`)
    }
  }

  const surfaces: Surface[] = []
  const obstacles: Obstacle[] = []
  const triggers: Trigger[] = []
  const voids: Void[] = []

  // Perimeter walls, so a car that runs wide stays inside the parcels. The parcel-wide
  // floor goes in front of them once the lap is known, because it has holes where the lap
  // runs high (see `buildGround`).
  for (const [x, z, sx, sz] of [
    [EXTENT / 2, 0.5, EXTENT, 1],
    [EXTENT / 2, EXTENT - 0.5, EXTENT, 1],
    [0.5, EXTENT / 2, 1, EXTENT],
    [EXTENT - 0.5, EXTENT / 2, 1, EXTENT]
  ]) {
    surfaces.push({
      kind: 'wall',
      pos: { x, y: 2, z },
      size: { x: sx, y: 4, z: sz },
      rot: [0, 0, 0],
      friction: 0.2
    })
  }

  // 1. Fit the authored shape to the scene, then round every corner of it.
  const shape = fitted(def)
  const n = shape.length
  const arcs: Arc[] = shape.map((v, i) =>
    fillet(shape[(i - 1 + n) % n], v, shape[(i + 1) % n], v.r, v.name)
  )

  // Every corner has to fit between the two straights feeding it. If it does not, the
  // arcs overlap and the lap quietly stops being a lap — so say so instead.
  const tooTight: string[] = []
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n
    const edge = len(sub(shape[next], shape[i]))
    const needed = tangentOf(arcs[i]) + tangentOf(arcs[next])
    // Leave at least 4 m of actual straight between two corners, or they blend into one.
    if (needed > edge - 4) {
      tooTight.push(
        `${arcs[i].name}->${arcs[next].name}: ${edge.toFixed(1)} m apart, radii need ${needed.toFixed(1)} m`
      )
    }
  }
  if (tooTight.length > 0) {
    throw new Error(`track ${def.id}: corners do not fit:\n  ${tooTight.join('\n  ')}`)
  }

  // 2. Rank the straights: longest is the main straight, then the flip, then the jump.
  const straights = arcs.map((a, i) => ({
    index: i,
    from: a.exit,
    to: arcs[(i + 1) % n].entry,
    length: len(sub(arcs[(i + 1) % n].entry, a.exit)),
    level: shape[i].y === shape[(i + 1) % n].y,
    height: Math.min(shape[i].y, shape[(i + 1) % n].y)
  }))
  const byLength = [...straights].sort((a, b) => b.length - a.length)
  const gapLength = def.gapLength ?? GAP_LENGTH
  const feature = assignFeatures(def, byLength, gapLength)
  // Boost pads go on the next longest straights, where they are worth taking. Not on a
  // climb, nor on a set piece that brings its own road layout (a gap brings its own pad).
  const padFree: (Feature | undefined)[] = ['gap', 'tunnel', 'corkscrew', 'bigramp']
  const boostOn = new Set(
    byLength
      .filter((s) => s.level && padFree.indexOf(feature.get(s.index)) === -1)
      .slice(3, 6)
      .map((s) => s.index)
  )

  // 3. Walk the lap, emitting geometry and sampling the racing line as we go.
  const path: Sample[] = []
  let distance = 0
  const build: Build = {
    surfaces,
    obstacles,
    triggers,
    voids,
    sample: (pos, dir, at, flags) => {
      path.push({ pos, dir, distance: at, ...flags })
    },
    gapLength
  }

  for (let i = 0; i < n; i++) {
    const a = arcs[i]
    const h = shape[i].y

    // The arc itself, as flat chords. Flat on purpose: a *banked* arc cannot be made of
    // boxes, because each box banks about its own axis and two neighbours disagree about
    // the surface height at the outer edge by enough to catch a chassis.
    const arcLength = Math.abs(a.sweep) * a.radius
    const steps = Math.max(2, Math.round(arcLength / ARC_PIECE))
    const chord = (2 * a.radius * Math.sin(Math.abs(a.sweep) / (2 * steps))) * 1.06
    for (let s = 0; s < steps; s++) {
      const mid = arcPoint(a, (s + 0.5) / steps)
      const rot: Euler = [0, yawOf(arcTangent(a, (s + 0.5) / steps)), 0]
      surfaces.push({
        kind: 'road',
        pos: offsetFromSurface({ x: mid.x, y: ROAD_Y + h, z: mid.z }, rot, ROAD_T, false),
        size: { x: CORNER_W, y: ROAD_T, z: chord },
        rot,
        friction: DEFAULT_FRICTION
      })
      if (h >= VOID_ABOVE) {
        voids.push({ centre: mid, yaw: rot[1], halfLength: chord / 2 + VOID_MARGIN, halfWidth: CORNER_W / 2 + VOID_MARGIN })
      }
      const point = arcPoint(a, (s + 1) / steps)
      distance += arcLength / steps
      build.sample(
        { x: point.x, y: ROAD_Y + RIDE_HEIGHT + h, z: point.z },
        arcTangent(a, (s + 1) / steps),
        distance,
        h ? { floor: h } : undefined
      )
    }

    // Then the straight from this corner's exit to the next corner's entry.
    const b = arcs[(i + 1) % n]
    distance = buildStraight(build, a.exit, b.entry, h, shape[(i + 1) % n].y, feature.get(i), boostOn.has(i), distance)
  }

  // 4. Checkpoints, evenly spaced round the lap, plus one inside each inverted run so it
  //    cannot be skipped by staying on the road underneath. Where the lap has set pieces
  //    they are spread over the road between them instead: a checkpoint in a corkscrew or
  //    over a gap would put the respawn behind it in the air.
  const lapLength = distance
  const pointAt = (d: number): Sample => {
    const wrapped = ((d % lapLength) + lapLength) % lapLength
    let best = path[0]
    for (const p of path) {
      if (p.distance <= wrapped) best = p
      else break
    }
    return best
  }

  const stops = path.some((p) => p.noCp)
    ? spreadOver(openRuns(path), CHECKPOINT_COUNT)
    : [...Array(CHECKPOINT_COUNT).keys()].map((i) => (i * lapLength) / CHECKPOINT_COUNT)
  for (const special of path.filter((p) => p.cpHere)) {
    // Replace whichever stop is nearest, rather than adding one, so the spacing stays even
    // and the count stays fixed.
    let nearest = 0
    for (let i = 1; i < stops.length; i++) {
      if (Math.abs(stops[i] - special.distance) < Math.abs(stops[nearest] - special.distance)) {
        nearest = i
      }
    }
    stops[nearest] = special.distance
  }

  stops.forEach((d, index) => {
    const p = pointAt(d)
    const onCeiling = p.inverted === true
    triggers.push({
      id: `cp${index}`,
      kind: 'checkpoint',
      index,
      // Gates stand on the road, however high it runs: 4.5 m is half of a 9 m gate.
      pos: { x: p.pos.x, y: onCeiling ? p.pos.y : (p.floor ?? 0) + 4.5, z: p.pos.z },
      size: { x: ROAD_W + 7, y: onCeiling ? 3.5 : 9, z: 3 },
      rot: [0, yawOf(p.dir), 0]
    })
  })

  // 5. The grid, on the main straight behind the line.
  const main = byLength[0]
  const spawns = buildGrid(main.from, main.to, shape[main.index].y)

  // 6. Grandstands, paddock and city blocks, grown on a grid over everything the circuit
  //    does not use. They are what stops a car driving across the infield from one
  //    checkpoint to the next, and they give the cockpit a horizon. Generated rather than
  //    hand-placed: a hand-placed list silently ends up on the racing line the first time
  //    a corner moves.
  surfaces.push(...scatterBuildings(path))

  // 7. The parcel floor, first in the list as it always was, with the holes cut.
  surfaces.unshift(...buildGround(voids))

  const track: Track = {
    id: def.id,
    base: def.id,
    name: def.name,
    theme: def.theme,
    laps: def.laps,
    // A definition without shots gets the generic flyover from the cinematics module,
    // which builds it from this same Track once that module is in.
    intro: def.intro ?? [],
    extent: EXTENT,
    lapLength,
    surfaces,
    obstacles,
    triggers,
    spawns,
    checkpointCount: CHECKPOINT_COUNT,
    centreline: path.map((p) => ({
      pos: p.pos,
      dir: { x: p.dir.x, y: 0, z: p.dir.z },
      ...(p.hint ? { hint: p.hint } : {})
    }))
  }
  return { ...track, id: `${def.id}-${fingerprint(track)}` }
}

/** Stretches of the lap, as [from, to] distances, where a checkpoint may go. */
function openRuns(path: Sample[]): [number, number][] {
  const runs: [number, number][] = []
  let start: number | null = null
  let previous = 0
  for (const p of path) {
    if (!p.noCp && start === null) start = p.distance
    if (p.noCp && start !== null) {
      runs.push([start, previous])
      start = null
    }
    previous = p.distance
  }
  if (start !== null) runs.push([start, previous])
  return runs
}

/** `count` distances spaced evenly over the total length of `runs`, as if they were one. */
function spreadOver(runs: [number, number][], count: number): number[] {
  const total = runs.reduce((sum, [a, b]) => sum + (b - a), 0)
  return [...Array(count).keys()].map((i) => {
    let left = (i * total) / count
    for (const [a, b] of runs) {
      if (left <= b - a) return a + left
      left -= b - a
    }
    return runs[runs.length - 1][1]
  })
}

type Straight = { index: number; length: number; level: boolean; height: number }

/**
 * Whether a straight can hold a feature at all, length aside. Every set piece is built for
 * level road. A gap only goes on a rooftop: lower down, the drop under it would be a pit in
 * a floor the explorer still draws, and the car would sink through the gravel.
 */
function admits(kind: Feature, s: Straight): boolean {
  return s.level && (kind !== 'gap' || s.height >= VOID_ABOVE)
}

/**
 * Which straight gets which feature, keyed by the index of the corner it leaves.
 *
 * The start always takes the longest straight: it is the main straight, and the grid and
 * the line need the room. Everything else, in the definition's order, takes the longest
 * straight still free that is longer than its span. A feature asked for that does not fit
 * is an error, not a circuit quietly built without it; only the default list (no
 * `features` in the definition) treats the flip as optional, as it always has. Which
 * straights can hold what at all is `admits`.
 */
function assignFeatures(
  def: TrackDefinition,
  byLength: Straight[],
  gapLength: number
): Map<number, Feature> {
  const main = byLength[0]
  const optional = def.features === undefined
  const wanted: Feature[] = def.features ?? [
    main.length > SPAN['start-jump']! ? 'start-jump' : 'start',
    'ceiling'
  ]
  const start = wanted.filter((f) => f === 'start' || f === 'start-jump')
  if (start.length !== 1) throw new Error(`track ${def.id}: needs exactly one of 'start' or 'start-jump'`)

  const feature = new Map<number, Feature>()
  const fail = (kind: Feature): never => {
    throw new Error(`track ${def.id}: no level straight left is long enough for '${kind}'`)
  }
  if (main.length <= SPAN[start[0]]! || !admits(start[0], main)) fail(start[0])
  feature.set(main.index, start[0])
  for (const kind of wanted) {
    if (kind === 'start' || kind === 'start-jump') continue
    const span = spanOf(kind, gapLength)
    if (span === undefined) throw new Error(`track ${def.id}: the generator does not build '${kind}'`)
    const straight = byLength.find((s) => !feature.has(s.index) && admits(kind, s) && s.length > span)
    if (straight) feature.set(straight.index, kind)
    else if (!optional) fail(kind)
  }
  return feature
}

/**
 * A short hash of the geometry, appended to the track id.
 *
 * Server and client build the circuit independently from this file, and they are deployed
 * independently too: a server left running from before a change happily collides a car
 * against a wall the client is no longer drawing. A name alone does not catch that — the
 * name does not change when a corner moves — so the id carries the shape with it, the
 * server sends it in the welcome and the client refuses to pretend everything is fine.
 */
function fingerprint(track: Track): string {
  let hash = 0x811c9dc5
  const mix = (value: number): void => {
    hash ^= Math.round(value * 100) | 0
    hash = Math.imul(hash, 0x01000193)
  }
  for (const s of track.surfaces) {
    mix(s.pos.x)
    mix(s.pos.y)
    mix(s.pos.z)
    mix(s.size.x)
    mix(s.size.y)
    mix(s.size.z)
    mix(s.rot[0])
    mix(s.rot[1])
  }
  for (const o of track.obstacles) {
    mix(o.pos.x)
    mix(o.pos.y)
    mix(o.pos.z)
    mix(o.size.x)
    mix(o.size.y)
    mix(o.size.z)
  }
  for (const t of track.triggers) {
    mix(t.pos.x)
    mix(t.pos.z)
    mix(t.size.x)
  }
  for (const s of track.spawns) {
    mix(s.pos.x)
    mix(s.pos.z)
    mix(s.yaw)
  }
  mix(track.lapLength)
  return (hash >>> 0).toString(36)
}

/**
 * Emits one straight and whatever happens on it, sampling the racing line as it goes.
 * Returns the running lap distance. `h0` and `h1` are the heights of the corners at either
 * end: level road at that height, or a climb between them.
 */
function buildStraight(
  b: Build,
  from: P2,
  to: P2,
  h0: number,
  h1: number,
  feature: Feature | undefined,
  boost: boolean,
  distance: number
): number {
  if (h0 !== h1) return buildClimb(b, from, to, h0, h1, distance)
  const h = h0
  const { surfaces, obstacles, triggers } = b
  const d = sub(to, from)
  const length = len(d)
  const dir = unit(d)
  const at = (metres: number): P2 => add(from, scale(dir, metres))
  const yaw = yawOf(dir)

  if (feature === 'corkscrew') return buildCorkscrew(b, from, dir, length, h, distance)

  if (h >= VOID_ABOVE) {
    b.voids.push({ centre: at(length / 2), yaw, halfLength: length / 2 + VOID_MARGIN, halfWidth: ROAD_W / 2 + VOID_MARGIN })
  }

  // The road itself, in cullable pieces; a gap leaves a stretch of it out.
  const lip = feature === 'gap' ? gapLip(length, b.gapLength) : -1
  if (lip >= 0) {
    roadRun(b, at, 0, lip, h)
    roadRun(b, at, lip + b.gapLength, length, h)
  } else {
    roadRun(b, at, 0, length, h)
  }

  if (boost) {
    const at = add(from, scale(dir, length * 0.35))
    triggers.push({
      id: `boost-${Math.round(at.x)}-${Math.round(at.z)}`,
      kind: 'boost',
      pos: { x: at.x, y: ROAD_Y + 1.2 + h, z: at.z },
      size: { x: ROAD_W, y: 2.4, z: 5 },
      rot: [0, yaw, 0]
    })
  }

  if (feature === 'start' || feature === 'start-jump') {
    // Line three quarters of the way down, so the grid behind it still sits on the straight.
    const line = at(length * 0.72)
    surfaces.push({
      kind: 'startline',
      pos: { x: line.x, y: ROAD_Y + 0.02 + h, z: line.z },
      size: { x: ROAD_W, y: 0.04, z: 1.4 },
      rot: [0, yaw, 0],
      friction: DEFAULT_FRICTION
    })
  }

  if (feature === 'start-jump' || feature === 'jump') {
    // A ramp, two low pillars to clear, and a landing hill placed where the car actually
    // comes down rather than where it looks right on paper: v^2*sin(2θ)/g. Get that wrong
    // and the car flies clean over the hill, lands flat at 30 m/s and bounces off the
    // circuit — which is exactly what happened when the top speed went up and the ramp
    // stayed where it was.
    const s = feature === 'start-jump' ? FEATURE_MARGIN : Math.max(6, (length - JUMP_SPAN) / 2)
    const up = at(s)
    const crest = at(s + RAMP_RUN)
    surfaces.push(strip('ramp', { x: up.x, y: ROAD_Y + h, z: up.z }, { x: crest.x, y: RAMP_RISE + h, z: crest.z }))
    for (const m of [s + RAMP_RUN + 10, s + RAMP_RUN + 20]) {
      const p = at(m)
      obstacles.push({
        kind: 'pillar',
        pos: { x: p.x, y: ROAD_Y + 0.9 + h, z: p.z },
        size: { x: 1.4, y: 1.8, z: 1.4 },
        rot: [0, 0, 0]
      })
    }
    // Landing: flat. A hill rising into a descending car is a second kicker, which is how
    // the fastest bot kept launching itself off the circuit; the suspension takes the hit
    // better than the geometry does.
  }

  if (feature === 'ceiling') {
    // Kicker up into the slab, the inverted run, then a descending slab that walks the car
    // back down to the road. The road continues underneath the whole way, so a car that
    // misses the flip simply drives under it — and so respawns always have tarmac below.
    const s = Math.max(FEATURE_MARGIN * 0.6, (length - CEILING_SPAN) / 2)
    const kickFrom = at(s)
    const kickTo = at(s + 14)
    const slabFrom = at(s + 18)
    const slabTo = at(s + 50)
    const dropTo = at(s + 70)
    surfaces.push(
      strip('ramp', { x: kickFrom.x, y: ROAD_Y + h, z: kickFrom.z }, { x: kickTo.x, y: 5 + h, z: kickTo.z })
    )
    surfaces.push(
      strip(
        'ceiling',
        { x: slabFrom.x, y: CEILING_Y + h, z: slabFrom.z },
        { x: slabTo.x, y: CEILING_Y + h, z: slabTo.z },
        ROAD_W,
        true
      )
    )
    surfaces.push(
      strip(
        'ceiling',
        { x: slabTo.x, y: CEILING_Y + h, z: slabTo.z },
        { x: dropTo.x, y: CEILING_EXIT_Y + h, z: dropTo.z },
        ROAD_W,
        true
      )
    )
    const zoneFrom = at(s + 16)
    const zoneTo = at(s + 70)
    triggers.push({
      id: 'invert-zone',
      kind: 'invert',
      pos: { x: (zoneFrom.x + zoneTo.x) / 2, y: 9 + h, z: (zoneFrom.z + zoneTo.z) / 2 },
      size: { x: ROAD_W + 2, y: 10, z: len(sub(zoneTo, zoneFrom)) },
      rot: [0, yaw, 0]
    })
  }

  // The newer set pieces lay their own geometry and say what the racing line does over it.
  const profile =
    lip >= 0
      ? buildGap(b, at, yaw, lip, h)
      : feature === 'tunnel'
        ? buildTunnel(b, at, yaw, length, h)
        : feature === 'bigramp'
          ? buildBigRamp(b, at, length, h)
          : undefined

  // Sample the racing line along the straight, lifting it onto the ceiling where there is
  // one: the bots and the harness drive these points, so they have to follow the flip.
  const steps = Math.max(2, Math.round(length / ARC_PIECE))
  let ceilingMarked = false
  for (let i = 1; i <= steps; i++) {
    const m = (length * i) / steps
    const p = at(m)
    let y = ROAD_Y + RIDE_HEIGHT + h
    let flags: SampleFlags | undefined
    if (feature === 'ceiling') {
      const s = length * 0.18
      if (m > s && m <= s + 16) y = ROAD_Y + RIDE_HEIGHT + h + ((m - s) / 16) * 4
      else if (m > s + 16 && m <= s + 50) y = CEILING_Y - RIDE_HEIGHT + h
      else if (m > s + 50 && m <= s + 70) {
        const t = (m - (s + 50)) / 20
        y = CEILING_Y - RIDE_HEIGHT + t * (CEILING_EXIT_Y - CEILING_Y) + h
      }
      flags = { inverted: y - h > 6, cpHere: !ceilingMarked && y - h > 6 }
      if (flags.cpHere) ceilingMarked = true
    } else if (profile) {
      const here = profile(m)
      y = here.y + h
      flags = here.flags
    }
    b.sample({ x: p.x, y, z: p.z }, dir, distance + m, h ? { ...flags, floor: h } : flags)
  }
  return distance + length
}

/** Pieces of level road from `m0` to `m1` along a line, at most `STRAIGHT_PIECE` each. */
function roadRun(b: Build, at: (metres: number) => P2, m0: number, m1: number, h: number): void {
  const pieces = Math.max(1, Math.round((m1 - m0) / STRAIGHT_PIECE))
  for (let p = 0; p < pieces; p++) {
    const a = at(m0 + ((m1 - m0) * p) / pieces)
    const c = at(m0 + ((m1 - m0) * (p + 1)) / pieces)
    b.surfaces.push(strip('road', { x: a.x, y: ROAD_Y + h, z: a.z }, { x: c.x, y: ROAD_Y + h, z: c.z }, ROAD_W))
  }
}

/** What a set piece says about the racing line `m` metres down its straight. */
type Profile = (m: number) => { y: number; flags?: SampleFlags }

const smoothstep = (t: number): number => t * t * (3 - 2 * t)

/**
 * A straight between two corners at different heights: the road eases up (or down) with
 * a smoothstep in short chords, so a 12 m rise over 100 m peaks at ten degrees mid-climb
 * and is flat where it meets each corner.
 */
function buildClimb(b: Build, from: P2, to: P2, h0: number, h1: number, distance: number): number {
  const d = sub(to, from)
  const length = len(d)
  const dir = unit(d)
  const at = (metres: number): P2 => add(from, scale(dir, metres))
  const heightAt = (m: number): number => h0 + (h1 - h0) * smoothstep(m / length)
  const pieces = Math.max(2, Math.round(length / SLOPE_PIECE))
  for (let p = 0; p < pieces; p++) {
    const m0 = (length * p) / pieces
    const m1 = (length * (p + 1)) / pieces
    const a = at(m0)
    const c = at(m1)
    b.surfaces.push(
      strip('road', { x: a.x, y: ROAD_Y + heightAt(m0), z: a.z }, { x: c.x, y: ROAD_Y + heightAt(m1), z: c.z })
    )
    if ((heightAt(m0) + heightAt(m1)) / 2 >= VOID_ABOVE) {
      b.voids.push({
        centre: at((m0 + m1) / 2),
        yaw: yawOf(dir),
        halfLength: (m1 - m0) / 2 + VOID_MARGIN,
        halfWidth: ROAD_W / 2 + VOID_MARGIN
      })
    }
  }
  const steps = Math.max(2, Math.round(length / ARC_PIECE))
  for (let i = 1; i <= steps; i++) {
    const m = (length * i) / steps
    const p = at(m)
    b.sample({ x: p.x, y: ROAD_Y + RIDE_HEIGHT + heightAt(m), z: p.z }, dir, distance + m, { floor: heightAt(m) })
  }
  return distance + length
}

/** Where a gap's lip goes on a straight: centred, inside the run-up and run-out it needs. */
function gapLip(length: number, gapLength: number): number {
  return Math.min(Math.max((length - gapLength) / 2, GAP_RUNUP), length - gapLength - GAP_RUNOUT)
}

/**
 * A gap: road missing for `gapLength` after a short kicker, the charge pad that pays for
 * the crossing, and no floor underneath, so a car that does not make it drops out of the
 * world and respawns rather than landing in a street it cannot leave.
 */
function buildGap(b: Build, at: (metres: number) => P2, yaw: number, lip: number, h: number): Profile {
  const gap = b.gapLength
  const kickFrom = at(lip - GAP_KICK_RUN)
  const kickTo = at(lip)
  b.surfaces.push(
    strip('ramp', { x: kickFrom.x, y: ROAD_Y + h, z: kickFrom.z }, { x: kickTo.x, y: ROAD_Y + h + GAP_KICK_RISE, z: kickTo.z })
  )
  const pad = at(lip - GAP_PAD_BEFORE)
  b.triggers.push({
    id: `boost-${Math.round(pad.x)}-${Math.round(pad.z)}`,
    kind: 'boost',
    pos: { x: pad.x, y: ROAD_Y + 1.2 + h, z: pad.z },
    size: { x: ROAD_W, y: 2.4, z: 5 },
    rot: [0, yaw, 0]
  })
  b.voids.push({ centre: at(lip + gap / 2), yaw, halfLength: gap / 2 + 4, halfWidth: ROAD_W / 2 + VOID_MARGIN })
  return (m) => {
    const onKicker = m > lip - GAP_KICK_RUN && m <= lip
    return {
      y: ROAD_Y + RIDE_HEIGHT + (onKicker ? ((m - (lip - GAP_KICK_RUN)) / GAP_KICK_RUN) * GAP_KICK_RISE : 0),
      flags: {
        hint: m >= lip - GAP_THRUST_FROM && m <= lip + GAP_THRUST_TO ? 'thrust' : undefined,
        noCp: m >= lip - GAP_PAD_BEFORE - 15 && m <= lip + gap + 20
      }
    }
  }
}

/** The long inverted run: the ceiling's kicker and exit, with a 120 m slab between them. */
function buildTunnel(b: Build, at: (metres: number) => P2, yaw: number, length: number, h: number): Profile {
  const s = Math.max(FEATURE_MARGIN * 0.6, (length - TUNNEL_RUN) / 2)
  const slabFrom = s + 18
  const slabTo = slabFrom + TUNNEL_SLAB
  const dropTo = slabTo + 20
  const kickFrom = at(s)
  const kickTo = at(s + 14)
  b.surfaces.push(strip('ramp', { x: kickFrom.x, y: ROAD_Y + h, z: kickFrom.z }, { x: kickTo.x, y: 5 + h, z: kickTo.z }))
  // The slab in cullable pieces; flat, so the joints are flush.
  const pieces = Math.round(TUNNEL_SLAB / STRAIGHT_PIECE)
  for (let p = 0; p < pieces; p++) {
    const a = at(slabFrom + (TUNNEL_SLAB * p) / pieces)
    const c = at(slabFrom + (TUNNEL_SLAB * (p + 1)) / pieces)
    b.surfaces.push(strip('ceiling', { x: a.x, y: CEILING_Y + h, z: a.z }, { x: c.x, y: CEILING_Y + h, z: c.z }, ROAD_W, true))
  }
  const slabEnd = at(slabTo)
  const dropEnd = at(dropTo)
  b.surfaces.push(
    strip('ceiling', { x: slabEnd.x, y: CEILING_Y + h, z: slabEnd.z }, { x: dropEnd.x, y: CEILING_EXIT_Y + h, z: dropEnd.z }, ROAD_W, true)
  )
  const zoneFrom = at(s + 16)
  b.triggers.push({
    id: `invert-${Math.round(zoneFrom.x)}-${Math.round(zoneFrom.z)}`,
    kind: 'invert',
    pos: { x: (zoneFrom.x + dropEnd.x) / 2, y: 9 + h, z: (zoneFrom.z + dropEnd.z) / 2 },
    size: { x: ROAD_W + 2, y: 10, z: len(sub(dropEnd, zoneFrom)) },
    rot: [0, yaw, 0]
  })
  let marked = false
  return (m) => {
    let y = ROAD_Y + RIDE_HEIGHT
    if (m > s && m <= s + 16) y = ROAD_Y + RIDE_HEIGHT + ((m - s) / 16) * 4
    else if (m > s + 16 && m <= slabTo) y = CEILING_Y - RIDE_HEIGHT
    else if (m > slabTo && m <= dropTo) y = CEILING_Y - RIDE_HEIGHT + ((m - slabTo) / 20) * (CEILING_EXIT_Y - CEILING_Y)
    const inverted = y > 6
    // One checkpoint halfway along the slab: what proves the run was driven upside down.
    const cpHere = !marked && m > slabFrom + TUNNEL_SLAB / 2
    if (cpHere) marked = true
    return { y, flags: { inverted, cpHere, noCp: m >= s - 10 && m <= dropTo + 15 } }
  }
}

/** The barrel-roll ramp: three pitches up to 22 degrees and 80 m of flat road to land on. */
function buildBigRamp(b: Build, at: (metres: number) => P2, length: number, h: number): Profile {
  const s = Math.max(FEATURE_MARGIN, (length - BIGRAMP_RUN - BIGRAMP_LANDING) / 2)
  // Where the ramp's surface is, pitch by pitch, as [metres, height above the road].
  const profile: [number, number][] = [[s, 0]]
  for (const [run, degrees] of BIGRAMP) {
    const [m, y] = profile[profile.length - 1]
    profile.push([m + run, y + run * Math.tan((degrees * Math.PI) / 180)])
  }
  for (let i = 1; i < profile.length; i++) {
    const a = at(profile[i - 1][0])
    const c = at(profile[i][0])
    b.surfaces.push(
      strip('ramp', { x: a.x, y: ROAD_Y + h + profile[i - 1][1], z: a.z }, { x: c.x, y: ROAD_Y + h + profile[i][1], z: c.z })
    )
  }
  return (m) => {
    let lift = 0
    for (let i = 1; i < profile.length; i++) {
      const [m0, y0] = profile[i - 1]
      const [m1, y1] = profile[i]
      if (m > m0 && m <= m1) lift = y0 + ((m - m0) / (m1 - m0)) * (y1 - y0)
    }
    return {
      y: ROAD_Y + RIDE_HEIGHT + lift,
      flags: { noCp: m >= s - 10 && m <= s + BIGRAMP_RUN + BIGRAMP_LANDING + 10 }
    }
  }
}

/**
 * The corkscrew (see the constants for the shape and why it is built this way): the road
 * runs on the line up to the loop, comes out of it `CORK_OFFSET` to the right, runs on
 * there until it is clear of the loop's footprint, and an S brings it back onto the line.
 */
function buildCorkscrew(b: Build, from: P2, dir: P2, length: number, h: number, distance: number): number {
  const R = CORK_R
  const offset = CORK_OFFSET
  const side: P2 = { x: dir.z, z: -dir.x }
  const at = (metres: number, across = 0): P2 => add(add(from, scale(dir, metres)), scale(side, across))
  const yaw = yawOf(dir)
  const base = ROAD_Y + h
  const loopAt = CORK_BEFORE + R
  const besideTo = loopAt + R + 4
  const backAt = besideTo + CORK_RETURN

  // Road on the line before the loop, beside it after, and on the line again past the S.
  roadRun(b, (m) => at(m), 0, loopAt, h)
  roadRun(b, (m) => at(m, offset), loopAt, besideTo, h)
  roadRun(b, (m) => at(m), backAt, length, h)
  b.voids.push({ centre: at(loopAt, offset / 2), yaw, halfLength: R + 6, halfWidth: offset / 2 + CORNER_W / 2 + 6 })
  if (h >= VOID_ABOVE) {
    b.voids.push({ centre: at(length / 2), yaw, halfLength: length / 2 + VOID_MARGIN, halfWidth: ROAD_W / 2 + VOID_MARGIN })
  }

  // The racing line, measured along the path the car actually takes.
  let walked = distance
  let last: Vec3 = { x: from.x, y: base + RIDE_HEIGHT, z: from.z }
  const put = (pos: Vec3, heading: P2, flags: SampleFlags): void => {
    walked += Math.hypot(pos.x - last.x, pos.y - last.y, pos.z - last.z)
    last = pos
    b.sample(pos, heading, walked, { ...flags, floor: h })
  }
  const lineAlong = (m0: number, m1: number, across: (m: number) => number, flags: (m: number) => SampleFlags): void => {
    const steps = Math.max(1, Math.round((m1 - m0) / ARC_PIECE))
    for (let i = 1; i <= steps; i++) {
      const m = m0 + ((m1 - m0) * i) / steps
      const p = at(m, across(m))
      put({ x: p.x, y: base + RIDE_HEIGHT, z: p.z }, dir, flags(m))
    }
  }
  // Bots arrive flat out: the loop is driven on the throttle, never braked for.
  lineAlong(0, loopAt, () => 0, (m) => ({ hint: m >= loopAt - 60 ? 'boost' : undefined, noCp: m >= loopAt - 30 }))

  // The loop, in the straight's own frame: forward along the line, up, and across to the right.
  const F: Vec3 = { x: dir.x, y: 0, z: dir.z }
  const U: Vec3 = { x: 0, y: 1, z: 0 }
  const S: Vec3 = { x: side.x, y: 0, z: side.z }
  const origin = at(loopAt)
  const O: Vec3 = { x: origin.x, y: base, z: origin.z }
  const k = offset / (2 * Math.PI)
  const point = (t: number): Vec3 =>
    vadd(O, vadd(vscale(F, R * Math.sin(t)), vadd(vscale(U, R * (1 - Math.cos(t))), vscale(S, k * (t - Math.sin(t))))))
  const velocity = (t: number): Vec3 =>
    vadd(vscale(F, R * Math.cos(t)), vadd(vscale(U, R * Math.sin(t)), vscale(S, k * (1 - Math.cos(t)))))
  const acceleration = (t: number): Vec3 =>
    vadd(vscale(F, -R * Math.sin(t)), vadd(vscale(U, R * Math.cos(t)), vscale(S, k * Math.sin(t))))
  /** Principal normal: the part of the curve's acceleration across its tangent. */
  const normalAt = (t: number, tangent: Vec3): Vec3 => {
    const acc = acceleration(t)
    return norm(vsub(acc, vscale(tangent, vdot(acc, tangent))))
  }

  let loopLength = 0
  for (let i = 0; i < 360; i++) loopLength += Math.hypot(...xyz(vsub(point(((i + 1) * Math.PI) / 180), point((i * Math.PI) / 180))))
  const chords = Math.ceil(loopLength / CORK_CHORD)
  for (let c = 0; c < chords; c++) {
    const t0 = (2 * Math.PI * c) / chords
    const t1 = (2 * Math.PI * (c + 1)) / chords
    const a = point(t0)
    const e = point(t1)
    const forward = norm(vsub(e, a))
    // The Frenet normal at the chord's middle, squared up against the chord itself.
    const n = normalAt((t0 + t1) / 2, norm(velocity((t0 + t1) / 2)))
    const up = norm(vsub(n, vscale(forward, vdot(n, forward))))
    const right = cross(up, forward)
    const mid = vscale(vadd(a, e), 0.5)
    b.surfaces.push({
      kind: 'road',
      pos: vsub(mid, vscale(up, ROAD_T / 2)),
      size: { x: CORNER_W, y: ROAD_T, z: Math.hypot(...xyz(vsub(e, a))) + 2 * CORK_OVERLAP },
      rot: eulerFromBasis(right, up, forward),
      friction: DEFAULT_FRICTION
    })
    // Where the loop runs low, it must stay clear of the road it starts from and the one it
    // ends on: the descending half is over the entry road's line, the climbing half beside
    // the exit road.
    const rel = vsub(mid, O)
    const along = vdot(rel, F)
    const across = vdot(rel, S)
    const clearance = along < 0 ? across : offset - across
    if (vdot(rel, U) < 6 && clearance < CORNER_W / 2 + ROAD_W / 2 + 2) {
      throw new Error(`corkscrew: the loop passes ${clearance.toFixed(1)} m from its own road`)
    }
    const tangent = norm(velocity(t1))
    const heading = Math.hypot(tangent.x, tangent.z) > 0.05 ? unit({ x: tangent.x, z: tangent.z }) : dir
    put(vadd(e, vscale(normalAt(t1, tangent), RIDE_HEIGHT)), heading, { hint: 'boost', noCp: true })
  }

  lineAlong(loopAt, besideTo, () => offset, () => ({ noCp: true }))

  // The S back onto the line: flat chords, overlapped like a corner's.
  const acrossAt = (m: number): number => offset * (1 - smoothstep((m - besideTo) / CORK_RETURN))
  const steps = Math.max(2, Math.round(CORK_RETURN / ARC_PIECE))
  for (let i = 0; i < steps; i++) {
    const m0 = besideTo + (CORK_RETURN * i) / steps
    const m1 = besideTo + (CORK_RETURN * (i + 1)) / steps
    const a = at(m0, acrossAt(m0))
    const e = at(m1, acrossAt(m1))
    const rot: Euler = [0, yawOf(sub(e, a)), 0]
    b.surfaces.push({
      kind: 'road',
      pos: offsetFromSurface({ x: (a.x + e.x) / 2, y: base, z: (a.z + e.z) / 2 }, rot, ROAD_T, false),
      size: { x: CORNER_W, y: ROAD_T, z: len(sub(e, a)) * 1.06 },
      rot,
      friction: DEFAULT_FRICTION
    })
    put({ x: e.x, y: base + RIDE_HEIGHT, z: e.z }, unit(sub(e, a)), { noCp: true })
  }

  lineAlong(backAt, length, () => 0, (m) => ({ noCp: m <= backAt + 15 }))
  return walked
}

const xyz = (v: Vec3): [number, number, number] => [v.x, v.y, v.z]

/**
 * The parcel floor, with holes wherever `voids` asks for them. The floor is a grid of
 * tiles, each row merged into runs and identical rows into one box, so a circuit with no
 * holes keeps the single box it always had.
 */
function buildGround(voids: Void[]): Surface[] {
  const floor = (x0: number, x1: number, z0: number, z1: number): Surface => ({
    kind: 'ground',
    pos: { x: (x0 + x1) / 2, y: -0.5, z: (z0 + z1) / 2 },
    size: { x: x1 - x0, y: 1, z: z1 - z0 },
    rot: [0, 0, 0],
    friction: 0.8
  })
  if (voids.length === 0) return [floor(0, EXTENT, 0, EXTENT)]
  const open = (x: number, z: number): boolean =>
    voids.some((v) => {
      const r = (v.yaw * Math.PI) / 180
      const dx = x - v.centre.x
      const dz = z - v.centre.z
      return (
        Math.abs(dx * Math.sin(r) + dz * Math.cos(r)) <= v.halfLength &&
        Math.abs(dx * Math.cos(r) - dz * Math.sin(r)) <= v.halfWidth
      )
    })
  const rows: { z0: number; z1: number; runs: [number, number][] }[] = []
  for (let z0 = 0; z0 < EXTENT; z0 += GROUND_TILE) {
    const runs: [number, number][] = []
    let start = -1
    for (let x0 = 0; x0 <= EXTENT; x0 += GROUND_TILE) {
      const solid = x0 < EXTENT && !open(x0 + GROUND_TILE / 2, z0 + GROUND_TILE / 2)
      if (solid && start < 0) start = x0
      if (!solid && start >= 0) {
        runs.push([start, x0])
        start = -1
      }
    }
    const previous = rows[rows.length - 1]
    if (previous && JSON.stringify(previous.runs) === JSON.stringify(runs)) previous.z1 = z0 + GROUND_TILE
    else rows.push({ z0, z1: z0 + GROUND_TILE, runs })
  }
  return rows.flatMap((row) => row.runs.map(([x0, x1]) => floor(x0, x1, row.z0, row.z1)))
}

/** How far before its apex a corner starts, which is what has to fit on the straight. */
function tangentOf(a: Arc): number {
  return a.radius * Math.tan(Math.abs(a.sweep) / 2)
}

/** Two rows of four on the main straight, behind the line, all facing the way it runs. */
function buildGrid(from: P2, to: P2, h: number): Spawn[] {
  const dir = unit(sub(to, from))
  const side: P2 = { x: dir.z, z: -dir.x }
  const yaw = yawOf(dir)
  const length = len(sub(to, from))
  const spawns: Spawn[] = []
  for (const back of [0.58, 0.5]) {
    const base = add(from, scale(dir, length * back))
    for (const offset of [-4.8, -1.6, 1.6, 4.8]) {
      const p = add(base, scale(side, offset))
      spawns.push({ pos: { x: p.x, y: RIDE_HEIGHT + h, z: p.z }, yaw })
    }
  }
  return spawns
}

/**
 * Fills everything the circuit does not use with buildings, on a jittered grid.
 *
 * The randomness is a seeded generator, never `Math.random`: the server and the scene each
 * run this code on their own machine and have to agree on the result down to the metre, or
 * the car would be driving through a wall the server can see and the player cannot.
 */
function scatterBuildings(path: Sample[]): Surface[] {
  const out: Surface[] = []
  const step = 46
  // xorshift: cheap, deterministic, and good enough to look unplanned.
  let seed = 0x9e3779b9
  const rand = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) % 10000) / 10000
  }

  for (let x = step * 0.6; x < EXTENT; x += step) {
    for (let z = step * 0.6; z < EXTENT; z += step) {
      const cx = x + (rand() - 0.5) * 14
      const cz = z + (rand() - 0.5) * 14
      // The plot is still drawn at random, then the block is the biggest catalogue piece
      // that fits on it, so the collider is exactly the GLB the scene puts there.
      const w = fromCatalogue(BUILDING_CATALOG.footprints, Math.min(20 + rand() * 16, 20 + rand() * 16))
      const d = w
      const h = fromCatalogue(BUILDING_CATALOG.heights, 9 + rand() * 30)
      if (cx - w / 2 < 2 || cx + w / 2 > EXTENT - 2) continue
      if (cz - d / 2 < 2 || cz + d / 2 > EXTENT - 2) continue
      // Keep a car's width of air between the building and the widest part of the road.
      const clearance = Math.hypot(w, d) / 2 + CORNER_W / 2 + 7
      let clear = true
      for (const p of path) {
        if (Math.hypot(p.pos.x - cx, p.pos.z - cz) < clearance) {
          clear = false
          break
        }
      }
      if (clear) out.push(building(cx, cz, w, d, h))
    }
  }
  return out
}

/** The largest size in `sizes` (ascending) not above `room`; the smallest if none is. */
function fromCatalogue(sizes: readonly number[], room: number): number {
  let best = sizes[0]
  for (const size of sizes) if (size <= room) best = size
  return best
}

/** The checkpoints in lap order. Callers that run every tick keep the result. */
export function checkpointsOf(track: Track): Trigger[] {
  return track.triggers
    .filter((t) => t.kind === 'checkpoint')
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
}

/**
 * Where a car is put back after falling off or flipping: just before the checkpoint it is
 * heading for, on the road. On the road and not on the racing line: a checkpoint inside an
 * inverted run would otherwise drop the car back in upside down nine metres up, which only
 * ends one way, and under every slab there is road.
 */
export function respawnFor(track: Track, checkpointIndex: number): Spawn {
  const checkpoints = checkpointsOf(track)
  const n = checkpoints.length
  const cp = checkpoints[((checkpointIndex % n) + n) % n]
  const yaw = cp.rot[1]
  const rad = (yaw * Math.PI) / 180
  // Back up 10 m along the direction the checkpoint faces.
  const x = cp.pos.x - Math.sin(rad) * 10
  const z = cp.pos.z - Math.cos(rad) * 10
  return { pos: { x, y: spawnHeightAt(track, x, z), z }, yaw }
}

/**
 * The height to put a car down at (x, z): on top of the highest road there, at the height
 * the grid uses. Ceiling slabs are not road, so under the tunnel this finds the road beneath
 * it; where there is no road it is the parcel floor.
 */
export function spawnHeightAt(track: Track, x: number, z: number): number {
  let top = -Infinity
  for (const s of track.surfaces) {
    if (s.kind !== 'road') continue
    const q = quatFromEulerDegrees(s.rot[0], s.rot[1], s.rot[2])
    const up = quatRotate(q, { x: 0, y: 1, z: 0 })
    // The sides and the roof of the corkscrew are road too, but nowhere to put a car.
    if (up.y < 0.5) continue
    const face = vadd(s.pos, vscale(up, s.size.y / 2))
    const y = face.y - (up.x * (x - face.x) + up.z * (z - face.z)) / up.y
    const local = quatRotate(quatConjugate(q), { x: x - face.x, y: y - face.y, z: z - face.z })
    if (Math.abs(local.x) <= s.size.x / 2 && Math.abs(local.z) <= s.size.z / 2) top = Math.max(top, y)
  }
  return (top === -Infinity ? ROAD_Y : top) - ROAD_Y + RIDE_HEIGHT
}

/**
 * Half-width of the drivable surface, plus a car's half-width of grace.
 *
 * Straights are `ROAD_W` and corners `CORNER_W`; using the wider of the two everywhere
 * means a car hugging the inside of a corner is never called off-track, at the cost of a
 * couple of metres of tolerance on the straights. That trade is the right way round: being
 * told you are on gravel when you are on asphalt is infuriating, the reverse is barely
 * noticed.
 */
export const DRIVABLE_HALF_WIDTH = CORNER_W / 2 + 1.5

/** Squared XZ distance from `p` to the segment `a`-`b`. */
function segmentDistanceSq(p: Vec3, a: Vec3, b: Vec3): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const lengthSq = dx * dx + dz * dz
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq)) : 0
  const cx = a.x + dx * t - p.x
  const cz = a.z + dz * t - p.z
  return cx * cx + cz * cz
}

/**
 * How far a car is from the racing line, in the XZ plane, and the line index it was
 * measured against.
 *
 * `hint` is the index the caller got last tick: a car moves a few metres per tick, so the
 * answer is almost always within a point or two of where it was, and the window search
 * costs a dozen comparisons instead of a scan of the whole line. The full scan is still
 * there for the cases where the hint is meaningless — a respawn, a fresh join, a car
 * launched clean across the infield.
 *
 * Distance is measured to the *segments* either side of the nearest point rather than to
 * the point itself: the line is sampled every few metres, and a car sitting between two
 * samples is up to half that spacing further from the nearest point than from the line.
 */
export function lineOffset(track: Track, pos: Vec3, hint: number): { distance: number; index: number } {
  const path = track.centreline
  const n = path.length
  const window = 12
  let best = -1
  let bestSq = Infinity
  const consider = (i: number): void => {
    const index = ((i % n) + n) % n
    const dx = path[index].pos.x - pos.x
    const dz = path[index].pos.z - pos.z
    const d = dx * dx + dz * dz
    if (d < bestSq) {
      bestSq = d
      best = index
    }
  }
  for (let i = hint - window; i <= hint + window; i++) consider(i)
  // Anything outside the asphalt gets the full scan. A stale hint reads as a large
  // distance exactly like genuinely running wide does, and the two must not be confused:
  // being wrongly told you are on gravel because the hint was old is the one failure this
  // function must not have. Off-track is rare, so the scan is rare too.
  if (bestSq > DRIVABLE_HALF_WIDTH * DRIVABLE_HALF_WIDTH) {
    bestSq = Infinity
    for (let i = 0; i < n; i++) consider(i)
  }
  const previous = path[(best - 1 + n) % n].pos
  const next = path[(best + 1) % n].pos
  const distanceSq = Math.min(
    segmentDistanceSq(pos, previous, path[best].pos),
    segmentDistanceSq(pos, path[best].pos, next)
  )
  return { distance: Math.sqrt(distanceSq), index: best }
}
