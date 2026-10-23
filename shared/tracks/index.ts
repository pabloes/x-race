/**
 * Every circuit the game knows, built once per process from its definition.
 *
 * This is the only module that imports a concrete circuit; everything else is handed a
 * `Track` (the room, the car simulation, physics, bots, the scene) and works on whichever
 * one it is given.
 */

import { CITY } from './city'
import { buildTrack } from './generator'
import { SKYLINE } from './skyline'
import type { Track, TrackId } from './types'

export * from './types'
export { checkpointsOf, DRIVABLE_HALF_WIDTH, lineOffset, respawnFor, spawnHeightAt } from './generator'

export const TRACKS: Record<TrackId, Track> = {
  city: buildTrack(CITY),
  skyline: buildTrack(SKYLINE)
}

export const DEFAULT_TRACK: TrackId = 'city'

/** Ids in menu order. */
export const TRACK_IDS = Object.keys(TRACKS) as TrackId[]

export function isTrackId(value: unknown): value is TrackId {
  return typeof value === 'string' && TRACK_IDS.indexOf(value as TrackId) !== -1
}

export function trackById(id: TrackId): Track {
  return TRACKS[id]
}

/** The geometry hash a track's id carries, which is what server and scene compare. */
export function trackFingerprint(track: Track): string {
  return track.id.slice(track.base.length + 1)
}
