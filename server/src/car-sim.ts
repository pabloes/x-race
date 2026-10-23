/**
 * Everything that happens to one car on one fixed tick: turning key bits into
 * engine/brake/steering, the charge bar, air control, trick scoring, the inverted
 * ceiling run, checkpoints and respawns.
 *
 * All of it runs on the server. The client never simulates a car, it only renders
 * interpolated snapshots, so this file is the single source of truth for the game feel.
 */

import { CAR, CHARGE, RACE, TICK_DT, TRICK } from '../../shared/constants'
import {
  clamp,
  lerp,
  moveTowards,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatRotate,
  vdot,
  vlen,
  type Quat,
  type Vec3
} from '../../shared/math'
import { CarFlag, hasBit, InputBit, steerAxis, type CarState, type GameEvent } from '../../shared/protocol'
import {
  checkpointsOf,
  DRIVABLE_HALF_WIDTH,
  lineOffset,
  respawnFor,
  type Track,
  type Trigger
} from '../../shared/tracks'
import type { Vehicle } from './physics/types'
import { pointInBox } from './geometry'

const UP: Vec3 = { x: 0, y: 1, z: 0 }
const FORWARD: Vec3 = { x: 0, y: 0, z: 1 }
const RIGHT: Vec3 = { x: 1, y: 0, z: 0 }

/** A scripted rotation: the car keeps flying ballistically while its orientation is driven. */
type Trick = {
  name: string
  from: Quat
  /** World-space axis and the full angle to turn about it, held from the first tick. */
  axis: Vec3
  radians: number
  elapsed: number
  duration: number
  /** Charge and points granted when it completes. */
  reward: number
  points: number
}

export class CarSim {
  vehicle: Vehicle
  /** The circuit and what this car tests against every tick, kept apart from the Track. */
  private track!: Track
  private checkpoints: Trigger[] = []
  private boostTriggers: Trigger[] = []
  private invertTriggers: Trigger[] = []

  charge: number = CHARGE.initial
  lap = 0
  /** Checkpoint index last passed, counting continuously across laps. */
  cpTotal = -1
  /** Checkpoint index within the current lap. */
  cp = -1
  rank = 1
  score = 0
  finished = false
  finishedAtMs = 0
  bestLapMs = 0
  lapStartMs = 0
  /** Inputs are latched so a lost packet repeats the last known state instead of cutting power. */
  private bits = 0
  private steer = 0
  private spin = 0
  private boosting = false
  private thrusting = false
  private grounded = false
  private wasGrounded = true
  private airborneMs = 0
  private rollAccum = 0
  private pitchAccum = 0
  private clearedObstacles = new Set<number>()
  private trick: Trick | null = null
  private inverted = false
  private invertScored = false
  private restingMs = 0
  private stuckMs = 0
  private respawnMs = 0
  /** Last known position along the racing line, the hint for the off-track test. */
  private lineIndex = 0
  private padCooldown = new Map<string, number>()

  constructor(
    readonly id: number,
    public name: string,
    vehicle: Vehicle,
    private spawn: { pos: Vec3; yaw: number },
    track: Track
  ) {
    this.vehicle = vehicle
    this.setTrack(track, vehicle)
  }

  /**
   * Moves the car onto another circuit: a new circuit is a new physics world, so the
   * chassis comes with it. Progress is the caller's to reset with `resetForRace`.
   */
  setTrack(track: Track, vehicle: Vehicle): void {
    this.track = track
    this.vehicle = vehicle
    this.checkpoints = checkpointsOf(track)
    this.boostTriggers = track.triggers.filter((t) => t.kind === 'boost')
    this.invertTriggers = track.triggers.filter((t) => t.kind === 'invert')
    this.lineIndex = 0
  }

  setInput(bits: number): void {
    this.bits = bits
  }

  /** Puts the car back on the grid and clears all per-race progress. */
  resetForRace(spawn: { pos: Vec3; yaw: number }, nowMs: number): void {
    // Kept, so a respawn before the first checkpoint goes back to this grid slot.
    this.spawn = spawn
    this.vehicle.reset(spawn.pos, spawn.yaw)
    this.charge = CHARGE.initial
    this.lap = 0
    this.cp = -1
    this.cpTotal = -1
    this.score = 0
    this.finished = false
    this.finishedAtMs = 0
    this.bestLapMs = 0
    this.lapStartMs = nowMs
    this.steer = 0
    this.spin = 0
    this.trick = null
    this.boosting = false
    this.thrusting = false
    this.inverted = false
    this.invertScored = false
    this.airborneMs = 0
    this.restingMs = 0
    this.stuckMs = 0
    this.respawnMs = 0
    this.clearedObstacles.clear()
    this.padCooldown.clear()
  }

  requestRespawn(): void {
    if (this.respawnMs <= 0) this.respawnMs = RACE.respawnDelayMs
  }

  /**
   * Advances this car one tick.
   * @param racing false during lobby/countdown — the car is held still but still simulated.
   */
  update(dt: number, nowMs: number, racing: boolean): GameEvent[] {
    const events: GameEvent[] = []
    const v = this.vehicle

    if (this.respawnMs > 0) {
      this.respawnMs -= dt * 1000
      v.setEngineForce(0)
      v.setBrake(CAR.handbrakeForce)
      v.setSteering(0)
      if (this.respawnMs <= 0) {
        const point = this.cpTotal < 0 ? this.spawn : respawnFor(this.track, this.cp)
        // Lanes, not a single point. Two cars that go off at the same checkpoint otherwise
        // respawn inside each other, wedge, trip the stuck detector and respawn again —
        // seen in the harness as two cars sitting on the same metre for a whole race with
        // eighteen respawns each. The offset is derived from the id, so a car always lands
        // in the same lane and two different cars never land in the same one.
        const lane = ((this.id % 3) - 1) * 3.2
        const across = (point.yaw * Math.PI) / 180
        const spot = {
          x: point.pos.x + Math.cos(across) * lane,
          y: point.pos.y,
          z: point.pos.z - Math.sin(across) * lane
        }
        v.reset(spot, point.yaw)
        this.thrusting = false
        this.inverted = false
        this.trick = null
        this.airborneMs = 0
        this.restingMs = 0
        this.stuckMs = 0
        events.push({ t: 'respawn', id: this.id })
      }
      v.updateVehicle(dt)
      return events
    }

    const pos = v.position()
    const rot = v.rotation()
    const localUp = quatRotate(rot, UP)
    const localForward = quatRotate(rot, FORWARD)
    const localRight = quatRotate(rot, RIGHT)
    const linvel = v.linvel()
    const angvel = v.angvel()
    const speed = v.forwardSpeed()
    const absSpeed = Math.abs(speed)

    this.grounded = v.wheel(0).contact || v.wheel(1).contact || v.wheel(2).contact || v.wheel(3).contact

    // --- Zones ---
    // Where the car is relative to the racing line, kept from tick to tick so the search
    // starts next to the answer. Off the asphalt the car gets gravel: less grip, less
    // engine and a drag that scales with speed.
    const line = lineOffset(this.track, pos, this.lineIndex)
    this.lineIndex = line.index
    const offTrack = line.distance > DRIVABLE_HALF_WIDTH

    // How sideways the car is, which decides both what the rear tyres do and what the
    // battery earns.
    const slipAngle = Math.abs(Math.atan2(vdot(linvel, localRight), vdot(linvel, localForward)))

    const inInvertZone = this.invertTriggers.some((t) => pointInBox(pos, t))
    if (inInvertZone && !this.inverted && !this.grounded && !this.trick) {
      // The Roadster move: half-roll onto the ceiling and let inverted gravity hold it there.
      this.startTrick('Roadster Flip', rot, localForward, Math.PI, 0.35, CHARGE.invertReward, 0)
      this.inverted = true
      v.setGravityScale(-1)
      events.push({ t: 'invert', id: this.id, entered: true })
    } else if (!inInvertZone && this.inverted) {
      this.inverted = false
      v.setGravityScale(1)
      events.push({ t: 'invert', id: this.id, entered: false })
      if (vdot(localUp, UP) < 0 && !this.trick) {
        // Still upside down on the way out: roll back so the landing is on the wheels.
        this.startTrick('Recovery', rot, localForward, Math.PI, 0.4, 0, 0)
      }
      if (!this.invertScored) {
        this.invertScored = true
        this.charge = clamp(this.charge + CHARGE.invertReward, 0, 1)
        this.score += 500
        events.push({ t: 'trick', id: this.id, name: 'Ceiling Run', points: 500 })
      }
    }

    for (const pad of this.boostTriggers) {
      const until = this.padCooldown.get(pad.id) ?? 0
      if (nowMs >= until && pointInBox(pos, pad)) {
        this.padCooldown.set(pad.id, nowMs + 2000)
        this.charge = clamp(this.charge + CHARGE.padReward, 0, 1)
        events.push({ t: 'pad', id: this.id })
      }
    }

    // --- Boost, thrusters and charge ---
    const hasCharge = this.charge > CHARGE.boostFloor
    // Hysteresis on the boost, which is why `boostFloor` exists at all: it takes a floor's
    // worth of battery to *start* a boost, but once lit it runs until the battery is
    // actually empty. Using the same threshold for both made the boost chatter on and off
    // around it — the regen tops the bar back over the floor, it re-engages, drains below
    // again — which from the driver's seat looks like a boost that is stuck half on.
    const askingBoost = racing && hasBit(this.bits, InputBit.Boost)
    this.boosting = askingBoost && (this.boosting ? this.charge > 0 : hasCharge)
    const wasThrusting = this.thrusting
    this.thrusting = racing && hasBit(this.bits, InputBit.Thrust) && hasCharge
    if (this.thrusting) {
      // Cold-gas thrusters double as the recovery tool, so while they fire the car is
      // *made* to come down well rather than merely pushed upward:
      //  - gravity is switched off for this chassis, so it hovers instead of fighting a
      //    fall (collisions are untouched — it still hits everything it would have hit)
      //  - the levelling torque below runs at full strength regardless of steering input
      // The result is that holding space always rights the car and sets up a flat landing.
      if (!this.inverted) v.setGravityScale(0)
      v.applyForce({ x: 0, y: CAR.thrusterForce, z: 0 })
      v.applyForce({
        x: -linvel.x * CAR.thrusterDrag * CAR.mass,
        y: 0,
        z: -linvel.z * CAR.thrusterDrag * CAR.mass
      })
      if (!this.inverted && !this.trick) this.applyLevelling(v, localUp, angvel, CAR.thrusterLevelTorque)
      this.charge = clamp(this.charge - CHARGE.thrusterDrainPerSecond * dt, 0, 1)
    } else if (wasThrusting && !this.inverted) {
      v.setGravityScale(1)
    }
    if (this.boosting) {
      this.charge = clamp(this.charge - CHARGE.drainPerSecond * dt, 0, 1)
    } else if (this.thrusting) {
      // already drained above
    } else if (this.grounded && absSpeed > 8 && slipAngle > CAR.driftSlipAngle) {
      // Sliding charges the battery, and the further sideways the car is the faster.
      // Capped at twice the trigger angle so a spin is not a jackpot.
      const amount = Math.min(slipAngle / (CAR.driftSlipAngle * 2), 1)
      this.charge = clamp(this.charge + CHARGE.driftRegenPerSecond * amount * dt, 0, 1)
    } else if (hasBit(this.bits, InputBit.Brake) && absSpeed > 2) {
      this.charge = clamp(this.charge + CHARGE.regenBrakingPerSecond * dt, 0, 1)
    } else if (!hasBit(this.bits, InputBit.Throttle) && absSpeed > 1) {
      this.charge = clamp(this.charge + CHARGE.regenPerSecond * dt, 0, 1)
    }

    // --- Steering ---
    const steerInput = racing ? steerAxis(this.bits) : 0
    const speedRatio = clamp(absSpeed / CAR.maxSpeed, 0, 1)
    const maxSteer = lerp(CAR.maxSteerLowSpeed, CAR.maxSteerHighSpeed, speedRatio)
    this.steer = moveTowards(this.steer, steerInput * maxSteer, CAR.steerRate * maxSteer * dt)
    v.setSteering(this.steer)

    // --- Engine and brakes ---
    const throttle = racing && hasBit(this.bits, InputBit.Throttle)
    const brake = racing && hasBit(this.bits, InputBit.Brake)
    const handbrake = racing && hasBit(this.bits, InputBit.Handbrake)
    const cap = this.boosting ? CAR.maxSpeedBoost : CAR.maxSpeed

    let engine = 0
    let brakeForce = 0
    if (throttle && speed < cap) {
      engine = CAR.engineForce * (this.boosting ? CHARGE.boostForceMultiplier : 1)
    }
    if (brake) {
      if (speed > 0.6) brakeForce = CAR.brakeForce
      else if (speed > -CAR.maxReverseSpeed) engine = -CAR.reverseForce
    }
    if (!throttle && !brake) {
      // Light engine braking so the car does not coast forever.
      brakeForce = CAR.brakeForce * 0.08
    }
    // Rear grip. Locked under handbrake, and *also* let go once the car is already
    // sideways: in an arcade racer a drift holds itself while you stay on the throttle,
    // and tyres that grip back up the moment the angle builds kill the slide before the
    // player can enjoy it. The yaw controller above still commands a rate, so letting go
    // here lengthens the drift rather than turning it into a spin.
    const sliding = this.grounded && absSpeed > 8 && slipAngle > CAR.driftSlipAngle
    if (handbrake) {
      brakeForce = CAR.handbrakeForce
      v.setRearGrip(CAR.handbrakeFrictionSlip)
    } else if (sliding && throttle) {
      v.setRearGrip(CAR.driftRearGrip)
    } else {
      v.setRearGrip(CAR.frictionSlip)
    }
    // Gravel: the engine is cut right down and cannot push past the gravel's own top
    // speed, so a car that runs wide cannot simply power along outside the track.
    const groundSpeed = Math.hypot(linvel.x, linvel.z)
    if (offTrack) engine = groundSpeed >= CAR.gravelMaxSpeed ? 0 : engine * CAR.gravelEngine
    v.setEngineForce(engine)
    v.setBrake(brakeForce)

    // --- Aero and air control ---
    if (this.grounded) {
      // Downforce along chassis-local down: pushes the wheels into whatever surface they
      // are on, which is what makes the loop and the ceiling run hold at speed.
      const vSq = Math.min(vlen(linvel) ** 2, CAR.maxSpeedBoost ** 2)
      const f = CAR.downforce * vSq
      v.applyForce({ x: -localUp.x * f, y: -localUp.y * f, z: -localUp.z * f })
      v.setDamping(0, CAR.angularDamping)

      // Arcade grip: bleed the sideways component of the velocity so the car follows its
      // nose. An impulse rather than a force, because what is being cancelled is a
      // velocity, and the fraction removed per tick should not depend on the mass.
      if (!handbrake && !this.trick) {
        const lateral = vdot(linvel, localRight)
        const rate = offTrack ? CAR.gripAssist * CAR.gravelGrip : CAR.gripAssist
        // Capped, so the assist is help and not a rail: past a couple of m/s of slip it
        // cannot take it all away and the car slides, then gathers itself as the slide
        // decays back under the cap.
        const accel = Math.min(Math.abs(lateral) * rate, CAR.gripAssistMaxAccel)
        const impulse = -Math.sign(lateral) * accel * dt * CAR.mass
        v.applyImpulse({ x: localRight.x * impulse, y: localRight.y * impulse, z: localRight.z * impulse })

      }

      // Yaw-rate steering, which is the other half of the arcade feel and the half that
      // produces the drift.
      //
      // Tyres negotiate a rate of turn; an arcade car is *given* one. The stick asks for a
      // yaw rate, a proportional controller delivers it, and the car rotates at that rate
      // whether or not the tyres could have carried the corner. Because the grip assist
      // above is capped, the velocity cannot follow that rotation instantly — and the gap
      // between where the car points and where it is going is exactly what a drift is.
      // Hold the handbrake and the asked-for rate goes up, which is how you provoke one.
      if (!this.trick) {
        const lock = maxSteer > 0 ? this.steer / maxSteer : 0
        const desired =
          lock * CAR.yawRate * Math.min(absSpeed / 12, 1) * (handbrake ? CAR.yawRateHandbrake : 1)
        const error = desired - vdot(angvel, localUp)
        const torque = clamp(error * CAR.yawGain, -CAR.yawTorqueMax, CAR.yawTorqueMax)
        v.applyTorque({ x: localUp.x * torque, y: localUp.y * torque, z: localUp.z * torque })
      }

      // Gravel. Below its top speed it is a drag proportional to speed; above it, the
      // car is scrubbed down hard, which is what makes arriving off the road at racing
      // pace cost the corner rather than a tenth.
      if (offTrack && groundSpeed > 0.1) {
        const over = groundSpeed - CAR.gravelMaxSpeed
        const accel = over > 0 ? Math.min(CAR.gravelBrakeAccel, over / dt) : CAR.gravelDrag * groundSpeed
        const k = (accel * CAR.mass) / groundSpeed
        v.applyForce({ x: -linvel.x * k, y: 0, z: -linvel.z * k })
      }
    } else {
      v.setDamping(CAR.airDrag, 0.35)
      // Air control only after a real take-off. Without this gate, the few ticks of lost
      // wheel contact when the car drops onto its springs at the start — or skims a bump —
      // are enough for the pitch torque to flip it onto its roof.
      const airControl = racing && !this.trick && this.airborneMs > TRICK.minAirControlMs
      const pitchInput = throttle ? 1 : brake ? -1 : 0
      if (airControl && (steerInput !== 0 || pitchInput !== 0)) {
        const yawT = steerInput * CAR.airControlTorque
        const pitchT = pitchInput * CAR.airControlTorque
        v.applyTorque({
          x: localUp.x * yawT + localRight.x * pitchT,
          y: localUp.y * yawT + localRight.y * pitchT,
          z: localUp.z * yawT + localRight.z * pitchT
        })
      } else if (airControl && !this.inverted && !this.thrusting) {
        // Hands off: rotate back toward upright so a messy launch still lands on its
        // wheels. Suppressed while the player is steering in the air (they may want the
        // roll) and during the inverted run, where being upside down is the point.
        // Thrusting runs its own, much stronger version of this above.
        this.applyLevelling(v, localUp, angvel, CAR.selfRightTorque)
      }

      // Landing assist: past a real fall speed the belly nozzles light and the car comes
      // down flat and slow enough to drive away from. The client already draws those
      // nozzles on the way down, which is the tell that this is happening.
      const falling = -linvel.y > CAR.landingFallSpeed
      if (falling && !this.inverted && !this.trick && this.airborneMs > TRICK.minAirControlMs) {
        this.applyLevelling(v, localUp, angvel, CAR.landingLevelTorque)
        const excess = -linvel.y - CAR.landingTouchdownSpeed
        if (excess > 0) {
          const lift = Math.min(CAR.landingBrakeAccel * dt, excess) * CAR.mass
          v.applyImpulse({ x: 0, y: lift, z: 0 })
        }
      }
    }

    // --- Tricks ---
    if (!this.grounded) {
      this.airborneMs += dt * 1000
      this.rollAccum += vdot(angvel, localForward) * dt
      this.pitchAccum += vdot(angvel, localRight) * dt
      this.trackClearedObstacles(pos)
      if (
        racing &&
        !this.trick &&
        hasBit(this.bits, InputBit.Flip) &&
        this.airborneMs > 120 &&
        !this.inverted
      ) {
        this.startTrick('Barrel Roll', rot, localForward, Math.PI * 2, 0.6, CHARGE.trickReward, 300)
      }
    }

    if (this.trick) {
      this.trick.elapsed += dt
      const t = clamp(this.trick.elapsed / this.trick.duration, 0, 1)
      // Ease in/out so the scripted rotation does not start or stop with a jerk.
      const eased = t * t * (3 - 2 * t)
      // The angle is ramped and the rotation rebuilt from it each tick, rather than
      // slerped between a start and an end orientation. Slerp takes the shortest path
      // between two attitudes, and a barrel roll's end *is* its start: a full turn came
      // out as no turn at all, so E scored 300 points and the car did not move. Driving
      // the angle keeps the whole 360° on the screen, and a half turn is unaffected.
      v.setRotation(
        quatNormalize(quatMultiply(quatFromAxisAngle(this.trick.axis, this.trick.radians * eased), this.trick.from))
      )
      v.setAngvel({ x: 0, y: 0, z: 0 })
      if (t >= 1) {
        v.setRotation(
          quatNormalize(quatMultiply(quatFromAxisAngle(this.trick.axis, this.trick.radians), this.trick.from))
        )
        this.charge = clamp(this.charge + this.trick.reward, 0, 1)
        if (this.trick.points > 0) {
          this.score += this.trick.points
          events.push({ t: 'trick', id: this.id, name: this.trick.name, points: this.trick.points })
        }
        this.rollAccum = 0
        this.pitchAccum = 0
        this.trick = null
      }
    }

    // Landing: score the air time and rotations that were accumulated.
    if (this.grounded && !this.wasGrounded) {
      if (this.airborneMs >= TRICK.minAirTimeMs) {
        const rolls = Math.floor(Math.abs(this.rollAccum) / (Math.PI * 2))
        const flips = Math.floor(Math.abs(this.pitchAccum) / (Math.PI * 2))
        const cleared = this.clearedObstacles.size
        let points = Math.round(this.airborneMs / 10) + cleared * 100 + (rolls + flips) * 300
        let name = this.airborneMs > 900 ? 'Huge Air' : 'Big Air'
        if (rolls > 0) name = rolls > 1 ? `${rolls}x Barrel Roll` : 'Barrel Roll'
        else if (flips > 0) name = this.pitchAccum < 0 ? 'Backflip' : 'Frontflip'
        this.charge = clamp(
          this.charge + CHARGE.trickReward * (rolls + flips) + CHARGE.obstacleReward * cleared,
          0,
          1
        )
        this.score += points
        events.push({ t: 'trick', id: this.id, name, points })
      }
      this.airborneMs = 0
      this.rollAccum = 0
      this.pitchAccum = 0
      this.clearedObstacles.clear()
    }
    this.wasGrounded = this.grounded

    // --- Recovery ---
    if (pos.y < RACE.killY || pos.y > this.track.extent) {
      this.requestRespawn()
    }
    const uprightDot = vdot(localUp, UP) * (this.inverted ? -1 : 1)
    const onRoof = this.grounded && uprightDot < Math.cos((TRICK.cleanLandingDegrees * Math.PI) / 180)
    const resting = !this.grounded && vlen(linvel) < 1.5 && !this.trick
    if (resting || (onRoof && absSpeed < 1)) {
      this.restingMs += dt * 1000
      if (this.restingMs > TRICK.flippedResetMs) this.requestRespawn()
    } else {
      this.restingMs = 0
    }
    // Wedged: upright, on the ground, asking for power and going nowhere. This is what
    // happens when a car slides off the side of a ramp and jams against it, where none of
    // the checks above apply, and without it the car sits there for the rest of the race.
    if (this.grounded && absSpeed < 1.5 && (throttle || brake) && !this.trick) {
      this.stuckMs += dt * 1000
      if (this.stuckMs > TRICK.stuckResetMs) this.requestRespawn()
    } else {
      this.stuckMs = 0
    }

    // --- Checkpoints ---
    if (racing && !this.finished) {
      const next = (this.cp + 1) % this.checkpoints.length
      if (pointInBox(pos, this.checkpoints[next])) {
        this.cp = next
        this.cpTotal++
        events.push({ t: 'cp', id: this.id, cp: next })
        if (next === 0 && this.cpTotal > 0) {
          const lapMs = nowMs - this.lapStartMs
          this.lapStartMs = nowMs
          this.lap++
          const best = this.bestLapMs === 0 || lapMs < this.bestLapMs
          if (best) this.bestLapMs = lapMs
          events.push({ t: 'lap', id: this.id, lap: this.lap, lapMs, best })
        }
      }
    }

    // Wheel spin for the client's visual wheels.
    this.spin = (this.spin + (speed / CAR.wheelRadius) * dt) % (Math.PI * 2)

    v.updateVehicle(dt)
    return events
  }

  /** Counts obstacles flown over, for the charge reward on landing. */
  private trackClearedObstacles(pos: Vec3): void {
    for (let i = 0; i < this.track.obstacles.length; i++) {
      if (this.clearedObstacles.has(i)) continue
      const o = this.track.obstacles[i]
      const top = o.pos.y + o.size.y / 2
      if (
        pos.y > top &&
        Math.abs(pos.x - o.pos.x) < o.size.x / 2 + 1.2 &&
        Math.abs(pos.z - o.pos.z) < o.size.z / 2 + 1.2
      ) {
        this.clearedObstacles.add(i)
      }
    }
  }

  /**
   * Rotates the chassis back toward upright. `cross(localUp, worldUp)` is the axis that
   * closes the angle between them, and the angular velocity term damps the result so the
   * car settles instead of oscillating.
   */
  private applyLevelling(v: Vehicle, localUp: Vec3, angvel: Vec3, torque: number): void {
    const axis = {
      x: localUp.y * UP.z - localUp.z * UP.y,
      y: localUp.z * UP.x - localUp.x * UP.z,
      z: localUp.x * UP.y - localUp.y * UP.x
    }
    v.applyTorque({
      x: axis.x * torque - angvel.x * CAR.selfRightDamping,
      y: axis.y * torque - angvel.y * CAR.selfRightDamping,
      z: axis.z * torque - angvel.z * CAR.selfRightDamping
    })
  }

  private startTrick(
    name: string,
    from: Quat,
    axis: Vec3,
    radians: number,
    duration: number,
    reward: number,
    points: number
  ): void {
    this.trick = {
      name,
      from,
      axis,
      radians,
      elapsed: 0,
      duration,
      reward,
      points
    }
  }

  /** How far around the lap this car is, used to sort the standings. */
  progress(): number {
    return this.lap * this.checkpoints.length + (this.cp + 1)
  }

  toState(): CarState {
    const v = this.vehicle
    let flags = 0
    if (this.grounded) flags |= CarFlag.Grounded
    if (this.boosting) flags |= CarFlag.Boosting
    if (this.thrusting) flags |= CarFlag.Thrusting
    if (this.inverted) flags |= CarFlag.Inverted
    if (this.trick) flags |= CarFlag.Tricking
    if (hasBit(this.bits, InputBit.Handbrake)) flags |= CarFlag.Handbraking
    if (this.respawnMs > 0) flags |= CarFlag.Respawning
    if (this.finished) flags |= CarFlag.Finished
    if (!this.grounded) flags |= CarFlag.Airborne
    return {
      id: this.id,
      pos: v.position(),
      rot: v.rotation(),
      vel: v.linvel(),
      steer: this.steer,
      spin: this.spin,
      susp: [v.wheel(0).suspension, v.wheel(1).suspension, v.wheel(2).suspension, v.wheel(3).suspension],
      flags,
      charge: this.charge,
      lap: this.lap,
      cp: this.cp,
      rank: this.rank,
      score: this.score
    }
  }
}
