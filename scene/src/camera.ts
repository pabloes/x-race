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
 *    second, so on turn-in the car swings on screen before the camera comes round, and
 *    the camera, offset in that frame, swings out wide with it;
 *  - pull-back: the camera sits further back the faster the car goes;
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
   * Time constant of the rotation lag, in seconds: at 0.25 s a car cornering at 0.7 rad/s
   * sits about ten degrees turned on the screen. There is deliberately no lag on the
   * position itself. The camera is always `offset` from the car's sampled position, in
   * the lagged frame, so whatever the network does to that position — a late snapshot, an
   * extrapolation being corrected — the camera does with it and nothing is seen to move.
   * A first version lagged the absolute position too, and every such correction showed as
   * the car jolting against the camera.
   */
  rotationLag: 0.25,
  /**
   * The pull-back with speed that the position lag used to give for free: metres of extra
   * distance per metre per second, about two metres at top speed.
   */
  pullbackPerMps: 0.05,
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
  driftSpeed: 4
}

const LOCAL_UP: Vec3 = { x: 0, y: 1, z: 0 }
const LOCAL_FORWARD: Vec3 = { x: 0, y: 0, z: 1 }

let anchor: Entity | null = null
let attachedTo = -1
/** The smoothed chase frame, carried between frames. */
let chaseRot: Quat = { x: 0, y: 0, z: 0, w: 1 }

function ensureAnchor(): Entity {
  if (anchor !== null && Transform.has(anchor)) return anchor
  const entity = engine.addEntity()
  Transform.create(entity, { position: { x: 0, y: 2.4, z: -7.5 } })
  VirtualCamera.create(entity, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.35) },
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

  if (attachedTo !== car.id) {
    // Each component write is serialised to the renderer, so the hand-over happens once
    // per car rather than every frame. The frame starts where the car points: no swing
    // in from wherever the last car left it.
    attachedTo = car.id
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: rig })
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({ disableAll: true })
    })
    chaseRot = target
  } else {
    chaseRot = quatSlerp(chaseRot, target, lagStep(dt, CHASE.rotationLag))
  }

  // Anchored to the car, offset in the lagged frame: the lateral swing on turn-in comes
  // from the frame turning late, not from the camera being left behind. A respawn moves
  // the car and the camera together, so there is nothing to snap.
  const speed = Math.hypot(car.vel.x, car.vel.y, car.vel.z)
  const offset = { x: CHASE.offset.x, y: CHASE.offset.y, z: CHASE.offset.z - speed * CHASE.pullbackPerMps }
  const camPos = vadd(car.pos, quatRotate(chaseRot, offset))

  // The camera looks along the lagged frame, a little ahead of the car; its up is the
  // frame's, which is what keeps the picture the right way up through a roll and upside
  // down under the slab.
  const aim = vadd(car.pos, quatRotate(chaseRot, CHASE.aim))
  const transform = Transform.getMutable(rig)
  transform.position = camPos
  transform.rotation = Quaternion.fromLookAt(camPos, aim, quatRotate(chaseRot, LOCAL_UP))
}

/**
 * The virtual camera entity itself, for the pre-race cinematic to drive while the chase
 * is not running. Whoever moves it must stop before `follow` is called again.
 */
export function rig(): Entity {
  return ensureAnchor()
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
