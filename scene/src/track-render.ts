/**
 * Builds the visible circuit from the same `Track` data the server turns into colliders,
 * so what you see is exactly what the physics uses. Every piece is a scaled box: no
 * glTF assets are needed and the scene loads instantly.
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

/** A few window tints, picked per building so the skyline is not one flat colour. */
const FACADES = [
  Color4.create(0.13, 0.14, 0.18, 1),
  Color4.create(0.17, 0.16, 0.2, 1),
  Color4.create(0.11, 0.15, 0.19, 1),
  Color4.create(0.16, 0.13, 0.16, 1)
]

/** Surfaces a car drives on also get a collider so an avatar on foot can walk them. */
const WALKABLE: SurfaceKind[] = ['road', 'ramp', 'startline']

/** Every entity the current circuit is drawn with, so it can be taken down in one go. */
let built: Entity[] = []

function addEntity(): Entity {
  const entity = engine.addEntity()
  built.push(entity)
  return entity
}

function spawnSurface(surface: Surface, index: number): Entity {
  const entity = addEntity()
  Transform.create(entity, {
    position: surface.pos,
    scale: surface.size,
    rotation: Quaternion.fromEulerDegrees(surface.rot[0], surface.rot[1], surface.rot[2])
  })
  MeshRenderer.setBox(entity)
  const isBuilding = surface.kind === 'building'
  const paved = PAVED.indexOf(surface.kind) !== -1
  Material.setPbrMaterial(entity, {
    albedoColor: isBuilding ? FACADES[index % FACADES.length] : PALETTE[surface.kind],
    texture: paved
      ? Material.Texture.Common({ src: 'images/asphalt.png', wrapMode: TextureWrapMode.TWM_REPEAT })
      : undefined,
    emissiveColor: isBuilding ? Color4.create(0.05, 0.08, 0.14, 1) : undefined,
    emissiveIntensity: isBuilding ? 0.35 : 0,
    roughness: surface.kind === 'startline' ? 0.9 : paved ? 0.95 : 0.6,
    metallic: isBuilding ? 0.3 : 0.1
  })
  // Buildings are solid: they are what stops a car cutting across the infield, so they
  // need a collider on the server *and* here, where an avatar on foot can hit them too.
  if (isBuilding || WALKABLE.indexOf(surface.kind) !== -1) {
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
  let index = 0
  for (const surface of track.surfaces) {
    if (surface.kind === 'ground') continue
    spawnSurface(surface, index++)
  }

  for (const obstacle of track.obstacles) {
    const entity = addEntity()
    Transform.create(entity, {
      position: obstacle.pos,
      scale: obstacle.size,
      rotation: Quaternion.fromEulerDegrees(obstacle.rot[0], obstacle.rot[1], obstacle.rot[2])
    })
    MeshRenderer.setBox(entity)
    Material.setPbrMaterial(entity, {
      albedoColor: Color4.create(0.85, 0.35, 0.05, 1),
      emissiveColor: Color4.create(0.4, 0.12, 0, 1),
      emissiveIntensity: 0.4,
      roughness: 0.7
    })
    MeshCollider.setBox(entity, ColliderLayer.CL_PHYSICS)
  }

  // Boost pads: flat glowing plates. No collider — the server owns the trigger.
  for (const trigger of track.triggers) {
    if (trigger.kind !== 'boost') continue
    const entity = addEntity()
    Transform.create(entity, {
      position: { x: trigger.pos.x, y: 0.16, z: trigger.pos.z },
      scale: { x: trigger.size.x, y: 0.08, z: trigger.size.z },
      rotation: Quaternion.fromEulerDegrees(trigger.rot[0], trigger.rot[1], trigger.rot[2])
    })
    MeshRenderer.setBox(entity)
    Material.setPbrMaterial(entity, {
      albedoColor: Color4.create(0.1, 0.8, 1, 1),
      emissiveColor: Color4.create(0.1, 0.7, 1, 1),
      emissiveIntensity: 2
    })
  }

  // Checkpoint gates: two uprights per checkpoint, so the racing line is readable from
  // the car without drawing a solid wall across the track.
  for (const trigger of track.triggers) {
    if (trigger.kind !== 'checkpoint') continue
    const yaw = trigger.rot[1]
    const rad = (yaw * Math.PI) / 180
    // The trigger's local X runs across the track; offset the posts along it.
    const half = trigger.size.x / 2
    const acrossX = Math.cos(rad) * half
    const acrossZ = -Math.sin(rad) * half
    for (const side of [-1, 1]) {
      const post = addEntity()
      Transform.create(post, {
        position: {
          x: trigger.pos.x + acrossX * side,
          y: trigger.pos.y - trigger.size.y / 2 + 2,
          z: trigger.pos.z + acrossZ * side
        },
        scale: { x: 0.5, y: 4, z: 0.5 },
        rotation: Quaternion.fromEulerDegrees(0, yaw, 0)
      })
      MeshRenderer.setBox(post)
      Material.setPbrMaterial(post, {
        albedoColor: trigger.index === 0 ? Color4.create(1, 0.9, 0.2, 1) : Color4.create(0.2, 0.9, 0.5, 1),
        emissiveColor: trigger.index === 0 ? Color4.create(0.8, 0.6, 0, 1) : Color4.create(0, 0.5, 0.3, 1),
        emissiveIntensity: 1.2
      })
    }
  }
}

/** Removes everything `buildTrack` drew, ready for another circuit. */
export function clearTrack(): void {
  for (const entity of built) engine.removeEntity(entity)
  built = []
}
