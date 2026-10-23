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
 * One plane across the whole parcel block with the texture repeated every few metres,
 * rather than the explorer's default parcel floor: off the asphalt the car is on gravel,
 * and it should look like gravel before it starts behaving like it. The plane is laid a
 * centimetre above the ground collider, which is itself a centimetre below the asphalt,
 * so the road slabs still read as slabs with an edge.
 */
function buildGround(track: Track): void {
  const entity = addEntity()
  const repeats = track.extent / GRAVEL_TILE
  Transform.create(entity, {
    position: { x: track.extent / 2, y: 0.01, z: track.extent / 2 },
    scale: { x: track.extent, y: track.extent, z: 1 },
    rotation: Quaternion.fromEulerDegrees(90, 0, 0)
  })
  // A plane's uvs are given per face, front then back; scaling them past 1 is what tiles
  // the texture instead of stretching one copy over half a kilometre.
  const uvs = [
    0, 0, repeats, 0, repeats, repeats, 0, repeats,
    0, 0, repeats, 0, repeats, repeats, 0, repeats
  ]
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
