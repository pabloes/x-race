/**
 * cannon-es backend, behind the same interface as the Rapier one.
 *
 * It exists for one reason: cannon-es is plain JavaScript, so it can also run inside the
 * Decentraland scene, where Rapier cannot (the runtime is QuickJS with no WebAssembly).
 * Client-side prediction means simulating the same thing on both sides, and that is only
 * possible with an engine that both sides can load. Nothing else about the game changes:
 * `car-sim.ts` talks to `Vehicle` and does not know which engine is underneath.
 *
 * Three things work differently here than in Rapier, and all three are handled rather than
 * worked around at the call site:
 *
 *  - **Forces are cleared every step.** Cannon zeroes `body.force` and `body.torque` after
 *    integrating, so a force applied once per tick is exactly a one-tick impulse. Rapier
 *    keeps them alive until reset, which is why its backend multiplies by `dt` by hand.
 *  - **There is no per-body gravity scale.** The thrusters switch gravity off for a car,
 *    so it is emulated: the difference between the world's gravity and the car's share of
 *    it is applied as a force each tick.
 *  - **The wheel raycasts hit everything.** Rapier can exclude dynamic bodies from the
 *    suspension rays with a flag; cannon's vehicle calls `world.rayTest` with no filter,
 *    so without help a car's wheels would find another car's roof and drive up it. The
 *    other chassis are hidden from the ray for the length of the update.
 */

import * as CANNON from 'cannon-es'
import { CAR, GRAVITY, TICK_DT } from '../../../shared/constants'
import { quatFromEulerDegrees, type Quat, type Vec3 } from '../../../shared/math'
import type { Track } from '../../../shared/tracks'
import type { PhysicsWorld, Vehicle, WheelState } from './types'

/**
 * Damping, translated.
 *
 * The car's damping numbers are rates per second, the way Rapier takes them: a value of
 * 3.2 means the velocity decays by `e^-3.2` every second. Cannon instead multiplies the
 * velocity by `(1 - damping)^dt` each step and expects a fraction below one — handed 3.2
 * it computes `(-2.2)^(1/60)`, which is **NaN**, and from there the quaternion, the
 * contacts and the whole world go with it. This is the conversion between the two.
 */
function damping(rate: number): number {
  return Math.min(1 - Math.exp(-rate), 0.999)
}

/** Wheel order matches CAR.wheelAnchors: FL, FR, RL, RR. */
const FRONT_WHEELS = [0, 1]
const REAR_WHEELS = [2, 3]

class CannonVehicle implements Vehicle {
  readonly body: CANNON.Body
  private readonly vehicle: CANNON.RaycastVehicle
  private readonly wheelStates: WheelState[] = []
  private gravityScale = 1

  constructor(
    private readonly world: CANNON.World,
    pos: Vec3,
    yaw: number
  ) {
    const h = CAR.halfExtents
    const q = quatFromEulerDegrees(0, yaw, 0)
    this.body = new CANNON.Body({
      mass: CAR.mass,
      position: new CANNON.Vec3(pos.x, pos.y, pos.z),
      quaternion: new CANNON.Quaternion(q.x, q.y, q.z, q.w),
      angularDamping: damping(CAR.angularDamping),
      linearDamping: 0,
      material: new CANNON.Material({ friction: 0.4, restitution: 0.1 })
    })
    // Cannon has no centre-of-mass offset, so the shape is moved instead: the body origin
    // *is* the centre of mass, and hanging the box above it drops the mass low in the car,
    // which is what stops it tipping over under the arcade downforce.
    this.body.addShape(
      new CANNON.Box(new CANNON.Vec3(h.x, h.y, h.z)),
      new CANNON.Vec3(-CAR.comOffset.x, -CAR.comOffset.y, -CAR.comOffset.z)
    )
    this.body.updateMassProperties()
    // ...and the inertia the car is tuned around, in place of the one the box implies.
    this.body.inertia.set(CAR.inertia.x, CAR.inertia.y, CAR.inertia.z)
    this.body.invInertia.set(1 / CAR.inertia.x, 1 / CAR.inertia.y, 1 / CAR.inertia.z)
    this.body.updateInertiaWorld(true)

    this.vehicle = new CANNON.RaycastVehicle({
      chassisBody: this.body,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2
    })
    for (const anchor of CAR.wheelAnchors) {
      this.vehicle.addWheel({
        radius: CAR.wheelRadius,
        directionLocal: new CANNON.Vec3(0, -1, 0),
        axleLocal: new CANNON.Vec3(-1, 0, 0),
        chassisConnectionPointLocal: new CANNON.Vec3(anchor.x, anchor.y, anchor.z),
        suspensionRestLength: CAR.suspensionRestLength,
        suspensionStiffness: CAR.suspensionStiffness,
        dampingCompression: CAR.suspensionCompression,
        dampingRelaxation: CAR.suspensionRelaxation,
        maxSuspensionTravel: CAR.suspensionMaxTravel,
        maxSuspensionForce: CAR.maxSuspensionForce,
        frictionSlip: CAR.frictionSlip,
        rollInfluence: 0.05,
        customSlidingRotationalSpeed: -30,
        useCustomSlidingRotationalSpeed: true
      })
      this.wheelStates.push({ contact: false, suspension: 0, rotation: 0 })
    }
    // Added by hand rather than with `addToWorld`, which also installs a `preStep` hook
    // that would run the vehicle a second time: the fixed-timestep loop calls
    // `updateVehicle` itself, deliberately, before stepping the world.
    world.addBody(this.body)
    this.vehicle.world = world
  }

  setSteering(radians: number): void {
    for (const i of FRONT_WHEELS) this.vehicle.setSteeringValue(radians, i)
  }

  setEngineForce(newtons: number): void {
    // Negated: cannon's raycast vehicle drives a wheel *backwards* along the chassis'
    // forward axis for a positive engine force, the opposite of Rapier. Measured, not
    // assumed — a positive force sent the car down the straight in reverse at 44 m/s
    // while `forwardSpeed()` reported it as going forwards, so nothing capped it.
    const per = -newtons / 4
    for (let i = 0; i < 4; i++) this.vehicle.applyEngineForce(per, i)
  }

  setBrake(newtons: number): void {
    for (let i = 0; i < 4; i++) this.vehicle.setBrake(newtons, i)
  }

  setRearGrip(frictionSlip: number): void {
    for (const i of REAR_WHEELS) this.vehicle.wheelInfos[i].frictionSlip = frictionSlip
  }

  /** A force held for exactly one step, which is what cannon's own clearing gives us. */
  applyForce(f: Vec3): void {
    this.body.applyForce(new CANNON.Vec3(f.x, f.y, f.z))
  }

  applyImpulse(i: Vec3): void {
    this.body.applyImpulse(new CANNON.Vec3(i.x, i.y, i.z))
  }

  applyTorque(t: Vec3): void {
    this.body.applyTorque(new CANNON.Vec3(t.x, t.y, t.z))
  }

  setGravityScale(scale: number): void {
    this.gravityScale = scale
  }

  setDamping(linear: number, angular: number): void {
    this.body.linearDamping = damping(linear)
    this.body.angularDamping = damping(angular)
  }

  position(): Vec3 {
    const p = this.body.position
    return { x: p.x, y: p.y, z: p.z }
  }

  rotation(): Quat {
    const q = this.body.quaternion
    return { x: q.x, y: q.y, z: q.z, w: q.w }
  }

  linvel(): Vec3 {
    const v = this.body.velocity
    return { x: v.x, y: v.y, z: v.z }
  }

  angvel(): Vec3 {
    const v = this.body.angularVelocity
    return { x: v.x, y: v.y, z: v.z }
  }

  forwardSpeed(): number {
    // Signed along the chassis' forward axis. Cannon's own `currentVehicleSpeedKmHour` is
    // the magnitude of the velocity with a sign bolted on, which reads a sideways slide as
    // forward speed — and this car spends its time sideways on purpose.
    const forward = new CANNON.Vec3(0, 0, 1)
    this.body.quaternion.vmult(forward, forward)
    return this.body.velocity.dot(forward)
  }

  wheel(index: number): WheelState {
    return this.wheelStates[index]
  }

  setLinvel(v: Vec3): void {
    this.body.velocity.set(v.x, v.y, v.z)
  }

  setAngvel(v: Vec3): void {
    this.body.angularVelocity.set(v.x, v.y, v.z)
  }

  setRotation(q: Quat): void {
    this.body.quaternion.set(q.x, q.y, q.z, q.w)
  }

  reset(pos: Vec3, yaw: number): void {
    const q = quatFromEulerDegrees(0, yaw, 0)
    this.body.position.set(pos.x, pos.y, pos.z)
    this.body.quaternion.set(q.x, q.y, q.z, q.w)
    this.body.velocity.setZero()
    this.body.angularVelocity.setZero()
    this.body.force.setZero()
    this.body.torque.setZero()
    this.gravityScale = 1
    this.setBrake(0)
    this.setEngineForce(0)
    this.setSteering(0)
  }

  updateVehicle(dt: number): void {
    // Gravity scale, emulated. The world pulls every body down by the same amount, so a
    // car that wants a different share of it asks for the difference as a force.
    if (this.gravityScale !== 1) {
      this.body.applyForce(new CANNON.Vec3(0, (this.gravityScale - 1) * GRAVITY * CAR.mass, 0))
    }
    this.vehicle.updateVehicle(dt)
    for (let i = 0; i < this.wheelStates.length; i++) {
      const info = this.vehicle.wheelInfos[i]
      const state = this.wheelStates[i]
      state.contact = info.isInContact
      state.suspension = clamp01(1 - info.suspensionLength / CAR.suspensionRestLength)
      state.rotation = info.rotation
    }
  }

  dispose(): void {
    this.world.removeBody(this.body)
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export class CannonWorld implements PhysicsWorld {
  readonly engineName = 'cannon-es'
  private readonly world: CANNON.World
  private readonly vehicles: CannonVehicle[] = []

  constructor(track: Track) {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) })
    // Sweep and prune: the track is hundreds of static boxes that never move, which is
    // the case the naive broadphase is worst at.
    this.world.broadphase = new CANNON.SAPBroadphase(this.world)
    this.world.defaultContactMaterial.friction = 0.6
    this.world.defaultContactMaterial.restitution = 0.05
    this.buildTrack(track)
  }

  private buildTrack(track: Track): void {
    const add = (pos: Vec3, size: Vec3, rot: [number, number, number], friction: number) => {
      const q = quatFromEulerDegrees(rot[0], rot[1], rot[2])
      const body = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(pos.x, pos.y, pos.z),
        quaternion: new CANNON.Quaternion(q.x, q.y, q.z, q.w),
        shape: new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2)),
        material: new CANNON.Material({ friction, restitution: 0.05 })
      })
      this.world.addBody(body)
    }
    for (const s of track.surfaces) add(s.pos, s.size, s.rot, s.friction)
    for (const o of track.obstacles) add(o.pos, o.size, o.rot, 0.6)
  }

  createVehicle(pos: Vec3, yaw: number): Vehicle {
    const vehicle = new CannonVehicle(this.world, pos, yaw)
    this.vehicles.push(vehicle)
    return vehicle
  }

  removeVehicle(v: Vehicle): void {
    const index = this.vehicles.indexOf(v as CannonVehicle)
    if (index >= 0) this.vehicles.splice(index, 1)
    ;(v as CannonVehicle).dispose()
  }

  /**
   * Hides the other cars from one car's suspension rays.
   *
   * `world.rayTest` takes no filter, and a ray skips a body whose collision group shares
   * no bit with the ray's mask, so the group is cleared for the length of the update and
   * put back before the step that needs it. Without this, wheels find the roof of the car
   * in front and climb it.
   */
  hideOthersFromRays(except: Vehicle): () => void {
    const hidden: CannonVehicle[] = []
    for (const vehicle of this.vehicles) {
      if (vehicle === except) continue
      hidden.push(vehicle)
      vehicle.body.collisionFilterGroup = 0
    }
    return () => {
      for (const vehicle of hidden) vehicle.body.collisionFilterGroup = 1
    }
  }

  step(): void {
    this.world.step(TICK_DT)
  }
}
