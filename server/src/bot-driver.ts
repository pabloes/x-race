/**
 * The AI that drives the bots the lobby menu adds to a race.
 *
 * It follows the track centreline, transforming the target into the chassis frame before
 * steering so the same controller works on the ground and upside down on the ceiling —
 * no special cases for orientation. Speed comes from the radius of the line ahead and how
 * much road is left to brake in, so it arrives at a corner already slowed down.
 *
 * Bots run inside the room, on the same fixed tick as everything else, so they are
 * subject to exactly the same physics and rules as a human driver.
 */

import { CAR, CHARGE, TICK_MS } from '../../shared/constants'
import { clamp, quatConjugate, quatRotate, vdot, type Vec3 } from '../../shared/math'
import { InputBit } from '../../shared/protocol'
import type { PathPoint } from '../../shared/tracks'
import type { CarSim } from './car-sim'

/** Lateral acceleration a bot is willing to ask of the tyres, and what it can shed braking. */
const CORNERING = 9.5
const BRAKING = 9
/** How long the bot gives itself to be pointing at the next waypoint. */
const AIM_SECONDS = 0.55
/** Waypoints (about 6 m each) the bot looks ahead for a gap, to keep the charge for it. */
const THRUST_LOOKAHEAD = 25
/**
 * A bot this far below the point it is aiming at, for this long, is under the circuit:
 * off a rooftop, or under a slab it did not flip onto. Nothing down there leads back up, so
 * it does what a player would do and asks for a respawn. Never true on the way through a
 * set piece: the steepest the line climbs between two waypoints is the corkscrew's 3.5 m,
 * and the tunnel kicker leaves the slab overhead for well under a second.
 */
const STRANDED_BELOW = 6
const STRANDED_MS = 1500

/**
 * Radius of the racing line at every point, measured in the XZ plane only: the circle
 * through a point and its neighbours. The vertical kinks of the ceiling run are not
 * corners and must not be braked for, which is why Y is left out.
 *
 * Precomputed per line because it never changes while the bot drives it, and because a
 * bot would otherwise do this fourteen times a tick.
 */
function radiiOf(path: Vec3[], hints: PathPoint['hint'][]): number[] {
  return path.map((_, i) => {
    // A boost hint means flat out, whatever the line does: the corkscrew's projection on the
    // ground is a hairpin, and braking for it is the one way to fall off the top.
    if (hints[i] === 'boost') return 1e4
    const a = path[(i - 1 + path.length) % path.length]
    const b = path[i]
    const c = path[(i + 1) % path.length]
    const ab = Math.hypot(b.x - a.x, b.z - a.z)
    const bc = Math.hypot(c.x - b.x, c.z - b.z)
    const ca = Math.hypot(a.x - c.x, a.z - c.z)
    const area = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2
    // Three points in a line have no circle through them: that is a straight.
    return area < 0.05 ? 1e4 : (ab * bc * ca) / (4 * area)
  })
}

export type BotSkill = {
  /** Scales the target speed: 1 is as fast as the line allows. */
  pace: number
  /** Extra steering slop, so bots are not all identical. */
  slop: number
}

/** A spread of skills, so a grid of bots does not drive as one block. */
export const BOT_SKILLS: BotSkill[] = [
  { pace: 1.0, slop: 0.02 },
  { pace: 0.94, slop: 0.04 },
  { pace: 0.88, slop: 0.05 },
  { pace: 0.97, slop: 0.03 },
  { pace: 0.85, slop: 0.06 },
  { pace: 0.91, slop: 0.04 },
  { pace: 0.99, slop: 0.02 }
]

export class BotDriver {
  private waypoint = 0
  private path: Vec3[] = []
  private hints: PathPoint['hint'][] = []
  private radii: number[] = []
  private strandedMs = 0

  constructor(
    private readonly skill: BotSkill,
    centreline: PathPoint[]
  ) {
    this.follow(centreline)
  }

  /** The racing line to drive, replaced when the room changes circuit. */
  follow(centreline: PathPoint[]): void {
    this.path = centreline.map((p) => p.pos)
    this.hints = centreline.map((p) => p.hint)
    this.radii = radiiOf(this.path, this.hints)
    this.waypoint = 0
    this.strandedMs = 0
  }

  /** Called once per tick before the car is simulated. */
  think(car: CarSim): number {
    const v = car.vehicle
    const pos = v.position()
    const inverseRot = quatConjugate(v.rotation())
    const toLocal = (i: number): Vec3 => {
      const t = this.path[i % this.path.length]
      return quatRotate(inverseRot, { x: t.x - pos.x, y: t.y - pos.y, z: t.z - pos.z })
    }

    // If the car is nowhere near the point it is aiming at, the index is stale: that is
    // what a respawn does, and what running wide into a building does. Re-anchor to the
    // nearest point on the line. Without this the bot drives back toward where it was,
    // gets stuck, respawns, and does it again — a loop that cost it the whole race.
    const target = this.path[this.waypoint % this.path.length]
    if (Math.hypot(target.x - pos.x, target.z - pos.z) > 30) {
      let best = 0
      let bestDistance = Infinity
      for (let i = 0; i < this.path.length; i++) {
        const d = Math.hypot(this.path[i].x - pos.x, this.path[i].z - pos.z)
        if (d < bestDistance) {
          bestDistance = d
          best = i
        }
      }
      this.waypoint = best
    }

    // Only advance past waypoints the car has actually passed. Skipping on proximity
    // makes the driver aim beyond the corner and run off the outside of every bend.
    for (let step = 0; step < 3; step++) {
      if (toLocal(this.waypoint).z < 2) this.waypoint++
      else break
    }

    // Lateral error is measured against the distance in the car's forward *plane*, not
    // along local Z alone: on the ceiling run the next point is mostly overhead in the
    // chassis frame, and dividing by a near-zero local Z turns that into a phantom
    // hairpin the bot would brake for.
    const lateral = (p: Vec3) => Math.atan2(p.x, Math.max(Math.hypot(p.y, p.z), 0.5))
    const error = lateral(toLocal(this.waypoint))
    const speed = v.forwardSpeed()

    // Corner speed, properly: for every point in the next 150 m, the speed its radius
    // allows, raised by how much road is left to brake in. The lowest of those is how fast
    // the car can be going *now*. A curvature heuristic was enough for a circuit with four
    // corners; with fourteen, and at 30 m/s, it brakes after the apex and goes straight on.
    const spacing = 6
    let limit = CAR.maxSpeed * this.skill.pace
    for (let i = 1; i <= 25; i++) {
      const radius = this.radii[(this.waypoint + i) % this.radii.length]
      const corner = Math.sqrt(CORNERING * radius)
      const reachable = Math.sqrt(corner * corner + 2 * BRAKING * i * spacing)
      limit = Math.min(limit, reachable)
    }
    const targetSpeed = clamp(limit, 9, CAR.maxSpeed)
    // Only lift for a corner that is actually close, so the boost is not wasted mid-braking.
    const curvature = Math.abs(lateral(toLocal(this.waypoint + 4)))
    const grounded = v.wheel(0).contact || v.wheel(1).contact || v.wheel(2).contact || v.wheel(3).contact

    // Steer on the *rate* of turn, not on the angle.
    //
    // The input is two keys, so the only thing a bot can do is hold a direction or let go.
    // Holding until the nose is on the target overshoots every corner now that the car is
    // given a yaw rate rather than negotiating one with the tyres: by the time the error
    // reaches zero the car is still rotating at over a radian a second. So the bot asks
    // how fast it would have to rotate to be pointing at the target in AIM_SECONDS, and
    // holds the key only while the car is rotating slower than that. It is what a human
    // does without thinking: you stop turning once the car is coming round enough.
    const up = quatRotate(v.rotation(), { x: 0, y: 1, z: 0 })
    const yawRate = vdot(v.angvel(), up)
    const wanted = error / AIM_SECONDS

    let bits = 0
    if (wanted - yawRate > 0.08 + this.skill.slop) bits |= InputBit.Right
    else if (wanted - yawRate < -0.08 - this.skill.slop) bits |= InputBit.Left
    if (speed < targetSpeed) bits |= InputBit.Throttle
    else if (speed > targetSpeed + 2.5) bits |= InputBit.Brake
    const hintAt = (i: number) => this.hints[i % this.hints.length]
    // A gap ahead: the charge is for the thrusters, so no boost until it is crossed. The pad
    // before every gap pays a quarter of a bar, and the burst over it costs under a fifth.
    let gapAhead = false
    for (let i = 0; i < THRUST_LOOKAHEAD && !gapAhead; i++) gapAhead = hintAt(this.waypoint + i) === 'thrust'
    if (hintAt(this.waypoint) === 'thrust') bits |= InputBit.Thrust
    else if (hintAt(this.waypoint) === 'boost') {
      bits |= InputBit.Throttle
      if (car.charge > CHARGE.boostFloor) bits |= InputBit.Boost
    } else if (!gapAhead && car.charge > 0.4 && grounded && curvature < 0.18) bits |= InputBit.Boost

    // In the air the keys are attitude controls: throttle is nose down, steering is yaw, and
    // either one switches off the self-righting. A bot holding the throttle over a gap
    // front-flipped onto its roof on the landing every time, so off the ground it lets go of
    // everything but the thrusters and lets the car level itself.
    if (!grounded) bits &= InputBit.Thrust

    if (this.path[this.waypoint % this.path.length].y - pos.y > STRANDED_BELOW) this.strandedMs += TICK_MS
    else this.strandedMs = 0
    if (this.strandedMs > STRANDED_MS) {
      this.strandedMs = 0
      car.requestRespawn()
    }
    // Bots do not barrel roll. They have no way to judge how much flight is left, so they
    // roll on the way down as happily as on the way up, land on the roof and spend the rest
    // of the race respawning. Tricks are the player's business; the bots' job is to put a
    // car in your mirrors. The scripted flip in the invert zone still happens to them.
    return bits
  }

  reset(): void {
    this.waypoint = 0
  }
}
