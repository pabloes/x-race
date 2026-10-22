/**
 * The seam between the race simulation and whatever physics engine is underneath.
 *
 * Rapier is the default (see `rapier.ts`). The surface area is deliberately small —
 * a raycast-vehicle chassis plus force application — so a cannon-es backend can be
 * dropped in behind the same interface without touching `sim.ts` or `room.ts`.
 */

import type { Quat, Vec3 } from '../../../shared/math'

export type WheelState = {
  contact: boolean
  /** 0 = fully extended, 1 = fully compressed. */
  suspension: number
  /** Accumulated spin angle on the axle, radians. */
  rotation: number
}

export interface Vehicle {
  /** Front wheel steering angle in radians. */
  setSteering(radians: number): void
  /** Total engine force, split evenly across the four wheels. */
  setEngineForce(newtons: number): void
  setBrake(newtons: number): void
  /** Lowers rear tyre grip for handbrake slides. */
  setRearGrip(frictionSlip: number): void

  applyForce(f: Vec3): void
  applyImpulse(i: Vec3): void
  applyTorque(t: Vec3): void
  setGravityScale(scale: number): void
  setDamping(linear: number, angular: number): void

  position(): Vec3
  rotation(): Quat
  linvel(): Vec3
  angvel(): Vec3
  /** Signed speed along the chassis' forward axis. */
  forwardSpeed(): number
  wheel(index: number): WheelState

  setLinvel(v: Vec3): void
  setAngvel(v: Vec3): void
  /** Overrides orientation while leaving linear motion to the solver (scripted tricks). */
  setRotation(q: Quat): void
  /** Hard teleport, used for spawns and respawns. Clears velocities. */
  reset(pos: Vec3, yaw: number): void

  /** Runs the wheel/suspension model for one fixed step. Called before `world.step()`. */
  updateVehicle(dt: number): void
}

export interface PhysicsWorld {
  readonly engineName: string
  createVehicle(pos: Vec3, yaw: number): Vehicle
  removeVehicle(v: Vehicle): void
  /** Advances the world by exactly one fixed timestep. */
  step(): void
  /** Releases the world, vehicles included; a room switching circuit builds a new one. */
  dispose(): void
}
