/**
 * Tyre marks: the black streaks a sliding car leaves behind it.
 *
 * Purely cosmetic and purely client-side. The server already sends everything needed to
 * know a car is sliding — its velocity and its orientation — so the sideways component is
 * a dot product here, and no bit of the wire format is spent on a decal.
 *
 * Marks come from a fixed pool used as a ring: the oldest is moved to the newest position
 * rather than destroyed. Entity churn is what kills a scene's frame rate, and a race on a
 * 1.5 km circuit would otherwise create thousands of them. The pool is big enough to carry
 * the marks of a corner or two, which is as long as anyone looks at them.
 *
 * Each mark is laid in the *chassis* frame, not the world one, so it follows the surface
 * the car is actually on: flat on the road, tilted on the ramps, and stuck to the
 * underside of the slab during the inverted run.
 */

import { engine, Entity, Material, MeshRenderer, Transform, VisibilityComponent } from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { CAR } from '../../shared/constants'
import { quatRotate } from '../../shared/math'
import { CarFlag } from '../../shared/protocol'
import type { SampledCar } from './net/snapshot-buffer'

/** How many marks exist at once, across every car. */
const POOL = 160
/** Sideways speed, in m/s, at which the tyres start to leave a mark. */
const SLIDE_SPEED = 3
/** Distance between marks along the slide. */
const SPACING = 1.1
/** Lifts the mark off the surface, so it does not fight the road for the same pixels. */
const LIFT = 0.04

const marks: Entity[] = []
let next = 0
/** Where each car last left a mark, so they are spaced along the slide, not per frame. */
const lastMark = new Map<number, Vector3>()

function create(): Entity {
  const entity = engine.addEntity()
  Transform.create(entity, { position: { x: 0, y: -100, z: 0 } })
  MeshRenderer.setPlane(entity)
  Material.setPbrMaterial(entity, {
    albedoColor: Color4.create(0.05, 0.05, 0.06, 1),
    roughness: 1,
    metallic: 0
  })
  VisibilityComponent.create(entity, { visible: false })
  return entity
}

function place(at: Vector3, rotation: Quaternion): void {
  if (marks.length < POOL) marks.push(create())
  const entity = marks[next]
  next = (next + 1) % POOL
  const transform = Transform.getMutable(entity)
  transform.position = at
  transform.rotation = rotation
  transform.scale = { x: 0.26, y: 1.3, z: 1 }
  const visibility = VisibilityComponent.getMutable(entity)
  if (!visibility.visible) visibility.visible = true
}

/** Lays a pair of marks behind one car if it is sliding and has moved far enough. */
export function updateSkidmarks(car: SampledCar): void {
  if ((car.flags & (CarFlag.Respawning | CarFlag.Airborne)) !== 0) {
    lastMark.delete(car.id)
    return
  }
  const right = quatRotate(car.rot, { x: 1, y: 0, z: 0 })
  const slide = Math.abs(car.vel.x * right.x + car.vel.y * right.y + car.vel.z * right.z)
  if (slide < SLIDE_SPEED) return

  const previous = lastMark.get(car.id)
  if (previous) {
    const moved = Math.sqrt(
      (car.pos.x - previous.x) ** 2 + (car.pos.y - previous.y) ** 2 + (car.pos.z - previous.z) ** 2
    )
    if (moved < SPACING) return
    // A jump from somewhere else entirely is a respawn we did not see; drop the trail
    // rather than drawing a stripe across the infield.
    if (moved > 12) {
      lastMark.set(car.id, { x: car.pos.x, y: car.pos.y, z: car.pos.z })
      return
    }
  }
  lastMark.set(car.id, { x: car.pos.x, y: car.pos.y, z: car.pos.z })

  // The plane's normal points along its own +Z, so it is turned to lie in the surface and
  // then carried into the chassis frame: a quarter turn about X, then the car's rotation.
  const flat = Quaternion.multiply(car.rot, Quaternion.fromEulerDegrees(-90, 0, 0))
  // The contact patch is found through the suspension, not at a fixed distance under the
  // car. The circuit is not flat — the asphalt sits on slabs, the ramps climb, the ceiling
  // run is nine metres up — and a constant drop buried every mark inside the road it was
  // supposed to be drawn on. `susp` is 0 fully extended, so the wheel hangs lowest at 0.
  for (const wheel of [2, 3]) {
    const anchor = CAR.wheelAnchors[wheel]
    const drop = CAR.suspensionRestLength * (1 - car.susp[wheel]) + CAR.wheelRadius - LIFT
    const local = quatRotate(car.rot, { x: anchor.x, y: anchor.y - drop, z: anchor.z })
    place({ x: car.pos.x + local.x, y: car.pos.y + local.y, z: car.pos.z + local.z }, flat)
  }
}
