/**
 * Car visuals, driven purely by interpolated snapshot state.
 *
 * Each car is a root entity carrying the chassis transform straight from the server, with
 * the body model, the four wheels and the thruster plumes parented to it so they follow
 * for free. Body, wheels and plumes are glTF files built by the Blender scripts in
 * `tesla-roadster-dcl/v2/scripts`. The plumes carry their own looping animation (gas core
 * pulsing, smoke puffs streaming out of each nozzle), so showing a jet is playing a clip
 * rather than moving anything from here.
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
 *    keep it pinned are the ones that show. They also fire through a barrel roll or a
 *    flip, where the rotation comes from the server and these are the jets doing it.
 *
 * Entities are pooled per player id: a car that leaves the race is hidden rather than
 * destroyed, so a rejoin does not churn the entity list.
 */

import {
  Animator,
  Billboard,
  BillboardMode,
  ColliderLayer,
  engine,
  Entity,
  GltfContainer,
  TextShape,
  Transform,
  VisibilityComponent
} from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { CAR } from '../../shared/constants'
import type { Vec3 } from '../../shared/math'
import { CarFlag, type PlayerInfo } from '../../shared/protocol'
import type { SampledCar } from './net/snapshot-buffer'

/**
 * The car, as models: the 2026 Roadster built and baked by `tesla-roadster-dcl/v2/scripts`
 * (`export.py` writes these files), the body as one piece and each wheel on its own hub.
 *
 * A glTF carries its own materials and the scene cannot override them, so telling cars
 * apart by colour means a file per colour rather than a tint at runtime.
 */
const LIVERY_COUNT = 1
const BODY_MODEL = (_id: number): string => 'models/rdstr-body.glb'

/**
 * Where each wheel sits, straight out of the model. These are the model's own hubs rather
 * than `CAR.wheelAnchors`, which are where the *simulation* puts its wheels: using the
 * physics anchors would park the visible wheels a few centimetres outside the arches they
 * belong in. The suspension travel from the snapshot is applied on top of these.
 */
const WHEELS = [
  { model: 'models/rdstr-wheel-l.glb', at: { x: -0.84, y: -0.265, z: 1.435 } },
  { model: 'models/rdstr-wheel-r.glb', at: { x: 0.84, y: -0.265, z: 1.435 } },
  { model: 'models/rdstr-wheel-l.glb', at: { x: -0.84, y: -0.265, z: -1.435 } },
  { model: 'models/rdstr-wheel-r.glb', at: { x: 0.84, y: -0.265, z: -1.435 } }
]

/**
 * How far below the server's chassis origin the body is drawn.
 *
 * The model is built with its origin 0.65 m above the contact patch, but the chassis
 * collider settles 0.84 m above the road on its springs (measured: y = 0.943 at rest on
 * asphalt at 0.1). The wheels are not the problem — they follow the suspension travel in
 * the snapshot and sit on the road either way — so drawn at the collider's height the body
 * floated clear of its own arches. This brings it down onto them: the wheels at rest sit
 * 0.176 m below where the model expects them, and the body follows. The plumes come down
 * with the body, because their nozzles are placed in its frame.
 */
const BODY_DROP = 0.18

/**
 * The cold-gas plumes, one file per group of nozzles that fires together, each a looping
 * `boost` clip (the belly set also has the smaller `pilot` clip). A group is a single
 * entity: one model, one animator, a couple of draw calls, however many nozzles it holds.
 * The nozzle positions are baked into the files, straight off the body model.
 */
const JETS = {
  rear: 'models/rdstr-jets-rear.glb',
  belly: 'models/rdstr-jets-belly.glb',
  flank: 'models/rdstr-jets-flank.glb'
}

type JetClip = '' | 'boost' | 'pilot'

type CarVisual = {
  root: Entity
  wheels: Entity[]
  /** Rear plumes: boost. */
  flare: Entity
  /** Downward plumes under the chassis: thrusters with the car the right way up. */
  belly: Entity
  /** Flank plumes: the attitude jets that hold the car against the ceiling. */
  flanks: Entity
  /** Name tag floating over the car. Not parented: see `create`. */
  label: Entity
  /** What the tag currently says, so the text is only written when it changes. */
  name: string
  labelOn: boolean
  /** Last written visibility, so the component is only touched when it changes. */
  visible: boolean
  flareOn: boolean
  /** Which clip the belly set is playing, '' for off: boost (retro burn) or pilot (idling). */
  bellyClip: JetClip
  flanksOn: boolean
}

const cars = new Map<number, CarVisual>()

/**
 * Who is driving which car, and which car is ours.
 *
 * Names are not in the snapshot — they do not change sixty times a second — so they come
 * from the room's player list, which the connection hands over whenever it changes. A car
 * whose id is not in the list yet simply has no tag until the next list arrives.
 */
const names = new Map<number, string>()
let localId = -1

/** The room's drivers, and our own id, so our own car can go untagged. */
export function setDriverNames(players: PlayerInfo[], meId: number): void {
  localId = meId
  names.clear()
  for (const p of players) names.set(p.id, p.name)
}

/** How far above the chassis the name tag floats. */
const LABEL_HEIGHT = CAR.halfExtents.y + 1.3

/** Fall speed, in m/s, at which the belly nozzles light their pilot flame. */
const PILOT_FALL_SPEED = 2.5

/** One group of plumes: an animated model at the chassis origin, hidden until a flag lights it. */
function jets(parent: Entity, src: string, clips: JetClip[]): Entity {
  const entity = engine.addEntity()
  Transform.create(entity, { parent, position: { x: 0, y: -BODY_DROP, z: 0 } })
  GltfContainer.create(entity, {
    src,
    visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
  })
  Animator.create(entity, { states: clips.map((clip) => ({ clip, playing: false, loop: true })) })
  VisibilityComponent.create(entity, { visible: false })
  return entity
}

/**
 * Lights a group with the given clip, or puts it out. Hidden plumes also stop animating:
 * the renderer would keep sampling the clip for nothing.
 */
function setJet(entity: Entity, clip: JetClip): void {
  if (clip === '') {
    Animator.stopAllAnimations(entity, true)
  } else {
    Animator.playSingleAnimation(entity, clip, true)
  }
  VisibilityComponent.getMutable(entity).visible = clip !== ''
}

/**
 * The body and the four wheels, parented to `root`: the body `bodyY` below the root's
 * origin, the wheels on the model's own hubs. Returns the wheels in `WHEELS` order.
 *
 * Colliders are switched off on purpose: the server owns every collision in this game, and
 * a car with colliders would also shove the avatar of anyone standing next to it.
 */
function bodywork(root: Entity, id: number, bodyY: number): Entity[] {
  // The body, including its glass and its light bars, as one model.
  const body = engine.addEntity()
  Transform.create(body, { parent: root, position: { x: 0, y: bodyY, z: 0 } })
  GltfContainer.create(body, {
    src: BODY_MODEL(id),
    visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
  })

  // Wheels are their own entities so they can spin and steer on their own transforms,
  // which has nothing to do with the physics: the angles come from the snapshot.
  const wheels: Entity[] = []
  for (const spec of WHEELS) {
    const wheel = engine.addEntity()
    Transform.create(wheel, { parent: root, position: spec.at })
    GltfContainer.create(wheel, {
      src: spec.model,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
    })
    wheels.push(wheel)
  }
  return wheels
}

/**
 * A Roadster standing still, for looking at: body and wheels at the model's own height,
 * no plumes, no tag, nothing that needs a snapshot. `position` is where the chassis origin
 * goes, which the model puts 0.65 m above whatever the car is parked on.
 */
export function parkCar(position: Vec3, yaw: number): void {
  const root = engine.addEntity()
  Transform.create(root, { position, rotation: Quaternion.fromEulerDegrees(0, yaw, 0) })
  bodywork(root, 0, 0)
}

function create(id: number): CarVisual {
  const root = engine.addEntity()
  Transform.create(root, { position: { x: 0, y: -50, z: 0 } })
  // The root carries no mesh of its own, so hiding it only means anything with
  // `propagateToChildren`: without it the body and the wheels keep rendering and a car
  // that has left the race stays parked on the grid. The jets below set their own
  // visibility, which overrides what they inherit — they are driven by their flags, and
  // every one of those is already ANDed with the car being visible at all.
  VisibilityComponent.create(root, { visible: true, propagateToChildren: true })

  const wheels = bodywork(root, id, -BODY_DROP)

  // Boost plumes out of the four diffuser nozzles, shown only while boosting.
  const flare = jets(root, JETS.rear, ['boost'])

  // Belly plumes, one at each of the four underbody nozzle rings, firing straight down; the
  // same file carries the stub of a pilot flame for the idle state.
  const belly = jets(root, JETS.belly, ['boost', 'pilot'])

  // Flank plumes, out of the sills just behind the doors. Angled down and out rather than
  // straight sideways: these are what rolls the car, and gas thrown flat out of the side of
  // a car reads as nothing in particular, while the same jet pointing under it reads as the
  // thing levering that side of the car upward.
  const flanks = jets(root, JETS.flank, ['boost'])

  // Name tag. Deliberately *not* parented to the car: a child rides the chassis, and this
  // chassis barrel rolls and spends whole seconds upside down under the ceiling slab,
  // which would swing the tag under the car and round the back of it. Unparented, its
  // position is written from the same snapshot every frame and the tag simply stays the
  // same height above the car, whatever the car is doing.
  const label = engine.addEntity()
  Transform.create(label, { position: { x: 0, y: -50, z: 0 } })
  TextShape.create(label, {
    text: '',
    fontSize: 3,
    textColor: Color4.White(),
    // An outline, because a white name over a white-ish sky or a pale wall is unreadable
    // exactly when you most want to know who you are about to hit.
    outlineWidth: 0.2,
    outlineColor: Color4.Black()
  })
  // Around Y only: the tag turns to face the camera but stays level, so a name never
  // arrives tilted or upside down when the car it belongs to is.
  Billboard.create(label, { billboardMode: BillboardMode.BM_Y })
  VisibilityComponent.create(label, { visible: false })

  const visual: CarVisual = {
    root,
    wheels,
    flare,
    belly,
    flanks,
    label,
    name: '',
    labelOn: false,
    visible: true,
    flareOn: false,
    bellyClip: '',
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
    const anchor = WHEELS[i].at
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
    setJet(visual.flare, flareOn ? 'boost' : '')
  }

  // Thrusters: belly jets normally, flank jets while inverted. Only one set at a time, so
  // the flames always read as the force that is actually holding the car where it is.
  const thrusting = (car.flags & CarFlag.Thrusting) !== 0 && visible
  const inverted = (car.flags & CarFlag.Inverted) !== 0
  // The same attitude jets fire through a trick, because they are what is turning the
  // car: a barrel roll or a flip is the server rotating the chassis on the spot, and
  // without them the car span with nothing to show for it, which read as an animation
  // playing rather than as the car doing something.
  const tricking = (car.flags & CarFlag.Tricking) !== 0
  const flanksOn = visible && (tricking || (thrusting && inverted))
  // Coming down. Two stages, and they are not decoration for its own sake: the second one
  // is the landing assist actually firing on the server, so what you see is what is
  // holding the car flat and slowing the fall.
  //  - falling gently: a stub of pilot flame, telling you where the thrust will come from;
  //  - falling hard enough for the assist: the full belly jets, as the retro burn.
  const airborne = (car.flags & CarFlag.Airborne) !== 0
  const falling = visible && airborne && !inverted && !thrusting
  const landingBurn = falling && car.vel.y < -CAR.landingFallSpeed
  const pilotsOn = falling && !landingBurn && car.vel.y < -PILOT_FALL_SPEED
  const bellyOn = (thrusting && !inverted) || landingBurn
  const bellyClip: JetClip = bellyOn ? 'boost' : pilotsOn ? 'pilot' : ''
  if (visual.bellyClip !== bellyClip) {
    visual.bellyClip = bellyClip
    setJet(visual.belly, bellyClip)
  }
  if (visual.flanksOn !== flanksOn) {
    visual.flanksOn = flanksOn
    setJet(visual.flanks, flanksOn ? 'boost' : '')
  }

  // Name tag: every car but our own. Ours is the one the camera sits behind, where a tag
  // is a sticker on the inside of the windscreen.
  const name = car.id === localId ? '' : (names.get(car.id) ?? '')
  if (visual.name !== name) {
    visual.name = name
    TextShape.getMutable(visual.label).text = name
  }
  const labelOn = visible && name !== ''
  if (visual.labelOn !== labelOn) {
    visual.labelOn = labelOn
    VisibilityComponent.getMutable(visual.label).visible = labelOn
  }
  // Only while it is on screen: a hidden tag that keeps being moved is pure traffic.
  if (labelOn) {
    Transform.getMutable(visual.label).position = {
      x: car.pos.x,
      y: car.pos.y + LABEL_HEIGHT,
      z: car.pos.z
    }
  }
}

function setVisible(visual: CarVisual, visible: boolean): void {
  if (visual.visible === visible) return
  visual.visible = visible
  VisibilityComponent.getMutable(visual.root).visible = visible
}

/**
 * Destroys any car that was not in this frame's snapshot: a bot that was removed, a player
 * who left, anyone who went to the stands.
 *
 * Destroyed rather than hidden and kept, because ids are handed out by the server and
 * never reused: a pool keyed by id would grow by seventeen entities every time a bot is
 * added and taken away again, and none of them would ever be claimed. A car coming back
 * from the stands is a fresh id too, so it is built again — the models are already in the
 * explorer's cache by then.
 */
export function dropMissing(present: Map<number, SampledCar>): void {
  for (const [id, visual] of cars) {
    if (present.has(id)) continue
    // The wheels, the jets and the audio sources all hang off the root.
    engine.removeEntityWithChildren(visual.root)
    // The name tag does not: it is parented to nothing, so it has to be taken down here.
    engine.removeEntity(visual.label)
    cars.delete(id)
  }
}
