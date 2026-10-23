/**
 * Builds the visible circuit from the same `Track` data the server turns into colliders,
 * so what you see is exactly what the physics uses. The road is scaled boxes; the
 * scenery (buildings, barriers, gates, trees...) is the kit's GLB pieces, placed and
 * streamed by decor.ts.
 *
 * When the room switches circuit the whole thing is torn down with `clearTrack()` and
 * built again from the new one; the decoration kit hooks into the same two calls.
 *
 * Decentraland colliders are added only to the drivable surfaces, which lets a player on
 * foot walk the circuit while they are not driving. The parcel-wide `ground` surface is
 * skipped: the explorer already draws the parcel floor.
 */

import {
  ColliderLayer,
  engine,
  Entity,
  Material,
  MeshCollider,
  MeshRenderer,
  TextureWrapMode,
  Transform
} from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import type { Surface, SurfaceKind, Track } from '../../shared/tracks'
import { clearDecor, decorate } from './decor'

/** Metres of ground covered by one repeat of the gravel texture. */
const GRAVEL_TILE = 4
/** The grid the generator cuts holes in the floor on (its `GROUND_TILE`). */
const HOLE_TILE = 8
/** Surfaces that get the asphalt texture rather than flat colour. */
const PAVED: SurfaceKind[] = ['road', 'ramp']

const PALETTE: Record<SurfaceKind, Color4> = {
  ground: Color4.create(0.1, 0.1, 0.12, 1),
  // These multiply the asphalt texture, so they are tints rather than colours: a dark
  // value here is what made the circuit look like a trench.
  road: Color4.create(0.72, 0.73, 0.76, 1),
  ramp: Color4.create(0.78, 0.62, 0.38, 1),
  ceiling: Color4.create(0.14, 0.2, 0.3, 1),
  wall: Color4.create(0.5, 0.1, 0.12, 1),
  startline: Color4.create(0.9, 0.9, 0.95, 1),
  building: Color4.create(0.13, 0.14, 0.18, 1)
}

/** Surfaces a car drives on also get a collider so an avatar on foot can walk them. */
const WALKABLE: SurfaceKind[] = ['road', 'ramp', 'startline']

/** Every entity the current circuit is drawn with, so it can be taken down in one go. */
let built: Entity[] = []

function addEntity(): Entity {
  const entity = engine.addEntity()
  built.push(entity)
  return entity
}

function spawnSurface(surface: Surface): Entity {
  const entity = addEntity()
  Transform.create(entity, {
    position: surface.pos,
    scale: surface.size,
    rotation: Quaternion.fromEulerDegrees(surface.rot[0], surface.rot[1], surface.rot[2])
  })
  const isBuilding = surface.kind === 'building'
  // A building is drawn by its kit piece (decor.ts), which is exactly this box; the box
  // stays here as the collider only.
  if (isBuilding) {
    MeshCollider.setBox(entity, ColliderLayer.CL_PHYSICS)
    return entity
  }
  MeshRenderer.setBox(entity)
  const paved = PAVED.indexOf(surface.kind) !== -1
  Material.setPbrMaterial(entity, {
    albedoColor: PALETTE[surface.kind],
    texture: paved
      ? Material.Texture.Common({ src: 'images/asphalt.png', wrapMode: TextureWrapMode.TWM_REPEAT })
      : undefined,
    roughness: surface.kind === 'startline' ? 0.9 : paved ? 0.95 : 0.6,
    metallic: 0.1
  })
  if (WALKABLE.indexOf(surface.kind) !== -1) {
    MeshCollider.setBox(entity, ColliderLayer.CL_PHYSICS)
  }
  return entity
}

/**
 * The gravel everything that is not circuit sits on.
 *
 * Planes across the parcel block with the texture repeated every few metres, rather than
 * the explorer's default parcel floor: off the asphalt the car is on gravel,
 * and it should look like gravel before it starts behaving like it. The plane is laid a
 * centimetre above the ground collider, which is itself a centimetre below the asphalt,
 * so the road slabs still read as slabs with an edge.
 */
function buildGround(track: Track): void {
  // One plane per floor box: where the circuit runs high the server's floor has holes, so
  // that a car going off a rooftop falls out of the world, and gravel drawn over them would
  // show it sinking through solid ground. The holes are drawn as dark shafts instead.
  const floor = track.surfaces.filter((s) => s.kind === 'ground')
  for (const s of floor) floorPlane(s.pos.x, s.pos.z, s.size.x, s.size.z, true)
  if (floor.length < 2) return
  const covered = (x: number, z: number): boolean =>
    floor.some((s) => Math.abs(x - s.pos.x) <= s.size.x / 2 && Math.abs(z - s.pos.z) <= s.size.z / 2)
  // The generator cuts the floor on this grid, from the corner of the parcel block.
  for (let z = 0; z < track.extent; z += HOLE_TILE) {
    let start = -1
    for (let x = 0; x <= track.extent; x += HOLE_TILE) {
      const open = x < track.extent && !covered(x + HOLE_TILE / 2, z + HOLE_TILE / 2)
      if (open && start < 0) start = x
      if (!open && start >= 0) {
        floorPlane((start + x) / 2, z + HOLE_TILE / 2, x - start, HOLE_TILE, false)
        start = -1
      }
    }
  }
}

/** A horizontal plane just over the floor collider: gravel, or the dark of a hole. */
function floorPlane(x: number, z: number, width: number, depth: number, gravel: boolean): void {
  const entity = addEntity()
  Transform.create(entity, {
    position: { x, y: 0.01, z },
    scale: { x: width, y: depth, z: 1 },
    rotation: Quaternion.fromEulerDegrees(90, 0, 0)
  })
  if (!gravel) {
    MeshRenderer.setPlane(entity)
    Material.setPbrMaterial(entity, { albedoColor: Color4.create(0.01, 0.01, 0.015, 1), roughness: 1, metallic: 0 })
    return
  }
  // A plane's uvs are given per face, front then back; scaling them past 1 is what tiles
  // the texture instead of stretching one copy over half a kilometre. The floor boxes start
  // on whole tiles, so the gravel runs on across their joins.
  const u = width / GRAVEL_TILE
  const v = depth / GRAVEL_TILE
  const uvs = [0, 0, u, 0, u, v, 0, v, 0, 0, u, 0, u, v, 0, v]
  MeshRenderer.setPlane(entity, uvs)
  Material.setPbrMaterial(entity, {
    texture: Material.Texture.Common({ src: 'images/gravel.png', wrapMode: TextureWrapMode.TWM_REPEAT }),
    roughness: 1,
    metallic: 0
  })
}

export function buildTrack(track: Track): void {
  buildGround(track)
  for (const surface of track.surfaces) {
    if (surface.kind === 'ground') continue
    spawnSurface(surface)
  }

  // The pillars, boost pads and checkpoint gates are kit pieces (decor.ts). What stays here
  // is the pillars' collider, which the avatar on foot can hit.
  for (const obstacle of track.obstacles) {
    const entity = addEntity()
    Transform.create(entity, {
      position: obstacle.pos,
      scale: obstacle.size,
      rotation: Quaternion.fromEulerDegrees(obstacle.rot[0], obstacle.rot[1], obstacle.rot[2])
    })
    MeshCollider.setBox(entity, ColliderLayer.CL_PHYSICS)
  }

  decorate(track)
}

/** Removes everything `buildTrack` drew, ready for another circuit. */
export function clearTrack(): void {
  clearDecor()
  for (const entity of built) engine.removeEntity(entity)
  built = []
}
