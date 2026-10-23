/**
 * Dresses the circuit with the scenery kit (docs/contracts/kit.md) and streams it: every
 * piece exists from the moment the circuit is built, but only the sectors around the car,
 * in front of the camera, are switched on. Hooked into `buildTrack` / `clearTrack`.
 *
 * The layout is `decor-layout.ts`; this file is the engine side. Pieces carry no
 * colliders: the physics is the server's, and the avatar only collides with the road and
 * the buildings, which `track-render.ts` still builds as boxes.
 *
 * Measured on city (`npm run test:decor`, a car on every point of the racing line looking
 * along it): 1274 pieces in 155 streaming groups, at most 339 visible at once and 37 k
 * triangles, against budgets of 400 and 150 k. Parked, with the whole circle shown, the
 * worst case is 460. Barriers, kerbs and chevrons stop at 90 m rather than 160 m: city's
 * lap folds back on itself, and with the full radius the barriers alone were 390 pieces.
 */

import { engine, Entity, GltfContainer, Transform, VisibilityComponent } from '@dcl/sdk/ecs'
import { quatRotate } from '../../shared/math'
import type { Track } from '../../shared/tracks'
import { groupDecor, groupVisible, layoutDecor, type Group, type KitManifest } from './decor-layout'
import cityManifest from '../models/kit/city/manifest.json'
import neonManifest from '../models/kit/neon/manifest.json'

/** Kits that have been generated. A theme missing here is dressed with city's. */
const KITS: Record<string, KitManifest> = { city: cityManifest as KitManifest, neon: neonManifest as KitManifest }

const UPDATE_SECONDS = 0.25
/** Below this speed (m/s) the car counts as parked and the view is not cut to a cone. */
const PARKED_SPEED = 1
/** Logs the visible counts at most this often; development only. */
const REPORT_SECONDS = 5
const REPORT = true

let entities: Entity[] = []
let groups: Group[] = []
/** The entities of each group, in step with `groups`. */
let members: Entity[][] = []
let shown: boolean[] = []
let trisOf: number[] = []
let clock = 0
let lastFocus: { x: number; z: number } | null = null
let carFocus: { x: number; z: number } | null = null
let sinceReport = 0
let peak = { entities: 0, tris: 0 }
let installed = false

/** True during the intro flyover: the camera is nowhere near the car, so it is the focus. */
let cameraFocus = false
/** The local car's position while it is driving, null when it is not (the avatar is used). */
export function setDecorFocus(car: { x: number; z: number } | null, followCamera = false): void {
  carFocus = car
  cameraFocus = followCamera
}

export function decorate(track: Track): void {
  const theme = KITS[track.theme] ? track.theme : 'city'
  const items = layoutDecor(track, KITS[theme])
  groups = groupDecor(items)
  shown = groups.map(() => false)
  trisOf = groups.map((g) => g.tris)
  entities = []
  const entityOf: Entity[] = []
  for (const item of items) {
    const entity = engine.addEntity()
    entities.push(entity)
    entityOf.push(entity)
    Transform.create(entity, {
      position: { x: item.x, y: item.y, z: item.z },
      rotation: yawQuaternion(item.yaw),
      scale: { x: item.sx, y: item.sy, z: item.sz }
    })
    GltfContainer.create(entity, {
      src: `models/kit/${theme}/${item.piece}.glb`,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    VisibilityComponent.create(entity, { visible: false })
  }
  members = groups.map((g) => g.items.map((i) => entityOf[i]))
  clock = UPDATE_SECONDS
  lastFocus = null
  if (!installed) {
    installed = true
    engine.addSystem(streamSystem, 90, 'decor-stream')
  }
}

export function clearDecor(): void {
  for (const entity of entities) engine.removeEntity(entity)
  entities = []
  groups = []
  members = []
  shown = []
  trisOf = []
  peak = { entities: 0, tris: 0 }
}

function yawQuaternion(degrees: number): { x: number; y: number; z: number; w: number } {
  const half = (degrees * Math.PI) / 360
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
}

function streamSystem(dt: number): void {
  if (groups.length === 0) return
  clock += dt
  if (clock < UPDATE_SECONDS) return
  const elapsed = clock
  clock = 0

  const focus = cameraFocus ? cameraPosition() : carFocus ?? avatarPosition()
  if (focus === null) return
  const speed = lastFocus ? Math.hypot(focus.x - lastFocus.x, focus.z - lastFocus.z) / elapsed : 0
  lastFocus = { x: focus.x, z: focus.z }
  const heading = speed > PARKED_SPEED ? cameraHeading() : null

  let visibleEntities = 0
  let visibleTris = 0
  for (let i = 0; i < groups.length; i++) {
    const want = groupVisible(groups[i], focus.x, focus.z, heading)
    if (want) {
      visibleEntities += members[i].length
      visibleTris += trisOf[i]
    }
    // Each write travels to the renderer, so only the sectors that flipped get one.
    if (want === shown[i]) continue
    shown[i] = want
    for (const entity of members[i]) VisibilityComponent.getMutable(entity).visible = want
  }

  if (REPORT) {
    peak.entities = Math.max(peak.entities, visibleEntities)
    peak.tris = Math.max(peak.tris, visibleTris)
    sinceReport += elapsed
    if (sinceReport >= REPORT_SECONDS) {
      sinceReport = 0
      console.log(
        `[decor] visible ${visibleEntities} pieces / ${Math.round(visibleTris / 1000)}k tris (peak ${peak.entities} / ${Math.round(peak.tris / 1000)}k)`
      )
    }
  }
}

function cameraPosition(): { x: number; z: number } | null {
  const t = Transform.getOrNull(engine.CameraEntity)
  return t ? { x: t.position.x, z: t.position.z } : null
}

function avatarPosition(): { x: number; z: number } | null {
  const t = Transform.getOrNull(engine.PlayerEntity)
  return t ? { x: t.position.x, z: t.position.z } : null
}

/** Where the camera looks, flattened onto the ground. Null if it points straight up or down. */
function cameraHeading(): { x: number; z: number } | null {
  const t = Transform.getOrNull(engine.CameraEntity)
  if (!t) return null
  const f = quatRotate(t.rotation, { x: 0, y: 0, z: 1 })
  const len = Math.hypot(f.x, f.z)
  return len < 0.1 ? null : { x: f.x / len, z: f.z / len }
}
