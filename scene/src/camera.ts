/**
 * Chase camera and player lock.
 *
 * While driving, a VirtualCamera takes over the main camera and InputModifier stops the
 * avatar from walking off — WASD then belongs to the car, not to the avatar, which is
 * exactly what InputModifier exists for. Release the car and the main camera reverts to
 * the normal third-person view.
 *
 * The rig is not bolted to the car. It is a free entity that chases the car every frame
 * with some inertia, the way the third-person camera in an arcade racer does, because a
 * camera welded to the chassis makes the car a fixed decal on the screen and the world the
 * only thing that moves: no sense of weight, and no sense of the car turning. Four things
 * happen here, all driven by one smoothed "chase frame" that trails the car's orientation:
 *
 *  - rotation lag: the frame turns towards where the car points over a fraction of a
 *    second, so on turn-in the car swings on screen before the camera comes round;
 *  - position lag: the camera's position trails the spot the frame wants it in, which
 *    reads as the camera being pulled along behind the car, and pulled back as it speeds up;
 *  - look-ahead: at speed the frame is turned into the corner by the steering, so the road
 *    you are about to use is on screen rather than the kerb you are leaving;
 *  - drift: when the car is sliding, the frame follows the direction it is actually
 *    travelling in rather than the way its nose points, and the car shows its flank.
 *
 * The frame is a full orientation, not just a heading, so a car driving the ceiling run
 * upside down is chased upside down, as the old rigid rig did, only with the same lag.
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
import { Quaternion } from '@dcl/sdk/math'
import {
  clamp,
  quatFromAxisAngle,
  quatMultiply,
  quatRotate,
  quatSlerp,
  vadd,
  vdot,
  vscale,
  vsub,
  type Quat,
  type Vec3
} from '../../shared/math'
import type { SampledCar } from './net/snapshot-buffer'

const CHASE = {
  /** Where the camera sits in the chase frame: behind and above the chassis. */
  offset: { x: 0, y: 2.4, z: -7.5 },
  /** What it looks at, in the chase frame: a little above the chassis and ahead of it. */
  aim: { x: 0, y: 0.9, z: 1.5 },
  /**
   * Time constants of the two lags, in seconds. Rotation is the slow one, and it is what
   * you see: at 0.25 s a car cornering at 0.7 rad/s sits about ten degrees turned on the
   * screen. Position is kept tight so the car cannot leave the frame — at 0.06 s the
   * camera trails the chase point by about two metres at top speed, which is the pull-back
   * that says "fast" without the car shrinking to a dot.
   */
  rotationLag: 0.25,
  positionLag: 0.06,
  /**
   * Look-ahead, in radians of frame turn per radian of steering, once the car is going
   * fast enough for it to matter (below `lookAheadSpeed` it fades out, because at parking
   * speeds full lock is half a radian and the camera would swing round the car).
   */
  lookAhead: 0.8,
  lookAheadSpeed: 25,
  /**
   * How much of the slip angle the frame follows: 1 looks straight down the velocity and
   * shows the car at its full slip angle, 0 ignores the slide. The slip is clamped so a
   * spin does not whip the camera round, and ignored below `driftSpeed`, where the velocity
   * direction is noise.
   */
  driftFollow: 0.7,
  driftMaxSlip: Math.PI / 3,
  driftSpeed: 4,
  /** Further than this from where it should be, the camera cuts instead of flying: respawns. */
  snapDistance: 20
}

const LOCAL_UP: Vec3 = { x: 0, y: 1, z: 0 }
const LOCAL_FORWARD: Vec3 = { x: 0, y: 0, z: 1 }

let anchor: Entity | null = null
let attachedTo = -1
/** The smoothed chase frame and the camera's own position, carried between frames. */
let chaseRot: Quat = { x: 0, y: 0, z: 0, w: 1 }
let camPos: Vec3 = { x: 0, y: 0, z: 0 }

function ensureAnchor(): Entity {
  if (anchor !== null && Transform.has(anchor)) return anchor
  const entity = engine.addEntity()
  Transform.create(entity, { position: { x: 0, y: 2.4, z: -7.5 } })
  VirtualCamera.create(entity, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(1.0) },
    fov: 75
  })
  anchor = entity
  return entity
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

/** The fraction of the way to the target a first-order lag covers in `dt` seconds. */
function lagStep(dt: number, timeConstant: number): number {
  return 1 - Math.exp(-dt / timeConstant)
}

/**
 * The orientation the chase frame is heading for: the car's, turned about its own up axis
 * into the corner (look-ahead) and towards the direction it is sliding in (drift).
 */
function chaseTarget(car: SampledCar): Quat {
  const forward = quatRotate(car.rot, LOCAL_FORWARD)
  const up = quatRotate(car.rot, LOCAL_UP)
  const speed = Math.hypot(car.vel.x, car.vel.y, car.vel.z)

  let yaw = car.steer * CHASE.lookAhead * clamp(speed / CHASE.lookAheadSpeed, 0, 1)

  // Slip: the angle about the car's up axis from where it points to where it is going.
  // Measured in the car's own plane rather than the world's, so it means the same thing
  // on the ceiling as on the road.
  const planar = vsub(car.vel, vscale(up, vdot(car.vel, up)))
  const planarSpeed = Math.hypot(planar.x, planar.y, planar.z)
  if (planarSpeed > CHASE.driftSpeed) {
    const dir = vscale(planar, 1 / planarSpeed)
    const slip = Math.atan2(vdot(cross(forward, dir), up), vdot(forward, dir))
    yaw += clamp(slip, -CHASE.driftMaxSlip, CHASE.driftMaxSlip) * CHASE.driftFollow
  }

  return quatMultiply(car.rot, quatFromAxisAngle(LOCAL_UP, yaw))
}

/**
 * Chases `car` for one frame: takes the main camera and the controls on the first call
 * for a car, then moves the rig every frame. Call with the local car whenever there is one.
 */
export function follow(car: SampledCar, dt: number): void {
  const rig = ensureAnchor()
  const target = chaseTarget(car)
  let snap = false

  if (attachedTo !== car.id) {
    // Each component write is serialised to the renderer, so the hand-over happens once
    // per car rather than every frame.
    attachedTo = car.id
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: rig })
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({ disableAll: true })
    })
    snap = true
  }

  const wanted = vadd(car.pos, quatRotate(target, CHASE.offset))
  const away = vsub(wanted, camPos)
  if (Math.hypot(away.x, away.y, away.z) > CHASE.snapDistance) snap = true

  if (snap) {
    chaseRot = target
    camPos = wanted
  } else {
    chaseRot = quatSlerp(chaseRot, target, lagStep(dt, CHASE.rotationLag))
    const chasePoint = vadd(car.pos, quatRotate(chaseRot, CHASE.offset))
    camPos = vadd(camPos, vscale(vsub(chasePoint, camPos), lagStep(dt, CHASE.positionLag)))
  }

  // The camera looks from wherever the lag has left it, so the car stays in frame
  // however far behind the rig is; its up is the frame's, which is what keeps the
  // picture the right way up through a roll and upside down under the slab.
  const aim = vadd(car.pos, quatRotate(chaseRot, CHASE.aim))
  const transform = Transform.getMutable(rig)
  transform.position = camPos
  transform.rotation = Quaternion.fromLookAt(camPos, aim, quatRotate(chaseRot, LOCAL_UP))
}

/** Gives the camera and the controls back to the avatar. */
export function detach(): void {
  if (attachedTo === -1) return
  attachedTo = -1
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: false })
  })
}

export function isAttached(): boolean {
  return attachedTo !== -1
}
