/**
 * Minimal vector/quaternion helpers shared by the server and the scene.
 *
 * Why this file exists instead of using each engine's own math library:
 * the track is authored once as euler angles in degrees, and both Rapier (server)
 * and Decentraland (client) have to turn those degrees into the *same* quaternion.
 * `quatFromEulerDegrees` is a literal port of `Quaternion.fromEulerDegrees` from
 * @dcl/ecs-math (Unity's yaw-pitch-roll order), so the collider the server
 * simulates and the box the client draws always line up.
 *
 * Note on handedness: Decentraland is left-handed and Rapier is right-handed, but
 * their rotation matrices are numerically identical for the same (x, y, z, w) and
 * the same euler order, and the whole world is authored in one shared numeric space.
 * So positions and quaternions travel over the wire unconverted.
 */

export type Vec3 = { x: number; y: number; z: number }
export type Quat = { x: number; y: number; z: number; w: number }

const DEG2RAD = Math.PI / 180

/** Port of @dcl/ecs-math Quaternion.fromEulerDegrees (yaw/pitch/roll, Unity order). */
export function quatFromEulerDegrees(x: number, y: number, z: number): Quat {
  const halfPitch = x * DEG2RAD * 0.5
  const halfYaw = y * DEG2RAD * 0.5
  const halfRoll = z * DEG2RAD * 0.5
  const c1 = Math.cos(halfPitch)
  const c2 = Math.cos(halfYaw)
  const c3 = Math.cos(halfRoll)
  const s1 = Math.sin(halfPitch)
  const s2 = Math.sin(halfYaw)
  const s3 = Math.sin(halfRoll)
  return {
    x: c2 * s1 * c3 + s2 * c1 * s3,
    y: s2 * c1 * c3 - c2 * s1 * s3,
    z: c2 * c1 * s3 - s2 * s1 * c3,
    w: c2 * c1 * c3 + s2 * s1 * s3
  }
}

export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 }
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  }
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
  if (l === 0) return quatIdentity()
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }
}

/** Rotates `v` by `q`. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const { x, y, z, w } = q
  const ix = w * v.x + y * v.z - z * v.y
  const iy = w * v.y + z * v.x - x * v.z
  const iz = w * v.z + x * v.y - y * v.x
  const iw = -x * v.x - y * v.y - z * v.z
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x
  }
}

/** Shortest-arc spherical interpolation, used by the client's snapshot buffer. */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  if (cos < 0) {
    cos = -cos
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  if (cos > 0.9995) {
    return quatNormalize({
      x: a.x + (bx - a.x) * t,
      y: a.y + (by - a.y) * t,
      z: a.z + (bz - a.z) * t,
      w: a.w + (bw - a.w) * t
    })
  }
  const theta = Math.acos(cos)
  const sinTheta = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / sinTheta
  const wb = Math.sin(t * theta) / sinTheta
  return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb }
}

/** Rotation that turns `from` into `to`, used to build the trick target orientations. */
export function quatFromAxisAngle(axis: Vec3, radians: number): Quat {
  const l = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z) || 1
  const s = Math.sin(radians / 2)
  return { x: (axis.x / l) * s, y: (axis.y / l) * s, z: (axis.z / l) * s, w: Math.cos(radians / 2) }
}

export function quatConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w }
}

/** Yaw (degrees) around +Y extracted from a quaternion, for respawns and HUD compass. */
export function yawDegrees(q: Quat): number {
  const f = quatRotate(q, { x: 0, y: 0, z: 1 })
  return Math.atan2(f.x, f.z) / DEG2RAD
}

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

export function vadd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

export function vsub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

export function vscale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s }
}

export function vdot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function vlen(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}

export function vlenXZ(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.z * a.z)
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Moves `current` toward `target` at most `maxDelta`. Used for steering and charge ramps. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current
  if (Math.abs(d) <= maxDelta) return target
  return current + Math.sign(d) * maxDelta
}
