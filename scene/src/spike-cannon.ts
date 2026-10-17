/**
 * Throwaway measurement: can QuickJS carry a cannon-es vehicle simulation inside the
 * scene, on top of everything the scene already draws?
 *
 * This is the question that decides whether client-side prediction is worth building. The
 * numbers that matter are not "does it run" but:
 *
 *  - **ms per step** of a world holding the car and the circuit's static boxes near it;
 *  - **ms per rollback**, because prediction re-simulates every tick between the last
 *    authoritative snapshot and now, every time a snapshot lands. At 75 ms of ping and
 *    30 snapshots a second that is roughly five extra steps thirty times a second, so the
 *    cost of the physics is multiplied, not added to;
 *  - **what it does to the frame rate**, which is already the scarce resource at 37 fps.
 *
 * Only the static geometry within `NEARBY_RADIUS` of the car is added, which is the shape
 * a real prediction world would have: the client never needs the far side of the circuit
 * to predict the next hundred milliseconds, and a broadphase over 205 boxes it cannot
 * touch is the easiest cost to not pay.
 *
 * Delete this file once the decision is made.
 */

import { engine } from '@dcl/sdk/ecs'
import * as CANNON from 'cannon-es'
import { CAR, TICK_DT } from '../../shared/constants'
import { TRACK } from '../../shared/track'
import { hud } from './ui'

/**
 * Flip to true to take the measurement. It is off by default because the spike costs
 * frames by construction, and a frame lost here is input latency everywhere else.
 */
export const SPIKE_CANNON = true

/** Static geometry this far from the car is left out of the prediction world. */
const NEARBY_RADIUS = 45
/** Ticks replayed per rollback: about what 75 ms of ping costs at a 60 Hz tick. */
const ROLLBACK_TICKS = 5
/** Rollbacks per second, one per snapshot. */
const ROLLBACKS_PER_SECOND = 30

type Spike = {
  world: CANNON.World
  vehicle: CANNON.RaycastVehicle
  /** Where the car started, to put it back when it wanders out of the measured area. */
  home: CANNON.Vec3
  boxes: number
  stepMs: number
  stepCount: number
  rollbackMs: number
  rollbackCount: number
  elapsed: number
  rollbackDebt: number
  frames: number
}

let spike: Spike | null = null

function buildWorld(): Spike {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -20, 0) })
  world.broadphase = new CANNON.SAPBroadphase(world)
  world.defaultContactMaterial.friction = 0.6

  // Anchored at the busiest point of the circuit rather than the grid. The grid sits on
  // a 30 m slab of straight with three pieces of asphalt around it, which is below the
  // median for the lap: measuring there would answer an easier question than the one
  // being asked. Point 176 carries 16 surfaces within the radius, the most of any.
  const spawn = { pos: TRACK.centreline[176], yaw: 0 }
  let added = 0
  for (const surface of TRACK.surfaces) {
    if (surface.kind === 'ground') continue
    const dx = surface.pos.x - spawn.pos.x
    const dz = surface.pos.z - spawn.pos.z
    if (Math.sqrt(dx * dx + dz * dz) > NEARBY_RADIUS) continue
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(
        new CANNON.Vec3(surface.size.x / 2, surface.size.y / 2, surface.size.z / 2)
      ),
      position: new CANNON.Vec3(surface.pos.x, surface.pos.y, surface.pos.z)
    })
    body.quaternion.setFromEuler(
      (surface.rot[0] * Math.PI) / 180,
      (surface.rot[1] * Math.PI) / 180,
      (surface.rot[2] * Math.PI) / 180,
      'YXZ'
    )
    world.addBody(body)
    added++
  }

  const chassis = new CANNON.Body({
    mass: CAR.mass,
    shape: new CANNON.Box(
      new CANNON.Vec3(CAR.halfExtents.x, CAR.halfExtents.y, CAR.halfExtents.z)
    ),
    position: new CANNON.Vec3(spawn.pos.x, spawn.pos.y + 1, spawn.pos.z)
  })
  const vehicle = new CANNON.RaycastVehicle({ chassisBody: chassis })
  for (const anchor of CAR.wheelAnchors) {
    vehicle.addWheel({
      radius: CAR.wheelRadius,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      axleLocal: new CANNON.Vec3(1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(anchor.x, anchor.y, anchor.z),
      suspensionRestLength: CAR.suspensionRestLength,
      suspensionStiffness: CAR.suspensionStiffness,
      dampingCompression: CAR.suspensionCompression,
      dampingRelaxation: CAR.suspensionRelaxation,
      maxSuspensionTravel: CAR.suspensionMaxTravel,
      maxSuspensionForce: CAR.maxSuspensionForce,
      frictionSlip: CAR.frictionSlip,
      rollInfluence: 0.1,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true
    })
  }
  vehicle.addToWorld(world)
  console.log(`[spike] mundo de predicción: ${added} cajas estáticas en ${NEARBY_RADIUS} m, 1 vehículo`)
  return {
    world,
    vehicle,
    home: new CANNON.Vec3(spawn.pos.x, spawn.pos.y + 1, spawn.pos.z),
    boxes: added,
    stepMs: 0,
    stepCount: 0,
    rollbackMs: 0,
    rollbackCount: 0,
    elapsed: 0,
    rollbackDebt: 0,
    frames: 0
  }
}

/**
 * Keeps the car inside the measured patch.
 *
 * The cost being measured is the cost of a car *on the track*: wheels in contact, boxes in
 * the broadphase, contacts being solved. A car that has driven out of the 45 m of geometry
 * is in free space, where a step costs almost nothing and the measurement would flatter
 * itself into a wrong decision.
 */
function recall(s: Spike): void {
  const body = s.vehicle.chassisBody
  const away = body.position.distanceTo(s.home)
  if (away < 35) return
  body.position.copy(s.home)
  body.velocity.set(0, 0, 0)
  body.angularVelocity.set(0, 0, 0)
  body.quaternion.set(0, 0, 0, 1)
}

function drive(s: Spike): void {
  // Something to simulate: full throttle with a little lock, so the wheels are loaded and
  // the vehicle code does its real work rather than idling on its springs.
  for (let i = 0; i < 4; i++) s.vehicle.applyEngineForce(i < 2 ? 0 : CAR.engineForce / 2, i)
  s.vehicle.setSteeringValue(0.15, 0)
  s.vehicle.setSteeringValue(0.15, 1)
}

function system(dt: number): void {
  if (!spike) return
  const s = spike
  s.elapsed += dt
  s.frames++
  recall(s)
  drive(s)

  const stepStart = Date.now()
  s.world.step(TICK_DT)
  s.stepMs += Date.now() - stepStart
  s.stepCount++

  // Rollbacks arrive with snapshots, not with frames, so the debt is accumulated in
  // seconds and paid off whenever a frame happens to be the one that owes it.
  s.rollbackDebt += dt * ROLLBACKS_PER_SECOND
  if (s.rollbackDebt >= 1) {
    s.rollbackDebt -= 1
    const replayStart = Date.now()
    for (let i = 0; i < ROLLBACK_TICKS; i++) s.world.step(TICK_DT)
    s.rollbackMs += Date.now() - replayStart
    s.rollbackCount++
  }

  if (s.elapsed >= 2) {
    const perStep = s.stepMs / Math.max(s.stepCount, 1)
    const perRollback = s.rollbackMs / Math.max(s.rollbackCount, 1)
    const budget = ((s.stepMs + s.rollbackMs) / (s.elapsed * 1000)) * 100
    // Straight onto the HUD: the scene's console does not reach the terminal running the
    // preview, and the whole point of this file is a number someone can read.
    hud.spike =
      `cannon ${perStep.toFixed(2)} ms/paso · rollback ${perRollback.toFixed(2)} ms · ` +
      `${budget.toFixed(1)}% CPU · ${s.boxes} cajas`
    console.log(`[spike] ${hud.spike} · ${(s.frames / s.elapsed).toFixed(0)} fps`)
    s.stepMs = 0
    s.stepCount = 0
    s.rollbackMs = 0
    s.rollbackCount = 0
    s.elapsed = 0
    s.frames = 0
  }
}

/** Starts the measurement. Safe to call: a failure is reported, not thrown. */
export function startCannonSpike(): void {
  try {
    spike = buildWorld()
    engine.addSystem(system, 1)
  } catch (error) {
    hud.spike = 'cannon-es NO arranca en la escena'
    console.log(`[spike] cannon-es NO arranca en el runtime de la escena: ${String(error)}`)
  }
}
