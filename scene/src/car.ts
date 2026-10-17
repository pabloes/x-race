/**
 * Car visuals, driven purely by interpolated snapshot state.
 *
 * Each car is a root entity carrying the chassis transform straight from the server, with
 * the body, cabin, wheels and the thruster flames parented to it so they follow for free.
 * The wheels read their own local Y from the per-wheel suspension travel in the snapshot
 * and spin/steer from the two angles the server sends, which is enough to make the car look
 * like it is reacting to the surface without the client simulating anything.
 *
 * Three sets of nozzles, one per thing the car can do with its charge, so you can tell at a
 * glance which one is firing:
 *  - rear flare while boosting, pushing the car forward (double-tap W);
 *  - four belly nozzles while the thrusters hold the car up — they point where the force
 *    comes from, straight below the car. Those same nozzles show a small pilot flame
 *    whenever the car is falling, before you touch Space: it reads as the pack idling and
 *    it tells you where the thrust will come from when you do press it. The pilot flame is
 *    decoration only — the car is falling under plain gravity until the server sees the
 *    Thrust bit;
 *  - two flank nozzles instead of those while the car is inverted: with the belly pressed
 *    against the ceiling there is nowhere below to exhaust into, so the attitude jets that
 *    keep it pinned are the ones that show.
 *
 * Entities are pooled per player id: a car that leaves the race is hidden rather than
 * destroyed, so a rejoin does not churn the entity list.
 */

import { engine, Entity, Material, MeshRenderer, Transform, VisibilityComponent } from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { CAR } from '../../shared/constants'
import { CarFlag } from '../../shared/protocol'
import type { SampledCar } from './net/snapshot-buffer'

/** Distinct body colours so cars are told apart at a glance. */
const LIVERIES = [
  Color4.create(0.75, 0.05, 0.08, 1),
  Color4.create(0.05, 0.3, 0.8, 1),
  Color4.create(0.95, 0.75, 0.05, 1),
  Color4.create(0.1, 0.65, 0.3, 1),
  Color4.create(0.6, 0.1, 0.7, 1),
  Color4.create(0.95, 0.45, 0.05, 1),
  Color4.create(0.1, 0.7, 0.75, 1),
  Color4.create(0.85, 0.85, 0.9, 1)
]

type CarVisual = {
  root: Entity
  wheels: Entity[]
  /** Rear flare: boost. */
  flare: Entity
  /** Downward nozzles under the chassis: thrusters with the car the right way up. */
  belly: Entity[]
  /** Pilot flames inside the belly nozzles, lit while falling. */
  pilots: Entity[]
  /** Flank nozzles: the attitude jets that hold the car against the ceiling. */
  flanks: Entity[]
  /** Last written visibility, so the component is only touched when it changes. */
  visible: boolean
  flareOn: boolean
  bellyOn: boolean
  pilotsOn: boolean
  flanksOn: boolean
}

const cars = new Map<number, CarVisual>()

function box(parent: Entity, position: { x: number; y: number; z: number }, scale: { x: number; y: number; z: number }, colour: Color4, emissive = 0): Entity {
  const entity = engine.addEntity()
  Transform.create(entity, { parent, position, scale })
  MeshRenderer.setBox(entity)
  Material.setPbrMaterial(entity, {
    albedoColor: colour,
    emissiveColor: emissive > 0 ? colour : undefined,
    emissiveIntensity: emissive,
    roughness: 0.35,
    metallic: 0.5
  })
  return entity
}

/** Fall speed, in m/s, at which the belly nozzles light their pilot flame. */
const PILOT_FALL_SPEED = 2.5

/** One thruster flame: an emissive box, hidden until the matching flag arrives. */
function jet(
  parent: Entity,
  position: { x: number; y: number; z: number },
  scale: { x: number; y: number; z: number },
  intensity = 4,
  alpha = 0.8
): Entity {
  const entity = engine.addEntity()
  Transform.create(entity, { parent, position, scale })
  MeshRenderer.setBox(entity)
  Material.setPbrMaterial(entity, {
    albedoColor: Color4.create(0.55, 0.9, 1, alpha),
    emissiveColor: Color4.create(0.35, 0.85, 1, 1),
    emissiveIntensity: intensity
  })
  VisibilityComponent.create(entity, { visible: false })
  return entity
}

function create(id: number): CarVisual {
  const root = engine.addEntity()
  Transform.create(root, { position: { x: 0, y: -50, z: 0 } })

  const livery = LIVERIES[(id - 1 + LIVERIES.length) % LIVERIES.length]
  const h = CAR.halfExtents
  // Low wide body with a cabin wedge on top: a Roadster silhouette from two boxes.
  box(root, { x: 0, y: 0, z: 0 }, { x: h.x * 2, y: h.y * 2 * 0.8, z: h.z * 2 }, livery)
  box(root, { x: 0, y: h.y * 0.9, z: -0.25 }, { x: h.x * 1.6, y: h.y * 1.1, z: h.z * 0.95 }, Color4.create(0.05, 0.06, 0.08, 1))
  // Front splitter and rear wing, for a sense of direction at a distance.
  box(root, { x: 0, y: -h.y * 0.5, z: h.z * 0.98 }, { x: h.x * 2, y: 0.12, z: 0.5 }, Color4.create(0.05, 0.05, 0.06, 1))
  box(root, { x: 0, y: h.y * 1.2, z: -h.z * 0.95 }, { x: h.x * 1.9, y: 0.1, z: 0.6 }, Color4.create(0.05, 0.05, 0.06, 1))
  // Tail lights.
  box(root, { x: 0, y: 0, z: -h.z - 0.03 }, { x: h.x * 1.4, y: 0.16, z: 0.06 }, Color4.create(1, 0.1, 0.05, 1), 1.5)

  const wheels: Entity[] = []
  for (const anchor of CAR.wheelAnchors) {
    const wheel = engine.addEntity()
    Transform.create(wheel, {
      parent: root,
      position: anchor,
      scale: { x: 0.28, y: CAR.wheelRadius * 2, z: CAR.wheelRadius * 2 }
    })
    MeshRenderer.setBox(wheel)
    Material.setPbrMaterial(wheel, { albedoColor: Color4.create(0.06, 0.06, 0.07, 1), roughness: 0.9 })
    wheels.push(wheel)
  }

  // Boost flare behind the car, shown only while boosting.
  const flare = engine.addEntity()
  Transform.create(flare, {
    parent: root,
    position: { x: 0, y: -0.1, z: -h.z - 0.6 },
    scale: { x: 0.7, y: 0.4, z: 1.2 }
  })
  MeshRenderer.setBox(flare)
  Material.setPbrMaterial(flare, {
    albedoColor: Color4.create(0.3, 0.8, 1, 0.75),
    emissiveColor: Color4.create(0.3, 0.85, 1, 1),
    emissiveIntensity: 4
  })
  VisibilityComponent.create(flare, { visible: false })

  // Belly nozzles, one at each corner of the floorpan, firing straight down, each with a
  // stub of a pilot flame tucked inside it for the idle state.
  const belly: Entity[] = []
  const pilots: Entity[] = []
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = h.x * 0.6 * sx
      const z = h.z * 0.55 * sz
      belly.push(jet(root, { x, y: -h.y * 0.8 - 0.42, z }, { x: 0.22, y: 0.85, z: 0.22 }))
      pilots.push(jet(root, { x, y: -h.y * 0.8 - 0.14, z }, { x: 0.13, y: 0.28, z: 0.13 }, 1.4, 0.5))
    }
  }

  // Flank nozzles, just behind the doors, firing sideways.
  const flanks = [-1, 1].map((side) =>
    jet(root, { x: (h.x + 0.42) * side, y: 0, z: -h.z * 0.15 }, { x: 0.8, y: 0.2, z: 0.2 })
  )

  const visual: CarVisual = {
    root,
    wheels,
    flare,
    belly,
    pilots,
    flanks,
    visible: true,
    flareOn: false,
    bellyOn: false,
    pilotsOn: false,
    flanksOn: false
  }
  cars.set(id, visual)
  return visual
}

export function carRoot(id: number): Entity | null {
  const visual = cars.get(id)
  return visual ? visual.root : null
}

/** Applies one sampled snapshot to the matching car, creating it on first sight. */
export function renderCar(car: SampledCar): void {
  const visual = cars.get(car.id) ?? create(car.id)
  const rootTransform = Transform.getMutable(visual.root)
  rootTransform.position = car.pos
  rootTransform.rotation = car.rot

  // Visibility is only written when it actually flips: every component write is
  // serialised to the renderer, so touching it 60 times a second is wasted traffic.
  const visible = (car.flags & CarFlag.Respawning) === 0
  setVisible(visual, visible)

  for (let i = 0; i < visual.wheels.length; i++) {
    const anchor = CAR.wheelAnchors[i]
    const transform = Transform.getMutable(visual.wheels[i])
    // Suspension travel: 0 is fully extended, so the wheel sits lowest at 0.
    const drop = CAR.suspensionRestLength * (1 - car.susp[i]) * 0.6
    transform.position = { x: anchor.x, y: anchor.y - drop, z: anchor.z }
    // Front wheels steer; all four spin. Wheel boxes are long on Z, so the spin is
    // applied about their own X axis and the steer about Y.
    const steerDegrees = i < 2 ? (car.steer * 180) / Math.PI : 0
    transform.rotation = Quaternion.multiply(
      Quaternion.fromEulerDegrees(0, steerDegrees, 0),
      Quaternion.fromEulerDegrees((car.spin * 180) / Math.PI, 0, 0)
    )
  }

  const flareOn = (car.flags & CarFlag.Boosting) !== 0 && visible
  if (visual.flareOn !== flareOn) {
    visual.flareOn = flareOn
    VisibilityComponent.getMutable(visual.flare).visible = flareOn
  }

  // Thrusters: belly jets normally, flank jets while inverted. Only one set at a time, so
  // the flames always read as the force that is actually holding the car where it is.
  const thrusting = (car.flags & CarFlag.Thrusting) !== 0 && visible
  const inverted = (car.flags & CarFlag.Inverted) !== 0
  const bellyOn = thrusting && !inverted
  const flanksOn = thrusting && inverted
  // Falling with the pack idle: a stub of flame, so you can see where the thrust is about
  // to come from before you ask for it. The full jets take over the moment you do.
  const airborne = (car.flags & CarFlag.Airborne) !== 0
  const pilotsOn = visible && airborne && !inverted && !thrusting && car.vel.y < -PILOT_FALL_SPEED
  if (visual.bellyOn !== bellyOn) {
    visual.bellyOn = bellyOn
    for (const entity of visual.belly) VisibilityComponent.getMutable(entity).visible = bellyOn
  }
  if (visual.pilotsOn !== pilotsOn) {
    visual.pilotsOn = pilotsOn
    for (const entity of visual.pilots) VisibilityComponent.getMutable(entity).visible = pilotsOn
  }
  if (visual.flanksOn !== flanksOn) {
    visual.flanksOn = flanksOn
    for (const entity of visual.flanks) VisibilityComponent.getMutable(entity).visible = flanksOn
  }
}

function setVisible(visual: CarVisual, visible: boolean): void {
  if (visual.visible === visible) return
  visual.visible = visible
  if (VisibilityComponent.has(visual.root)) VisibilityComponent.getMutable(visual.root).visible = visible
  else VisibilityComponent.create(visual.root, { visible })
}

/** Hides any car that was not in this frame's snapshot (left the race). */
export function hideMissing(present: Map<number, SampledCar>): void {
  for (const [id, visual] of cars) {
    if (!present.has(id)) setVisible(visual, false)
  }
}
