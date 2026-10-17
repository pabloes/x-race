/**
 * Light ribbons: the tail lamps leave a red streak behind the car that dies out.
 *
 * Built like the skid marks — a fixed pool of entities used as a ring, so a race never
 * creates a single entity after the first lap — but with a life instead of a length: a
 * segment is dropped every so many metres and goes out when its time is up. That is what
 * makes the ribbon shrink back to the car when you stop rather than hanging in the air.
 *
 * Nothing is animated between those two moments. Every change here is a component write
 * to the renderer, so a per-frame fade across eight cars would be thousands of writes a
 * second; and the cheap approximation of one — narrowing the segment halfway through —
 * looked like the ribbon flattening out before it vanished, which is worse than a clean
 * cut at a short life.
 *
 * Positions are in the car's own frame and transformed by its rotation each time, so the
 * ribbon comes out of the lamps at whatever angle the car is at, including upside down on
 * the ceiling run.
 */

import { engine, Entity, Material, MeshRenderer, Transform, VisibilityComponent } from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { quatRotate } from '../../shared/math'
import { CarFlag } from '../../shared/protocol'
import type { SampledCar } from './net/snapshot-buffer'

/**
 * One emitter, in the middle of the tail, drawn as wide as the lamp bar itself.
 *
 * Two emitters, one per lamp, is the obvious reading of "the red lights leave a trail",
 * and it costs twice the component writes for a difference nobody sees at racing speed:
 * at 30 m/s the two ribbons are a hand's width apart and read as one anyway.
 */
const EMITTERS = [{ x: 0, y: 0.12, z: -1.95 }]
/** Segments per emitter. The ribbon is this many times `SPACING` long at most. */
const SEGMENTS = 20
/** Metres between segments. */
const SPACING = 1.0
/** How long a segment lasts, in milliseconds. */
const LIFE_MS = 320
/** Below this speed the car is not drawing a ribbon, it is parked. */
const MIN_SPEED = 6

type Segment = { entity: Entity; bornAt: number; live: boolean }
type Trail = { segments: Segment[]; next: number; last: { x: number; y: number; z: number } | null }

const trails = new Map<number, Trail>()

function create(): Segment {
  const entity = engine.addEntity()
  Transform.create(entity, { position: { x: 0, y: -100, z: 0 } })
  MeshRenderer.setBox(entity)
  Material.setPbrMaterial(entity, {
    albedoColor: Color4.create(1, 0.02, 0.02, 1),
    emissiveColor: Color4.create(1, 0, 0, 1),
    emissiveIntensity: 11,
    roughness: 1
  })
  VisibilityComponent.create(entity, { visible: false })
  return { entity, bornAt: 0, live: false }
}

function show(segment: Segment, at: { x: number; y: number; z: number }, rotation: Quaternion, now: number): void {
  const transform = Transform.getMutable(segment.entity)
  transform.position = at
  transform.rotation = rotation
  transform.scale = { x: 0.12, y: 0.05, z: SPACING * 1.1 }
  const visibility = VisibilityComponent.getMutable(segment.entity)
  if (!visibility.visible) visibility.visible = true
  segment.bornAt = now
  segment.live = true
}

/** One car's ribbons for this frame: drop a segment if it has moved, then age the rest. */
export function updateTrails(car: SampledCar, now: number): void {
  let trail = trails.get(car.id)
  if (!trail) {
    trail = { segments: [], next: 0, last: null }
    trails.set(car.id, trail)
  }

  const speed = Math.sqrt(car.vel.x * car.vel.x + car.vel.y * car.vel.y + car.vel.z * car.vel.z)
  const visible = (car.flags & CarFlag.Respawning) === 0
  if (visible && speed > MIN_SPEED) {
    const moved =
      trail.last === null
        ? Infinity
        : Math.sqrt(
            (car.pos.x - trail.last.x) ** 2 +
              (car.pos.y - trail.last.y) ** 2 +
              (car.pos.z - trail.last.z) ** 2
          )
    // A jump of several metres in one frame is a respawn, not a drive: start again rather
    // than drawing a streak across the circuit.
    if (moved > SPACING && moved < 20) {
      trail.last = { x: car.pos.x, y: car.pos.y, z: car.pos.z }
      for (const emitter of EMITTERS) {
        if (trail.segments.length < SEGMENTS * EMITTERS.length) trail.segments.push(create())
        const segment = trail.segments[trail.next % trail.segments.length]
        trail.next++
        const offset = quatRotate(car.rot, emitter)
        show(
          segment,
          { x: car.pos.x + offset.x, y: car.pos.y + offset.y, z: car.pos.z + offset.z },
          car.rot,
          now
        )
      }
    } else if (moved >= 20) {
      trail.last = { x: car.pos.x, y: car.pos.y, z: car.pos.z }
    }
  }

  // A segment keeps its shape for its whole life and then goes out. An earlier version
  // narrowed it halfway through as a fade, which at speed read as the ribbon flattening
  // into a plate before vanishing: worse than no fade at all, and an extra write per
  // segment to get it.
  for (const segment of trail.segments) {
    if (!segment.live) continue
    if (now - segment.bornAt >= LIFE_MS) {
      segment.live = false
      VisibilityComponent.getMutable(segment.entity).visible = false
    }
  }
}
