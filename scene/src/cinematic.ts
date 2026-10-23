/**
 * The circuit's flyover, shown behind the lobby menu until the player starts the race.
 *
 * It has a virtual camera of its own rather than borrowing the chase rig in `camera.ts`:
 * the 1 s blend into the chase on START only happens when the main camera switches from
 * one virtual camera entity to another, so the flyover and the chase have to be two.
 * The shots loop and cut between each other; there is no clock to agree on, because
 * nobody else needs to see the same frame.
 */

import {
  engine,
  Entity,
  InputAction,
  inputSystem,
  MainCamera,
  PointerEventType,
  Transform,
  VirtualCamera
} from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { DEFAULT_FOV, gridCentre, splineAt, type IntroTrack, type Shot } from '../../shared/cinematic'
import type { Vec3 } from '../../shared/math'
import { detach } from './camera'

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 }

let flyRig: Entity | null = null
let flying = false
/** Space was pressed: the avatar has the camera until the menu is folded and opened again. */
let dismissed = false
let clock = 0
/** The shot on screen, so its fov is written once per shot and not every frame. */
let shotIndex = -1

function ensureRig(): Entity {
  if (flyRig !== null && Transform.has(flyRig)) return flyRig
  const entity = engine.addEntity()
  Transform.create(entity, { position: { x: 0, y: 0, z: 0 } })
  VirtualCamera.create(entity, { fov: DEFAULT_FOV })
  flyRig = entity
  return entity
}

/**
 * Runs the flyover for one frame. `eligible` is whether this player should be watching at
 * all (in the lobby, not a spectator); `menuOpen` is whether the menu is unfolded. Returns
 * true while the flyover owns the main camera, in which case the caller must leave the
 * camera alone. When it returns false after having been true, the camera is back on the
 * avatar.
 */
export function updateFlyover(eligible: boolean, menuOpen: boolean, track: IntroTrack & { intro: Shot[] }, dt: number): boolean {
  if (!eligible || !menuOpen) dismissed = false
  const want = eligible && menuOpen && !dismissed
  if (want && inputSystem.isTriggered(InputAction.IA_JUMP, PointerEventType.PET_DOWN)) dismissed = true

  if (!want || dismissed) {
    if (flying) {
      flying = false
      MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
    }
    return false
  }

  const entity = ensureRig()
  if (!flying) {
    flying = true
    clock = 0
    shotIndex = -1
    // Frees the controls if the chase still holds them from the last race.
    detach()
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: entity })
  }

  const shots = track.intro
  const total = shots.reduce((sum, s) => sum + s.seconds, 0)
  clock = (clock + dt) % total
  let t = clock
  let index = 0
  while (index < shots.length - 1 && t >= shots[index].seconds) {
    t -= shots[index].seconds
    index++
  }
  const shot = shots[index]
  const progress = Math.min(t / shot.seconds, 1)

  if (index !== shotIndex) {
    shotIndex = index
    VirtualCamera.getMutable(entity).fov = shot.fov ?? DEFAULT_FOV
  }

  const position = splineAt(shot.path, progress)
  const target =
    shot.look === 'cars' ? gridCentre(track.spawns) : Array.isArray(shot.look) ? splineAt(shot.look, progress) : shot.look
  const transform = Transform.getMutable(entity)
  transform.position = position
  transform.rotation = Quaternion.fromLookAt(position, target, WORLD_UP)
  return true
}
