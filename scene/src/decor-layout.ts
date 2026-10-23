/**
 * Where the scenery kit goes on a circuit, and which of it is worth drawing from where you
 * stand. Pure functions of the `Track`: nothing here touches the engine, so the check in
 * `server/src/decor-check.ts` runs the same code the scene does. See docs/contracts/kit.md.
 *
 * The layout is read off the built circuit (its racing line and its boxes) rather than off
 * the definition, so a circuit added later is dressed without teaching this file about it.
 * No `Math.random`: the trees use the same xorshift as the generator's buildings.
 */

import type { Surface, Track } from '../../shared/tracks'

export type KitManifest = Record<string, { size: { x: number; y: number; z: number }; tris: number; materials: number }>

/** One kit piece to put in the world. */
export type Placed = {
  piece: string
  x: number
  y: number
  z: number
  /** Degrees about Y, the same convention as the track's `rot[1]`. */
  yaw: number
  sx: number
  sy: number
  sz: number
  tris: number
  /** Streaming group, see `groupDecor`. */
  group: number
  /** Small pieces (barriers, kerbs, chevrons) are only worth drawing close to the car. */
  near: boolean
  /**
   * `trackside` pieces belong to the road edge (barriers, kerbs, gates, pads) and only have
   * to keep off the asphalt; `scenery` has to keep `SCENERY_CLEARANCE` from every box.
   */
  kind: 'trackside' | 'scenery'
}

/** The contract's "nothing within 2 m of a road box", for everything that is not trackside. */
export const SCENERY_CLEARANCE = 2
/** A barrier's centre may not be closer than this to a road box (it sits 1 m off the edge). */
export const TRACKSIDE_CLEARANCE = 0.2

// Mirrors of the generator's private road widths. Only used as a fallback: the real half
// width at each point is measured off the road boxes.
const STRAIGHT_HALF = 7.5
const BARRIER_OFFSET = 1
const BARRIER_STEP = 4
const KERB_STEP = 6
const CHEVRON_STEP = 12
const LAMP_STEP = 30
const BANNER_STEP = 16
const STAND_STEP = 12
const HOLOGRAM_STEP = 60
/** The main straight is dressed this far either side of the line. */
const GRANDSTAND_BEFORE = 96
const GRANDSTAND_AFTER = 48
const BANNER_RANGE = 120

/** Streaming sector length along the racing line, metres. */
export const SECTOR_LENGTH = 30
const LINE_STEP = 2
const SECTOR_RINGS = 4
const RING_WIDTH = 40

const TREE_GRID = 15
/** Trees live between this and `TREE_MAX_CLEARANCE` metres from the asphalt. */
const TREE_MIN_CLEARANCE = 9
const TREE_MAX_CLEARANCE = 32

/** Pieces that stop being drawn at `NEAR_RADIUS` instead of `VIEW_RADIUS`. */
const NEAR_ONLY = ['barrier', 'kerb', 'chevron']

const SOLID: Surface['kind'][] = ['road', 'ramp', 'ceiling', 'startline']

type Rect = { cx: number; cz: number; hx: number; hz: number; sin: number; cos: number; kind: Surface['kind'] }

/** Flat footprint of a box: pitch shortens a ramp's reach along the ground. */
function footprint(s: Surface): Rect {
  const yaw = (s.rot[1] * Math.PI) / 180
  const pitch = (s.rot[0] * Math.PI) / 180
  return {
    cx: s.pos.x,
    cz: s.pos.z,
    hx: s.size.x / 2,
    hz: (s.size.z / 2) * Math.abs(Math.cos(pitch)),
    sin: Math.sin(yaw),
    cos: Math.cos(yaw),
    kind: s.kind
  }
}

function rectDistance(r: Rect, x: number, z: number): number {
  const dx = x - r.cx
  const dz = z - r.cz
  const across = Math.abs(dx * r.cos - dz * r.sin)
  const along = Math.abs(dx * r.sin + dz * r.cos)
  return Math.hypot(Math.max(across - r.hx, 0), Math.max(along - r.hz, 0))
}

/** Rectangles bucketed on a coarse grid, so a point only meets the boxes near it. */
class Footprints {
  private cells = new Map<number, Rect[]>()
  private static CELL = 32
  private static REACH = 80

  constructor(rects: Rect[]) {
    for (const r of rects) {
      const reach = Math.hypot(r.hx, r.hz) + Footprints.REACH / 2
      const c = Footprints.CELL
      for (let i = Math.floor((r.cx - reach) / c); i <= Math.floor((r.cx + reach) / c); i++) {
        for (let j = Math.floor((r.cz - reach) / c); j <= Math.floor((r.cz + reach) / c); j++) {
          const key = i * 4096 + j
          const list = this.cells.get(key)
          if (list) list.push(r)
          else this.cells.set(key, [r])
        }
      }
    }
  }

  near(x: number, z: number): Rect[] {
    const c = Footprints.CELL
    return this.cells.get(Math.floor(x / c) * 4096 + Math.floor(z / c)) ?? []
  }

  /** Distance to the closest box, capped at the reach the buckets guarantee. */
  distance(x: number, z: number, kinds?: Surface['kind'][]): number {
    let best = Footprints.REACH / 2
    for (const r of this.near(x, z)) {
      if (kinds && kinds.indexOf(r.kind) === -1) continue
      const d = rectDistance(r, x, z)
      if (d < best) best = d
    }
    return best
  }
}

type LinePoint = { x: number; z: number; dx: number; dz: number; s: number }

/** The racing line resampled every `LINE_STEP` metres as a closed loop, with its heading. */
function resample(track: Track): LinePoint[] {
  const src = track.centreline
  const n = src.length
  const cumulative: number[] = [0]
  for (let i = 1; i <= n; i++) {
    const a = src[i - 1].pos
    const b = src[i % n].pos
    cumulative.push(cumulative[i - 1] + Math.hypot(b.x - a.x, b.z - a.z))
  }
  const total = cumulative[n]
  const count = Math.floor(total / LINE_STEP)
  const pts: LinePoint[] = []
  let seg = 0
  for (let k = 0; k < count; k++) {
    const s = k * LINE_STEP
    while (cumulative[seg + 1] < s) seg++
    const a = src[seg].pos
    const b = src[(seg + 1) % n].pos
    const t = (s - cumulative[seg]) / ((cumulative[seg + 1] - cumulative[seg]) || 1)
    pts.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: 0, dz: 0, s })
  }
  for (let k = 0; k < count; k++) {
    const a = pts[(k - 1 + count) % count]
    const b = pts[(k + 1) % count]
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1
    pts[k].dx = (b.x - a.x) / len
    pts[k].dz = (b.z - a.z) / len
  }
  return pts
}

/** Yaw in degrees of a piece whose +Z points along (dx, dz). */
const yawOf = (dx: number, dz: number): number => (Math.atan2(dx, dz) * 180) / Math.PI
/** Yaw that puts a piece's local +X along (dx, dz). */
const yawOfRight = (dx: number, dz: number): number => (Math.atan2(-dz, dx) * 180) / Math.PI

export function layoutDecor(track: Track, manifest: KitManifest): Placed[] {
  const out: Placed[] = []
  const line = resample(track)
  const count = line.length
  const solids = new Footprints(track.surfaces.filter((s) => SOLID.indexOf(s.kind) !== -1).map(footprint))
  const road = track.surfaces.filter((s) => s.kind === 'road').map(footprint)
  const roads = new Footprints(road)
  const lifted = new Footprints(
    track.surfaces.filter((s) => s.kind === 'ramp' || s.kind === 'ceiling').map(footprint)
  )

  const at = (k: number): LinePoint => line[((k % count) + count) % count]
  /** Signed turn over +-12 m: positive is a left-hander (the generator's convention). */
  const turnAt = (k: number): number => {
    const a = at(k - 6)
    const b = at(k + 6)
    return a.dx * b.dz - a.dz * b.dx
  }
  const isCorner = (k: number): boolean => Math.abs(turnAt(k)) > 0.05
  const halfWidthAt = (p: LinePoint): number => {
    let half = 0
    for (const r of roads.near(p.x, p.z)) {
      if (rectDistance(r, p.x, p.z) <= 3) half = Math.max(half, r.hx)
    }
    return half || STRAIGHT_HALF
  }

  const sectorOf = (s: number): number => Math.floor(s / SECTOR_LENGTH)
  const groupOf = (s: number, offset: number): number =>
    sectorOf(s) * SECTOR_RINGS + Math.min(SECTOR_RINGS - 1, Math.floor(offset / RING_WIDTH))

  const push = (
    piece: string,
    kind: Placed['kind'],
    x: number,
    z: number,
    yaw: number,
    group: number,
    y = 0,
    scale: [number, number, number] = [1, 1, 1]
  ): void => {
    const entry = manifest[piece]
    if (!entry) return
    if (lifted.distance(x, z) <= 0) return
    const near = solids.distance(x, z)
    if (near < (kind === 'scenery' ? SCENERY_CLEARANCE : TRACKSIDE_CLEARANCE)) return
    out.push({
      piece, x, y, z, yaw,
      sx: scale[0], sy: scale[1], sz: scale[2],
      tris: entry.tris,
      group, near: NEAR_ONLY.indexOf(piece) !== -1, kind
    })
  }
  /** The same without the proximity rules, for pieces that go exactly where physics is. */
  const pushAt = (piece: string, x: number, z: number, yaw: number, y: number, scale: [number, number, number], group: number): void => {
    const entry = manifest[piece]
    if (!entry) return
    out.push({ piece, x, y, z, yaw, sx: scale[0], sy: scale[1], sz: scale[2], tris: entry.tris, group, near: false, kind: 'trackside' })
  }

  /** A point `across` metres to the right of the line at `p` (negative: left). */
  const beside = (p: LinePoint, across: number): { x: number; z: number } => ({
    x: p.x + p.dz * across,
    z: p.z - p.dx * across
  })

  // Where the main straight is: the start line sits on it.
  const startLine = track.surfaces.find((s) => s.kind === 'startline')
  let startK = -1
  if (startLine) {
    let best = Infinity
    for (let k = 0; k < count; k++) {
      const d = Math.hypot(line[k].x - startLine.pos.x, line[k].z - startLine.pos.z)
      if (d < best) {
        best = d
        startK = k
      }
    }
  }
  const inWindow = (k: number, before: number, after: number): boolean => {
    if (startK < 0) return false
    const delta = ((k - startK + count * 1.5) % count) - count / 2
    return delta >= -before / LINE_STEP && delta <= after / LINE_STEP
  }

  // --- Along the racing line -------------------------------------------------
  for (let k = 0; k < count; k++) {
    const p = line[k]
    // A gap in the road (none built yet) has no edge to dress.
    if (roads.distance(p.x, p.z) > 1) continue
    const g = groupOf(p.s, 0)
    const half = halfWidthAt(p)
    const corner = isCorner(k)
    const yaw = yawOf(p.dx, p.dz)

    if (p.s % BARRIER_STEP === 0) {
      for (const side of [-1, 1]) {
        const q = beside(p, side * (half + BARRIER_OFFSET))
        push('barrier', 'trackside', q.x, q.z, yaw, g)
      }
    }

    if (corner) {
      const turn = turnAt(k)
      // A left-hander's inside is on the left.
      const inside = turn > 0 ? -1 : 1
      if (p.s % KERB_STEP === 0) {
        const q = beside(p, inside * (half + 0.4))
        push('kerb', 'trackside', q.x, q.z, yaw, g)
      }
      if (p.s % CHEVRON_STEP === 0) {
        const q = beside(p, -inside * (half + 3.5))
        // Arrows run the way the road turns: left of the driver for a left-hander.
        const dx = turn > 0 ? -p.dz : p.dz
        const dz = turn > 0 ? p.dx : -p.dx
        push('chevron', 'scenery', q.x, q.z, yawOfRight(dx, dz), g)
      }
    } else {
      if (p.s % LAMP_STEP === 0) {
        // Alternate sides from one lamp to the next; the arm (+Z) reaches over the road.
        const side = Math.round(p.s / LAMP_STEP) % 2 === 0 ? 1 : -1
        const q = beside(p, side * (half + 3))
        push('lamp', 'scenery', q.x, q.z, yawOf(-p.dz * side, p.dx * side), g)
      }
      if (inWindow(k, BANNER_RANGE, BANNER_RANGE) && p.s % BANNER_STEP === 0) {
        for (const side of [-1, 1]) {
          const q = beside(p, side * (half + 3))
          // The flag is read from +-X: with the mast beside a road running along Z it faces
          // the road, so it only needs the line's own heading.
          push('banner', 'scenery', q.x, q.z, yaw, g)
        }
      }
      if (inWindow(k, BANNER_RANGE, BANNER_RANGE) && p.s % HOLOGRAM_STEP === 0) {
        // Neon only (city has no hologram). Opposite the stands, facing the road; a few.
        const q = beside(p, -(half + 9))
        push('hologram', 'scenery', q.x, q.z, yawOf(p.dz, -p.dx), g)
      }
      if (inWindow(k, GRANDSTAND_BEFORE, GRANDSTAND_AFTER) && p.s % STAND_STEP === 0) {
        // The right-hand side (the pit side on most circuits); the crowd faces +Z, which
        // has to be the road.
        const q = beside(p, half + 4 + 3)
        push('stand', 'scenery', q.x, q.z, yawOf(-p.dz, p.dx), g)
      }
    }
  }

  // --- Gates -----------------------------------------------------------------
  if (startLine) {
    const k = startK
    pushAt('gate-start', startLine.pos.x, startLine.pos.z, startLine.rot[1], 0, [1, 1, 1], groupOf(line[k].s, 0))
  }
  for (const t of track.triggers) {
    if (t.kind !== 'checkpoint') continue
    // The start/finish gate already spans the line; the checkpoint under it needs no twin.
    if (startLine && Math.hypot(t.pos.x - startLine.pos.x, t.pos.z - startLine.pos.z) < 12) continue
    // Not inside the ceiling run: the gate would cut through the slab.
    if (lifted.distance(t.pos.x, t.pos.z) < 3) continue
    pushAt('gate-checkpoint', t.pos.x, t.pos.z, t.rot[1], 0, [1, 1, 1], nearestGroup(line, t.pos.x, t.pos.z))
  }

  // --- Pads and pillars ------------------------------------------------------
  const padSize = manifest['pad']?.size
  if (padSize) {
    for (const t of track.triggers) {
      if (t.kind !== 'boost') continue
      pushAt('pad', t.pos.x, t.pos.z, t.rot[1], t.pos.y - t.size.y / 2, [t.size.x / padSize.x, 1, t.size.z / padSize.z], nearestGroup(line, t.pos.x, t.pos.z))
    }
  }
  const pillarSize = manifest['pillar']?.size
  if (pillarSize) {
    for (const o of track.obstacles) {
      if (o.kind !== 'pillar') continue
      // Scaled to the physical box, so what you see is what you hit.
      pushAt('pillar', o.pos.x, o.pos.z, o.rot[1], o.pos.y - o.size.y / 2, [o.size.x / pillarSize.x, o.size.y / pillarSize.y, o.size.z / pillarSize.z], nearestGroup(line, o.pos.x, o.pos.z))
    }
  }

  // --- Buildings: the catalogue piece that is the physical box ----------------
  const buildings: Rect[] = []
  for (const s of track.surfaces) {
    if (s.kind !== 'building') continue
    const piece = `building-${s.size.x}x${s.size.z}x${s.size.y}`
    pushAt(piece, s.pos.x, s.pos.z, 0, 0, [1, 1, 1], nearestGroup(line, s.pos.x, s.pos.z))
    buildings.push(footprint(s))
  }

  // --- Trees: the free strip between the road and the skyline -----------------
  let seed = 0x9e3779b9
  const rand = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) % 10000) / 10000
  }
  for (let x = TREE_GRID / 2; x < track.extent; x += TREE_GRID) {
    for (let z = TREE_GRID / 2; z < track.extent; z += TREE_GRID) {
      // Drawn for every cell so removing one cell does not reshuffle the rest.
      const jx = (rand() - 0.5) * TREE_GRID * 0.8
      const jz = (rand() - 0.5) * TREE_GRID * 0.8
      const pick = rand()
      const turn = rand() * 360
      const px = x + jx
      const pz = z + jz
      if (pick > 0.55) continue
      const clearance = solids.distance(px, pz)
      if (clearance < TREE_MIN_CLEARANCE || clearance > TREE_MAX_CLEARANCE) continue
      let inside = false
      for (const b of buildings) {
        if (rectDistance(b, px, pz) < 4) {
          inside = true
          break
        }
      }
      if (inside) continue
      push(pick < 0.3 ? 'tree-a' : manifest['palm'] ? 'palm' : 'tree-b', 'scenery', px, pz, turn, nearestGroup(line, px, pz))
    }
  }

  return out
}

/** Streaming group of a point: the 30 m sector of the closest line point, by distance ring. */
function nearestGroup(line: LinePoint[], x: number, z: number): number {
  let best = Infinity
  let s = 0
  for (const p of line) {
    const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z)
    if (d < best) {
      best = d
      s = p.s
    }
  }
  return Math.floor(s / SECTOR_LENGTH) * SECTOR_RINGS + Math.min(SECTOR_RINGS - 1, Math.floor(Math.sqrt(best) / RING_WIDTH))
}

// --- Streaming --------------------------------------------------------------

export type Group = {
  id: number
  items: number[]
  /** Centre and radius of the circle holding every item, for the cheap visibility test. */
  cx: number
  cz: number
  radius: number
  tris: number
  near: boolean
}

export function groupDecor(items: Placed[]): Group[] {
  // A sector's near-only pieces are a group of their own, so each tier has its own range.
  const byId = new Map<number, number[]>()
  items.forEach((item, i) => {
    const id = item.group * 2 + (item.near ? 1 : 0)
    const list = byId.get(id)
    if (list) list.push(i)
    else byId.set(id, [i])
  })
  const groups: Group[] = []
  byId.forEach((members, id) => {
    let cx = 0
    let cz = 0
    let tris = 0
    for (const i of members) {
      cx += items[i].x
      cz += items[i].z
      tris += items[i].tris
    }
    cx /= members.length
    cz /= members.length
    let radius = 0
    for (const i of members) radius = Math.max(radius, Math.hypot(items[i].x - cx, items[i].z - cz))
    groups.push({ id, items: members, cx, cz, radius, tris, near: items[members[0]].near })
  })
  return groups
}

export const VIEW_RADIUS = 160
export const NEAR_RADIUS = 90
/** Half of the visible cone, degrees: wide enough that a turn does not show an empty world. */
export const VIEW_HALF_ANGLE = 110

/**
 * Whether a group is shown from `focus`. `heading` is where the camera looks (unit, XZ);
 * null shows everything within range, which is what a parked car or a standing avatar gets.
 */
export function groupVisible(group: Group, fx: number, fz: number, heading: { x: number; z: number } | null): boolean {
  const dx = group.cx - fx
  const dz = group.cz - fz
  const d = Math.hypot(dx, dz)
  if (d - group.radius > (group.near ? NEAR_RADIUS : VIEW_RADIUS)) return false
  if (heading === null || d <= group.radius) return true
  // The group is a circle, so the cone is widened by the angle that circle subtends.
  const cosAngle = (dx * heading.x + dz * heading.z) / d
  const angle = (Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180) / Math.PI
  const widen = (Math.asin(Math.min(1, group.radius / d)) * 180) / Math.PI
  return angle <= VIEW_HALF_ANGLE + widen
}
