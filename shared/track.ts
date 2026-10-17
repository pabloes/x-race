/**
 * The track, authored once and consumed by both sides:
 *  - the server turns every `Surface` / `Obstacle` into a Rapier collider
 *  - the scene turns the same list into boxes with MeshRenderer + MeshCollider
 *
 * Scene-local coordinates of a 32 x 32 parcel scene (512 x 512 m), Y up, road surfaces at
 * y = 0.1 so they do not z-fight with the parcel floor.
 *
 * ## How the layout is authored
 *
 * Not as hand-placed straights and corners — that only works for a rectangle. The lap is a
 * closed polygon of corner vertices (`SHAPE`), and each vertex is rounded off with a
 * tangent arc of its own radius, the way a real circuit is drawn. Two things fall out for
 * free: the loop always closes, because the polygon does, and every straight is exactly the
 * gap left between two arcs. Move a vertex and the whole circuit re-flows around it.
 *
 * `fillet()` fails loudly if a corner's radius is too big for the straights feeding it,
 * which is the one way this kind of layout goes wrong silently.
 *
 * ## The circuit
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

import { CAR } from './constants'
import { quatFromEulerDegrees, quatRotate, type Vec3 } from './math'

/** Euler angles in degrees, same convention as Decentraland's Quaternion.fromEulerDegrees. */
export type Euler = [number, number, number]

export type SurfaceKind = 'ground' | 'road' | 'ramp' | 'ceiling' | 'wall' | 'startline' | 'building'

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

export type Track = {
  id: string
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
  centreline: Vec3[]
}

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
 * The lap, as corner apexes in driving order. `r` is the radius the apex is rounded to:
 * big numbers are flat-out sweeps, small ones are the slow corners you brake for.
 *
 * Sector 1 is the main straight and the fast run up the east side, sector 2 the infield,
 * sector 3 the long left that feeds the straight again.
 */
const SHAPE: { x: number; z: number; r: number; name: string }[] = [
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
]

/**
 * Features are assigned by how long a straight turns out to be, not by index: the longest
 * straight is the main straight and gets the line and the grid, the next one is long enough
 * for the flip, the one after that takes the jump. Move a corner and they follow.
 */
type Feature = 'start' | 'start-jump' | 'jump' | 'ceiling'
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

/** Clear space kept between the circuit and the parcel edge. */
const MARGIN = 54

/**
 * SHAPE and the building lists are authored in their own space; this scales that design
 * uniformly into the scene and centres it, so the only number that decides how big the
 * circuit is is EXTENT. Uniform, because a non-uniform fit would turn the round corners
 * into ovals the arcs cannot follow.
 */
let fitCache: { scale: number; dx: number; dz: number } | null = null

function fit(): { scale: number; dx: number; dz: number } {
  if (fitCache) return fitCache
  const xs = SHAPE.map((v) => v.x)
  const zs = SHAPE.map((v) => v.z)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minZ = Math.min(...zs)
  const maxZ = Math.max(...zs)
  const scale = (EXTENT - 2 * MARGIN) / Math.max(maxX - minX, maxZ - minZ)
  fitCache = {
    scale,
    dx: EXTENT / 2 - ((minX + maxX) / 2) * scale,
    dz: EXTENT / 2 - ((minZ + maxZ) / 2) * scale
  }
  return fitCache
}

const fitScale = (): number => fit().scale
const toScene = (p: { x: number; z: number }): P2 => ({
  x: p.x * fit().scale + fit().dx,
  z: p.z * fit().scale + fit().dz
})

function fitted(): { x: number; z: number; r: number; name: string }[] {
  return SHAPE.map((v) => ({ ...toScene(v), r: v.r * fit().scale, name: v.name }))
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

type PathPoint = { pos: Vec3; dir: P2; distance: number }

function buildTrack(): Track {
  const surfaces: Surface[] = []
  const obstacles: Obstacle[] = []
  const triggers: Trigger[] = []

  // Parcel-wide floor. The explorer already draws the parcel ground, so the client skips
  // rendering this one; it exists so cars that fall off have somewhere to land.
  surfaces.push({
    kind: 'ground',
    pos: { x: EXTENT / 2, y: -0.5, z: EXTENT / 2 },
    size: { x: EXTENT, y: 1, z: EXTENT },
    rot: [0, 0, 0],
    friction: 0.8
  })

  // Perimeter walls, so a car that runs wide stays inside the parcels.
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
  const shape = fitted()
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
    throw new Error(`track: corners do not fit:\n  ${tooTight.join('\n  ')}`)
  }

  // 2. Rank the straights: longest is the main straight, then the flip, then the jump.
  const straights = arcs.map((a, i) => ({
    index: i,
    from: a.exit,
    to: arcs[(i + 1) % n].entry,
    length: len(sub(arcs[(i + 1) % n].entry, a.exit))
  }))
  const byLength = [...straights].sort((a, b) => b.length - a.length)
  const feature = new Map<number, Feature>()
  // The main straight carries the line, the grid and — if it is long enough — the launch
  // ramp, which sits well before the grid so a standing start never has to climb it.
  feature.set(byLength[0].index, byLength[0].length > 200 ? 'start-jump' : 'start')
  // The flip goes on the next longest straight that can actually hold it.
  const flip = byLength.slice(1).find((s) => s.length > CEILING_SPAN + 12)
  if (flip) feature.set(flip.index, 'ceiling')
  // Boost pads go on the next longest straights, where they are worth taking.
  const boostOn = new Set(byLength.slice(3, 6).map((s) => s.index))

  // 3. Walk the lap, emitting geometry and sampling the racing line as we go.
  const path: PathPoint[] = []
  let distance = 0
  const sample = (pos: Vec3, dir: P2, at: number) => {
    path.push({ pos, dir, distance: at })
  }

  for (let i = 0; i < n; i++) {
    const a = arcs[i]

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
        pos: offsetFromSurface({ x: mid.x, y: ROAD_Y, z: mid.z }, rot, ROAD_T, false),
        size: { x: CORNER_W, y: ROAD_T, z: chord },
        rot,
        friction: DEFAULT_FRICTION
      })
      const point = arcPoint(a, (s + 1) / steps)
      distance += arcLength / steps
      sample(
        { x: point.x, y: ROAD_Y + RIDE_HEIGHT, z: point.z },
        arcTangent(a, (s + 1) / steps),
        distance
      )
    }

    // Then the straight from this corner's exit to the next corner's entry.
    const b = arcs[(i + 1) % n]
    distance = buildStraight(
      a.exit,
      b.entry,
      feature.get(i),
      boostOn.has(i),
      surfaces,
      obstacles,
      triggers,
      sample,
      distance
    )
  }

  // 4. Checkpoints, evenly spaced round the lap, plus one inside the ceiling run so the
  //    inverted section cannot be skipped by staying on the road underneath it.
  const lapLength = distance
  const pointAt = (d: number): PathPoint => {
    const wrapped = ((d % lapLength) + lapLength) % lapLength
    let best = path[0]
    for (const p of path) {
      if (p.distance <= wrapped) best = p
      else break
    }
    return best
  }

  const ceilingPoint = path.find((p) => p.pos.y > 6)
  const stops = [...Array(CHECKPOINT_COUNT).keys()].map((i) => (i * lapLength) / CHECKPOINT_COUNT)
  if (ceilingPoint) {
    // Replace whichever evenly spaced stop is nearest, rather than adding one, so the
    // spacing stays even and the count stays fixed.
    let nearest = 0
    for (let i = 1; i < stops.length; i++) {
      if (Math.abs(stops[i] - ceilingPoint.distance) < Math.abs(stops[nearest] - ceilingPoint.distance)) {
        nearest = i
      }
    }
    stops[nearest] = ceilingPoint.distance
  }

  stops.forEach((d, index) => {
    const p = pointAt(d)
    const onCeiling = p.pos.y > 6
    triggers.push({
      id: `cp${index}`,
      kind: 'checkpoint',
      index,
      pos: { x: p.pos.x, y: onCeiling ? p.pos.y : 4.5, z: p.pos.z },
      size: { x: ROAD_W + 7, y: onCeiling ? 3.5 : 9, z: 3 },
      rot: [0, yawOf(p.dir), 0]
    })
  })

  // 5. The grid, on the main straight behind the line.
  const main = byLength[0]
  const spawns = buildGrid(main.from, main.to)

  // 6. Grandstands, paddock and city blocks, grown on a grid over everything the circuit
  //    does not use. They are what stops a car driving across the infield from one
  //    checkpoint to the next, and they give the cockpit a horizon. Generated rather than
  //    hand-placed: a hand-placed list silently ends up on the racing line the first time
  //    a corner moves.
  surfaces.push(...scatterBuildings(path))

  const track: Track = {
    id: 'elon-roadster-race-circuit',
    extent: EXTENT,
    lapLength,
    surfaces,
    obstacles,
    triggers,
    spawns,
    checkpointCount: CHECKPOINT_COUNT,
    centreline: path.map((p) => p.pos)
  }
  return { ...track, id: `${track.id}-${fingerprint(track)}` }
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
  for (const t of track.triggers) {
    mix(t.pos.x)
    mix(t.pos.z)
    mix(t.size.x)
  }
  mix(track.lapLength)
  return (hash >>> 0).toString(36)
}

/**
 * Emits one straight and whatever happens on it, sampling the racing line as it goes.
 * Returns the running lap distance.
 */
function buildStraight(
  from: P2,
  to: P2,
  feature: Feature | undefined,
  boost: boolean,
  surfaces: Surface[],
  obstacles: Obstacle[],
  triggers: Trigger[],
  sample: (pos: Vec3, dir: P2, at: number) => void,
  distance: number
): number {
  const d = sub(to, from)
  const length = len(d)
  const dir = unit(d)
  const at = (metres: number): P2 => add(from, scale(dir, metres))
  const yaw = yawOf(dir)

  // The road itself, in cullable pieces.
  const pieces = Math.max(1, Math.round(length / STRAIGHT_PIECE))
  for (let p = 0; p < pieces; p++) {
    const a = at((length * p) / pieces)
    const b = at((length * (p + 1)) / pieces)
    surfaces.push(
      strip('road', { x: a.x, y: ROAD_Y, z: a.z }, { x: b.x, y: ROAD_Y, z: b.z }, ROAD_W)
    )
  }

  if (boost) {
    const at = add(from, scale(dir, length * 0.35))
    triggers.push({
      id: `boost-${Math.round(at.x)}-${Math.round(at.z)}`,
      kind: 'boost',
      pos: { x: at.x, y: ROAD_Y + 1.2, z: at.z },
      size: { x: ROAD_W, y: 2.4, z: 5 },
      rot: [0, yaw, 0]
    })
  }

  if (feature === 'start' || feature === 'start-jump') {
    // Line three quarters of the way down, so the grid behind it still sits on the straight.
    const line = at(length * 0.72)
    surfaces.push({
      kind: 'startline',
      pos: { x: line.x, y: ROAD_Y + 0.02, z: line.z },
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
    surfaces.push(strip('ramp', { x: up.x, y: ROAD_Y, z: up.z }, { x: crest.x, y: RAMP_RISE, z: crest.z }))
    for (const m of [s + RAMP_RUN + 10, s + RAMP_RUN + 20]) {
      const p = at(m)
      obstacles.push({
        kind: 'pillar',
        pos: { x: p.x, y: ROAD_Y + 0.9, z: p.z },
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
      strip('ramp', { x: kickFrom.x, y: ROAD_Y, z: kickFrom.z }, { x: kickTo.x, y: 5, z: kickTo.z })
    )
    surfaces.push(
      strip(
        'ceiling',
        { x: slabFrom.x, y: CEILING_Y, z: slabFrom.z },
        { x: slabTo.x, y: CEILING_Y, z: slabTo.z },
        ROAD_W,
        true
      )
    )
    surfaces.push(
      strip(
        'ceiling',
        { x: slabTo.x, y: CEILING_Y, z: slabTo.z },
        { x: dropTo.x, y: CEILING_EXIT_Y, z: dropTo.z },
        ROAD_W,
        true
      )
    )
    const zoneFrom = at(s + 16)
    const zoneTo = at(s + 70)
    triggers.push({
      id: 'invert-zone',
      kind: 'invert',
      pos: { x: (zoneFrom.x + zoneTo.x) / 2, y: 9, z: (zoneFrom.z + zoneTo.z) / 2 },
      size: { x: ROAD_W + 2, y: 10, z: len(sub(zoneTo, zoneFrom)) },
      rot: [0, yaw, 0]
    })
  }

  // Sample the racing line along the straight, lifting it onto the ceiling where there is
  // one: the bots and the harness drive these points, so they have to follow the flip.
  const steps = Math.max(2, Math.round(length / ARC_PIECE))
  for (let i = 1; i <= steps; i++) {
    const m = (length * i) / steps
    const p = at(m)
    let y = ROAD_Y + RIDE_HEIGHT
    if (feature === 'ceiling') {
      const s = length * 0.18
      if (m > s && m <= s + 16) y = ROAD_Y + RIDE_HEIGHT + ((m - s) / 16) * 4
      else if (m > s + 16 && m <= s + 50) y = CEILING_Y - RIDE_HEIGHT
      else if (m > s + 50 && m <= s + 70) {
        const t = (m - (s + 50)) / 20
        y = CEILING_Y - RIDE_HEIGHT + t * (CEILING_EXIT_Y - CEILING_Y)
      }
    }
    sample({ x: p.x, y, z: p.z }, dir, distance + m)
  }
  return distance + length
}

/** How far before its apex a corner starts, which is what has to fit on the straight. */
function tangentOf(a: Arc): number {
  return a.radius * Math.tan(Math.abs(a.sweep) / 2)
}

/** Two rows of four on the main straight, behind the line, all facing the way it runs. */
function buildGrid(from: P2, to: P2): Spawn[] {
  const dir = unit(sub(to, from))
  const side: P2 = { x: dir.z, z: -dir.x }
  const yaw = yawOf(dir)
  const length = len(sub(to, from))
  const spawns: Spawn[] = []
  for (const back of [0.58, 0.5]) {
    const base = add(from, scale(dir, length * back))
    for (const offset of [-4.8, -1.6, 1.6, 4.8]) {
      const p = add(base, scale(side, offset))
      spawns.push({ pos: { x: p.x, y: RIDE_HEIGHT, z: p.z }, yaw })
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
function scatterBuildings(path: PathPoint[]): Surface[] {
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
      const w = 20 + rand() * 16
      const d = 20 + rand() * 16
      const h = 9 + rand() * 30
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

export const TRACK: Track = buildTrack()

export const CHECKPOINTS: Trigger[] = TRACK.triggers
  .filter((t) => t.kind === 'checkpoint')
  .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

/**
 * Where a car is put back after falling off or flipping: just before the checkpoint it is
 * heading for, on the ground. A checkpoint inside the ceiling run would otherwise drop the
 * car back in upside down nine metres up, which only ends one way.
 */
const RESPAWNS: Spawn[] = CHECKPOINTS.map((cp) => {
  const yaw = cp.rot[1]
  const rad = (yaw * Math.PI) / 180
  // Back up 10 m along the direction the checkpoint faces.
  return {
    pos: { x: cp.pos.x - Math.sin(rad) * 10, y: RIDE_HEIGHT, z: cp.pos.z - Math.cos(rad) * 10 },
    yaw
  }
})

export function respawnFor(checkpointIndex: number): Spawn {
  const n = RESPAWNS.length
  return RESPAWNS[((checkpointIndex % n) + n) % n]
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
export function lineOffset(pos: Vec3, hint: number): { distance: number; index: number } {
  const path = TRACK.centreline
  const n = path.length
  const window = 12
  let best = -1
  let bestSq = Infinity
  const consider = (i: number): void => {
    const index = ((i % n) + n) % n
    const dx = path[index].x - pos.x
    const dz = path[index].z - pos.z
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
  const previous = path[(best - 1 + n) % n]
  const next = path[(best + 1) % n]
  const distanceSq = Math.min(
    segmentDistanceSq(pos, previous, path[best]),
    segmentDistanceSq(pos, path[best], next)
  )
  return { distance: Math.sqrt(distanceSq), index: best }
}
