/**
 * Chase camera and player lock.
 *
 * While driving, a VirtualCamera parented to the player's car takes over the main camera
 * and looks at the car, and InputModifier stops the avatar from walking off — WASD then
 * belongs to the car, not to the avatar, which is exactly what InputModifier exists for.
 * Release the car and the main camera reverts to the normal third-person view.
 *
 * The avatar itself is left where it stands rather than being teleported along with the
 * car every frame: `movePlayerTo` at 30 Hz reads as a stutter, and the camera is what
 * actually sells the driving.
 */

import {
  engine,
  Entity,
  InputModifier,
  MainCamera,
  Transform,
  VirtualCamera
} from '@dcl/sdk/ecs'

let anchor: Entity | null = null
let attachedTo: Entity | null = null

function ensureAnchor(): Entity {
  if (anchor !== null) return anchor
  const entity = engine.addEntity()
  Transform.create(entity, { position: { x: 0, y: 2.4, z: -7.5 } })
  VirtualCamera.create(entity, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.35) },
    fov: 75
  })
  anchor = entity
  return entity
}

/** Points the main camera at the chase rig behind `car` and locks avatar movement. */
export function attachTo(car: Entity): void {
  // Called every frame, so everything in here is behind a change check: each component
  // write is serialised to the renderer, and rewriting the camera 30 times a second is
  // pure traffic for no effect.
  if (attachedTo === car) return
  const rig = ensureAnchor()
  attachedTo = car
  const transform = Transform.getMutable(rig)
  transform.parent = car
  transform.position = { x: 0, y: 2.4, z: -7.5 }
  VirtualCamera.getMutable(rig).lookAtEntity = car
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: rig })
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: true })
  })
}

/** Gives the camera and the controls back to the avatar. */
export function detach(): void {
  if (attachedTo === null) return
  attachedTo = null
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: false })
  })
}

export function isAttached(): boolean {
  return attachedTo !== null
}
