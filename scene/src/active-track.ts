/**
 * The circuit the room is racing on, as far as this scene knows.
 *
 * Everything that draws or measures the circuit (track-render, the HUD map and checkpoint
 * count, the gravel sound) reads it from here rather than holding a circuit of its own, so
 * when the room switches circuit there is exactly one thing to change.
 */

import {
  checkpointsOf,
  DEFAULT_TRACK,
  trackById,
  type Track,
  type TrackId,
  type Trigger
} from '../../shared/tracks'

let track: Track = trackById(DEFAULT_TRACK)
/** Kept, because the HUD asks for the next checkpoint every frame. */
let checkpoints: Trigger[] = checkpointsOf(track)

export function activeTrack(): Track {
  return track
}

export function activeCheckpoints(): Trigger[] {
  return checkpoints
}

/** Switches circuit. Returns false when it already was the active one. */
export function setActiveTrack(id: TrackId): boolean {
  if (track.base === id) return false
  track = trackById(id)
  checkpoints = checkpointsOf(track)
  return true
}
