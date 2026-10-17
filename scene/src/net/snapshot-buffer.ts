/**
 * Snapshot interpolation buffer — the client half of the fixed-timestep model.
 *
 * The server simulates at 60 Hz and ships a snapshot every third tick (20 Hz) stamped
 * with its own clock. This buffer keeps the last second of those snapshots and renders
 * the world at `serverNow - INTERPOLATION_DELAY_MS`, which is deliberately in the past:
 * at any render frame there are already two snapshots bracketing that instant, so every
 * car is *interpolated between two known states* rather than guessed at. That is what
 * makes remote cars perfectly smooth at an arbitrary frame rate while the authoritative
 * simulation stays on its fixed tick.
 *
 * Two edge cases matter:
 *  - If the newest snapshot is older than the render time (a late or lost packet), cars
 *    are dead-reckoned from their last known velocity, but only for MAX_EXTRAPOLATION_MS;
 *    past that the world holds still rather than drifting somewhere invented.
 *  - A car that appears or disappears between two snapshots is not interpolated into or
 *    out of existence; it simply uses whichever snapshot has it.
 */

import {
  INTERPOLATION_DELAY_MS,
  LOCAL_INTERPOLATION_DELAY_MS,
  MAX_EXTRAPOLATION_MS,
  SNAPSHOT_BUFFER_MS
} from '../../../shared/constants'
import { quatSlerp, type Quat, type Vec3 } from '../../../shared/math'
import { decodeCar, type CarState, type RaceState, type WireCar } from '../../../shared/protocol'

export type Snapshot = {
  tick: number
  /** Server clock when this snapshot was produced. */
  serverTime: number
  cars: Map<number, CarState>
  race: RaceState
}

/** A car sampled at render time: interpolated state plus how it was produced. */
export type SampledCar = CarState & { extrapolated: boolean }

export class SnapshotBuffer {
  private snapshots: Snapshot[] = []
  /** Set from the ping/pong clock sync: serverNow ≈ localNow + offset. */
  private clockOffset = 0
  private rtt = 100
  /** Diagnostics for the HUD. */
  lastGapMs = 0
  extrapolatingMs = 0

  setClock(offset: number, rtt: number): void {
    this.clockOffset = offset
    this.rtt = rtt
  }

  get roundTripMs(): number {
    return this.rtt
  }

  get snapshotCount(): number {
    return this.snapshots.length
  }

  push(tick: number, serverTime: number, cars: WireCar[], race: RaceState): void {
    const previous = this.snapshots[this.snapshots.length - 1]
    if (previous) {
      // Out-of-order delivery: an older snapshot has nothing to add.
      if (serverTime <= previous.serverTime) return
      this.lastGapMs = serverTime - previous.serverTime
    }
    const map = new Map<number, CarState>()
    for (const wire of cars) {
      const car = decodeCar(wire)
      map.set(car.id, car)
    }
    this.snapshots.push({ tick, serverTime, cars: map, race })
    const cutoff = serverTime - SNAPSHOT_BUFFER_MS
    while (this.snapshots.length > 2 && this.snapshots[0].serverTime < cutoff) this.snapshots.shift()
  }

  /** The server-clock instant currently being rendered for remote cars. */
  renderTime(localNow: number): number {
    return localNow + this.clockOffset - INTERPOLATION_DELAY_MS
  }

  latestRace(): RaceState | null {
    const last = this.snapshots[this.snapshots.length - 1]
    return last ? last.race : null
  }

  /**
   * Dead reckoning for one car past the newest snapshot.
   *
   * Position continues along the last reported velocity, which over a few tens of
   * milliseconds is accurate to the acceleration term — millimetres. **Orientation is the
   * part that matters more than it looks.** Holding the last rotation while the position
   * keeps sliding is what a 20 Hz stutter looks like on a car that is cornering: the body
   * freezes, then steps a few degrees the moment the next snapshot lands. Your own car is
   * rendered close enough to the present that it is dead reckoning most frames at internet
   * latency, so that step is on screen twenty times a second.
   *
   * There is no angular velocity on the wire, and adding one to fix this would be sending
   * a value the server already implies: the rotation is continued along the arc between the
   * two newest snapshots instead — a slerp with `t > 1` — and the steering angle and wheel
   * spin follow the same differences. The angular part is capped at one snapshot of
   * continuation, because a long gap means a lost packet, and guessing a whole extra turn
   * from one 50 ms sample is how a car ends up facing the wrong way.
   */
  private deadReckon(car: CarState, before: CarState | undefined, aheadMs: number, spanMs: number): SampledCar {
    const seconds = Math.min(aheadMs, MAX_EXTRAPOLATION_MS) / 1000
    const pos = {
      x: car.pos.x + car.vel.x * seconds,
      y: car.pos.y + car.vel.y * seconds,
      z: car.pos.z + car.vel.z * seconds
    }
    if (!before || spanMs <= 0 || aheadMs <= 0) {
      return { ...car, pos, extrapolated: aheadMs > 0 }
    }
    const t = 1 + Math.min(aheadMs, spanMs) / spanMs
    return {
      ...car,
      pos,
      rot: quatSlerp(before.rot, car.rot, t),
      steer: lerpNum(before.steer, car.steer, t),
      spin: lerpAngle(before.spin, car.spin, t),
      extrapolated: true
    }
  }

  /** Server time between the two newest snapshots, for continuing a rotation past the end. */
  private newestSpan(): number {
    const n = this.snapshots.length
    return n >= 2 ? this.snapshots[n - 1].serverTime - this.snapshots[n - 2].serverTime : 0
  }

  /**
   * Samples one car at an arbitrary server instant, interpolating when the buffer
   * brackets it and dead-reckoning when it does not. Used for the local car, which is
   * rendered on its own, shorter delay.
   */
  private sampleAt(target: number, id: number): SampledCar | null {
    const newest = this.snapshots[this.snapshots.length - 1]
    if (target >= newest.serverTime) {
      const car = newest.cars.get(id)
      if (!car) return null
      const before = this.snapshots[this.snapshots.length - 2]?.cars.get(id)
      return this.deadReckon(car, before, target - newest.serverTime, this.newestSpan())
    }
    let after = this.snapshots.length - 1
    while (after > 0 && this.snapshots[after - 1].serverTime > target) after--
    const b = this.snapshots[after]
    const a = this.snapshots[after - 1] ?? b
    const from = a.cars.get(id)
    const to = b.cars.get(id)
    if (!to) return null
    if (!from) return { ...to, extrapolated: false }
    const span = b.serverTime - a.serverTime
    const t = span > 0 ? (target - a.serverTime) / span : 0
    return {
      ...to,
      pos: lerpVec(from.pos, to.pos, t),
      rot: quatSlerp(from.rot, to.rot, t),
      vel: lerpVec(from.vel, to.vel, t),
      steer: lerpNum(from.steer, to.steer, t),
      spin: lerpAngle(from.spin, to.spin, t),
      susp: [
        lerpNum(from.susp[0], to.susp[0], t),
        lerpNum(from.susp[1], to.susp[1], t),
        lerpNum(from.susp[2], to.susp[2], t),
        lerpNum(from.susp[3], to.susp[3], t)
      ],
      charge: lerpNum(from.charge, to.charge, t),
      extrapolated: false
    }
  }

  /**
   * Samples every car at the render instant.
   * @returns an empty map until at least one snapshot has arrived.
   */
  sample(localNow: number, localCarId = -1): Map<number, SampledCar> {
    const out = new Map<number, SampledCar>()
    if (this.snapshots.length === 0) return out
    const target = this.renderTime(localNow)
    // Your own car is sampled much closer to the present: see LOCAL_INTERPOLATION_DELAY_MS.
    const localTarget = localNow + this.clockOffset - LOCAL_INTERPOLATION_DELAY_MS
    if (localCarId >= 0 && localTarget !== target) {
      const mine = this.sampleAt(localTarget, localCarId)
      if (mine) out.set(localCarId, mine)
    }
    const newest = this.snapshots[this.snapshots.length - 1]

    if (target >= newest.serverTime) {
      // Nothing newer to interpolate toward: dead-reckon, bounded.
      const ahead = target - newest.serverTime
      this.extrapolatingMs = ahead
      const span = this.newestSpan()
      const previous = this.snapshots[this.snapshots.length - 2]
      for (const [id, car] of newest.cars) {
        if (out.has(id)) continue
        out.set(id, this.deadReckon(car, previous?.cars.get(id), ahead, span))
      }
      return out
    }

    this.extrapolatingMs = 0
    const oldest = this.snapshots[0]
    if (target <= oldest.serverTime) {
      // Still filling the buffer right after joining.
      for (const [id, car] of oldest.cars) if (!out.has(id)) out.set(id, { ...car, extrapolated: false })
      return out
    }

    // Find the bracketing pair. The buffer holds ~20 entries, so a linear scan from the
    // newest end finds it in one or two steps.
    let after = this.snapshots.length - 1
    while (after > 0 && this.snapshots[after - 1].serverTime > target) after--
    const b = this.snapshots[after]
    const a = this.snapshots[after - 1]
    const span = b.serverTime - a.serverTime
    const t = span > 0 ? (target - a.serverTime) / span : 0

    for (const [id, from] of a.cars) {
      if (out.has(id)) continue
      const to = b.cars.get(id)
      if (!to) {
        // Left the race between these two snapshots.
        out.set(id, { ...from, extrapolated: false })
        continue
      }
      out.set(id, {
        ...to,
        pos: lerpVec(from.pos, to.pos, t),
        rot: quatSlerp(from.rot, to.rot, t),
        vel: lerpVec(from.vel, to.vel, t),
        steer: lerpNum(from.steer, to.steer, t),
        // Wheel spin wraps at 2*pi, so interpolate along the short way round.
        spin: lerpAngle(from.spin, to.spin, t),
        susp: [
          lerpNum(from.susp[0], to.susp[0], t),
          lerpNum(from.susp[1], to.susp[1], t),
          lerpNum(from.susp[2], to.susp[2], t),
          lerpNum(from.susp[3], to.susp[3], t)
        ],
        charge: lerpNum(from.charge, to.charge, t),
        extrapolated: false
      })
    }
    // Cars that only exist in the newer snapshot (just joined) appear without a blend.
    for (const [id, car] of b.cars) {
      if (!out.has(id)) out.set(id, { ...car, extrapolated: false })
    }
    return out
  }
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerpNum(a.x, b.x, t), y: lerpNum(a.y, b.y, t), z: lerpNum(a.z, b.z, t) }
}

function lerpAngle(a: number, b: number, t: number): number {
  const TAU = Math.PI * 2
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return a + d * t
}

export type { Quat }
