/**
 * Walks every circuit's scenery layout and checks the kit contract: nothing too close to a
 * road box, nothing on a ramp or a ceiling slab, every piece in the manifest, and the
 * streaming budgets (entities and triangles visible at once) along the whole lap.
 *
 *   npm run test:decor
 */

import { readFileSync } from 'node:fs'
import { groupDecor, groupVisible, layoutDecor, SCENERY_CLEARANCE, type KitManifest } from '../../scene/src/decor-layout'
import { TRACK_IDS, trackById } from '../../shared/tracks'

const MAX_ENTITIES = 400
const MAX_TRIS = 150_000

let failed = false
const fail = (message: string): void => {
  failed = true
  console.log(`  FAIL ${message}`)
}

function rectDistance(s: { pos: { x: number; z: number }; size: { x: number; z: number }; rot: number[] }, x: number, z: number): number {
  const yaw = (s.rot[1] * Math.PI) / 180
  const pitch = (s.rot[0] * Math.PI) / 180
  const dx = x - s.pos.x
  const dz = z - s.pos.z
  const across = Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw))
  const along = Math.abs(dx * Math.sin(yaw) + dz * Math.cos(yaw))
  return Math.hypot(Math.max(across - s.size.x / 2, 0), Math.max(along - (s.size.z / 2) * Math.abs(Math.cos(pitch)), 0))
}

for (const id of TRACK_IDS) {
  const track = trackById(id)
  // A theme whose kit is not generated yet is dressed with city's, as the scene does.
  const dir = new URL(`../../scene/models/kit/${track.theme}/manifest.json`, import.meta.url)
  let manifest: KitManifest
  try {
    manifest = JSON.parse(readFileSync(dir, 'utf8'))
  } catch {
    manifest = JSON.parse(readFileSync(new URL('../../scene/models/kit/city/manifest.json', import.meta.url), 'utf8'))
  }
  console.log(`${id}:`)
  const items = layoutDecor(track, manifest)
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.piece.replace(/^building-.*/, 'building'), (counts.get(item.piece.replace(/^building-.*/, 'building')) ?? 0) + 1)
  console.log(`  ${items.length} pieces: ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')}`)

  const solids = track.surfaces.filter((s) => ['road', 'ramp', 'ceiling', 'startline'].includes(s.kind))
  const lifted = track.surfaces.filter((s) => s.kind === 'ramp' || s.kind === 'ceiling')
  for (const item of items) {
    const trackside = item.piece === 'barrier' || item.piece === 'kerb'
    if (trackside || item.kind === 'scenery') {
      const near = Math.min(...solids.map((s) => rectDistance(s, item.x, item.z)))
      const min = item.kind === 'scenery' ? SCENERY_CLEARANCE : 0.2
      if (near < min) fail(`${item.piece} at ${item.x.toFixed(1)},${item.z.toFixed(1)} is ${near.toFixed(2)} m from a road box`)
    }
    if (['barrier', 'kerb', 'chevron', 'lamp', 'banner', 'stand', 'tree-a', 'tree-b'].includes(item.piece)) {
      if (lifted.some((s) => rectDistance(s, item.x, item.z) <= 0)) fail(`${item.piece} sits on a ramp or slab`)
    }
    if (!manifest[item.piece]) fail(`${item.piece} is not in the manifest`)
  }
  for (const s of track.surfaces) {
    if (s.kind === 'building' && !manifest[`building-${s.size.x}x${s.size.z}x${s.size.y}`]) {
      fail(`no kit piece for the ${s.size.x}x${s.size.z}x${s.size.y} building`)
    }
  }

  // Streaming budgets: a car on every line point looking along the line, and the same
  // parked (everything around).
  const groups = groupDecor(items)
  let maxEntities = 0
  let maxTris = 0
  let maxParked = 0
  let worst = 0
  const path = track.centreline
  for (let i = 0; i < path.length; i++) {
    const p = path[i]
    const heading = { x: p.dir.x, z: p.dir.z }
    let entities = 0
    let tris = 0
    let parked = 0
    for (const g of groups) {
      if (groupVisible(g, p.pos.x, p.pos.z, heading)) {
        entities += g.items.length
        tris += g.tris
      }
      if (groupVisible(g, p.pos.x, p.pos.z, null)) parked += g.items.length
    }
    if (entities > maxEntities) {
      maxEntities = entities
      worst = i
    }
    maxTris = Math.max(maxTris, tris)
    maxParked = Math.max(maxParked, parked)
  }
  console.log(`  ${groups.length} sectors; visible while driving: max ${maxEntities} entities (at line point ${worst}), max ${maxTris} tris; parked, looking all round: max ${maxParked} entities`)
  if (maxEntities > MAX_ENTITIES) fail(`${maxEntities} entities visible, budget ${MAX_ENTITIES}`)
  if (maxTris > MAX_TRIS) fail(`${maxTris} triangles visible, budget ${MAX_TRIS}`)
}

if (failed) process.exit(1)
console.log('decor: ok')
