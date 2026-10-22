/**
 * Trigger overlap tests.
 *
 * Checkpoints, boost pads and the invert zone are oriented boxes and the car is tested
 * as a point. Triggers are at least 2.5 m thick along the direction of travel while a car
 * covers ~0.53 m per tick at boost speed, so a point test cannot be tunnelled through.
 */

import { quatConjugate, quatFromEulerDegrees, quatRotate, type Vec3 } from '../../shared/math'
import type { Trigger } from '../../shared/tracks'

const cache = new WeakMap<Trigger, { inverse: ReturnType<typeof quatFromEulerDegrees> }>()

export function pointInBox(p: Vec3, box: Trigger): boolean {
  let entry = cache.get(box)
  if (!entry) {
    entry = { inverse: quatConjugate(quatFromEulerDegrees(box.rot[0], box.rot[1], box.rot[2])) }
    cache.set(box, entry)
  }
  const local = quatRotate(entry.inverse, {
    x: p.x - box.pos.x,
    y: p.y - box.pos.y,
    z: p.z - box.pos.z
  })
  return (
    Math.abs(local.x) <= box.size.x / 2 &&
    Math.abs(local.y) <= box.size.y / 2 &&
    Math.abs(local.z) <= box.size.z / 2
  )
}
