/**
 * Rapier backend: one static body holding every track collider, plus a dynamic
 * chassis per car driven by Rapier's DynamicRayCastVehicleController.
 *
 * The wheels raycast along the chassis' *local* down axis, which is what lets the
 * same vehicle model drive the inside of the loop and the underside of the ceiling
 * without any special casing — when the chassis is upside down, local down points at
 * world up and the raycast finds the ceiling.
 */

import RAPIER from '@dimforge/rapier3d-compat'
import { CAR, GRAVITY, TICK_DT } from '../../../shared/constants'
import { quatFromEulerDegrees, type Quat, type Vec3 } from '../../../shared/math'
import type { Track } from '../../../shared/tracks'
import type { PhysicsWorld, Vehicle, WheelState } from './types'

let initialised = false

export async function initRapier(): Promise<void> {
  if (!initialised) {
    await RAPIER.init()
    initialised = true
  }
}

/**
 * Collision groups: membership in the high 16 bits, what it interacts with in the low 16.
 * Barriers are a group of their own so the wheel raycasts can leave them out: a chassis
 * pressed against one is stopped by it, but a wheel that finds its top is a wheel on the
 * barrier, and it lifted that side of the car up the barrier onto two wheels.
 */
const BARRIER_GROUP = (0x0002 << 16) | 0xffff
const WHEEL_RAYS = (0xffff << 16) | (0xffff & ~0x0002)

/** Wheel order matches CAR.wheelAnchors: FL, FR, RL, RR. */
const FRONT_WHEELS = [0, 1]
const REAR_WHEELS = [2, 3]

class RapierVehicle implements Vehicle {
  private readonly body: RAPIER.RigidBody
  private readonly controller: RAPIER.DynamicRayCastVehicleController
  private readonly wheelStates: WheelState[] = []

  constructor(
    private readonly world: RAPIER.World,
    pos: Vec3,
    yaw: number
  ) {
    const q = quatFromEulerDegrees(0, yaw, 0)
    const h = CAR.halfExtents
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation(q)
        .setLinearDamping(0)
        .setAngularDamping(CAR.angularDamping)
        // At boost speed the chassis moves ~0.5 m per tick, about the thickness of the
        // road, so continuous collision detection is not optional here.
        .setCcdEnabled(true)
    )
    // Mass lives on the collider: RigidBodyDesc.setAdditionalMassProperties is silently
    // ignored in rapier3d-compat 0.14 (the body ends up with mass 0 and an inverse mass
    // of 0, so applied forces do nothing at all), whereas ColliderDesc.setMassProperties
    // works. Roll inertia is raised well above the box value and the centre of mass is
    // dropped, so the car resists tipping over under the heavy arcade downforce.
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
        .setMassProperties(CAR.mass, CAR.comOffset, CAR.inertia, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.4)
        .setRestitution(0.1),
      this.body
    )

    this.controller = world.createVehicleController(this.body)
    this.controller.indexUpAxis = 1
    this.controller.setIndexForwardAxis = 2

    const down = { x: 0, y: -1, z: 0 }
    const axle = { x: -1, y: 0, z: 0 }
    for (const anchor of CAR.wheelAnchors) {
      this.controller.addWheel(anchor, down, axle, CAR.suspensionRestLength, CAR.wheelRadius)
      this.wheelStates.push({ contact: false, suspension: 0, rotation: 0 })
    }
    for (let i = 0; i < CAR.wheelAnchors.length; i++) {
      this.controller.setWheelSuspensionStiffness(i, CAR.suspensionStiffness)
      this.controller.setWheelSuspensionCompression(i, CAR.suspensionCompression)
      this.controller.setWheelSuspensionRelaxation(i, CAR.suspensionRelaxation)
      this.controller.setWheelMaxSuspensionTravel(i, CAR.suspensionMaxTravel)
      this.controller.setWheelMaxSuspensionForce(i, CAR.maxSuspensionForce)
      this.controller.setWheelFrictionSlip(i, CAR.frictionSlip)
      this.controller.setWheelSideFrictionStiffness(i, CAR.sideFrictionStiffness)
    }
  }

  setSteering(radians: number): void {
    for (const i of FRONT_WHEELS) this.controller.setWheelSteering(i, radians)
  }

  setEngineForce(newtons: number): void {
    const per = newtons / 4
    for (let i = 0; i < 4; i++) this.controller.setWheelEngineForce(i, per)
  }

  setBrake(newtons: number): void {
    for (let i = 0; i < 4; i++) this.controller.setWheelBrake(i, newtons)
  }

  setRearGrip(frictionSlip: number): void {
    for (const i of REAR_WHEELS) this.controller.setWheelFrictionSlip(i, frictionSlip)
  }

  /**
   * Per-tick forces are applied as impulses (force * dt), which is exact on a fixed
   * timestep and, unlike `RigidBody.addForce`, does not persist.
   *
   * Rapier keeps an added force alive across steps until `resetForces` is called, so
   * calling addForce once per tick silently integrates it: the downforce grew by its own
   * value every tick until it reached hundreds of kN, crushed the suspension past its
   * stop and dragged the car to a standstill.
   */
  applyForce(f: Vec3): void {
    this.body.applyImpulse({ x: f.x * TICK_DT, y: f.y * TICK_DT, z: f.z * TICK_DT }, true)
  }

  applyImpulse(i: Vec3): void {
    this.body.applyImpulse(i, true)
  }

  applyTorque(t: Vec3): void {
    this.body.applyTorqueImpulse({ x: t.x * TICK_DT, y: t.y * TICK_DT, z: t.z * TICK_DT }, true)
  }

  setGravityScale(scale: number): void {
    this.body.setGravityScale(scale, true)
  }

  setDamping(linear: number, angular: number): void {
    this.body.setLinearDamping(linear)
    this.body.setAngularDamping(angular)
  }

  position(): Vec3 {
    return this.body.translation()
  }

  rotation(): Quat {
    return this.body.rotation()
  }

  linvel(): Vec3 {
    return this.body.linvel()
  }

  angvel(): Vec3 {
    return this.body.angvel()
  }

  forwardSpeed(): number {
    return this.controller.currentVehicleSpeed()
  }

  wheel(index: number): WheelState {
    return this.wheelStates[index]
  }

  setLinvel(v: Vec3): void {
    this.body.setLinvel(v, true)
  }

  setAngvel(v: Vec3): void {
    this.body.setAngvel(v, true)
  }

  setRotation(q: Quat): void {
    this.body.setRotation(q, true)
  }

  reset(pos: Vec3, yaw: number): void {
    this.body.setTranslation(pos, true)
    this.body.setRotation(quatFromEulerDegrees(0, yaw, 0), true)
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setGravityScale(1, true)
    this.setBrake(0)
    this.setEngineForce(0)
    this.setSteering(0)
  }

  updateVehicle(dt: number): void {
    // EXCLUDE_DYNAMIC keeps the suspension raycasts on static track geometry only:
    // cars bump each other chassis-to-chassis instead of driving up each other's roofs.
    this.controller.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, WHEEL_RAYS)
    for (let i = 0; i < this.wheelStates.length; i++) {
      const s = this.wheelStates[i]
      s.contact = this.controller.wheelIsInContact(i)
      const length = this.controller.wheelSuspensionLength(i) ?? CAR.suspensionRestLength
      s.suspension = clamp01(1 - length / CAR.suspensionRestLength)
      s.rotation = this.controller.wheelRotation(i) ?? s.rotation
    }
  }

  /** @internal used by the world to drop the chassis and its controller. */
  dispose(): void {
    this.world.removeVehicleController(this.controller)
    this.world.removeRigidBody(this.body)
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export class RapierWorld implements PhysicsWorld {
  readonly engineName = 'rapier3d'
  private readonly world: RAPIER.World

  constructor(track: Track) {
    if (!initialised) throw new Error('initRapier() must be awaited before creating a RapierWorld')
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 })
    this.world.timestep = TICK_DT
    this.buildTrack(track)
  }

  private buildTrack(track: Track): void {
    // All static geometry hangs off a single fixed body: one island, no per-piece overhead.
    const staticBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    const add = (pos: Vec3, size: Vec3, rot: [number, number, number], friction: number, barrier = false) => {
      const q = quatFromEulerDegrees(rot[0], rot[1], rot[2])
      const desc = RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation(q)
        .setFriction(friction)
      if (barrier) {
        // And slippery: friction against the chassis is what turned a car sliding along a
        // corner's barrier into one stopped by it. Min combines it with the chassis' 0.4 as
        // the barrier's own, so a car leaning on one keeps its speed and only loses the part
        // of it that was going into the wall.
        desc.setCollisionGroups(BARRIER_GROUP).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      }
      this.world.createCollider(desc, staticBody)
    }
    for (const s of track.surfaces) add(s.pos, s.size, s.rot, s.friction, s.kind === 'barrier')
    for (const o of track.obstacles) add(o.pos, o.size, o.rot, 0.6)
  }

  createVehicle(pos: Vec3, yaw: number): Vehicle {
    return new RapierVehicle(this.world, pos, yaw)
  }

  removeVehicle(v: Vehicle): void {
    ;(v as RapierVehicle).dispose()
  }

  step(): void {
    this.world.step()
  }

  dispose(): void {
    // The world lives in wasm memory, which the garbage collector cannot see.
    this.world.free()
  }
}
