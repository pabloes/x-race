/**
 * Car audio, driven by the same snapshot flags the visuals use.
 *
 * Every car carries four looping sources parented to its root, so the sound is positional
 * for free: a rival boosting past you is loud on the way through and quiet behind. The
 * clips are synthesised by `tools/make-sounds.py` rather than sampled, and the engine one
 * is deliberately flat — the pitch comes from road speed here, which is what makes it read
 * as acceleration rather than as a drone.
 *
 * Writes are rationed the same way `car.ts` rations visibility: an AudioSource change is a
 * CRDT message to the renderer, so volume and pitch are quantised and only written when
 * they actually move. A car that stops reporting takes its sources with it, because they
 * hang off the root the visuals destroy.
 *
 * Braking is the one sound that does not come from a snapshot: there is no brake bit on the
 * wire, and adding one to send a sound effect would be the tail wagging the dog. The local
 * player's own input is used instead, which has the side benefit of being instant — no
 * interpolation delay between stamping the pedal and hearing the tyres.
 */

import { AudioSource, engine, Entity, Transform } from '@dcl/sdk/ecs'
import { CAR } from '../../shared/constants'
import { quatRotate } from '../../shared/math'
import { CarFlag } from '../../shared/protocol'
import { DRIVABLE_HALF_WIDTH, lineOffset } from '../../shared/track'
import type { SampledCar } from './net/snapshot-buffer'

const CLIPS = {
  engine: 'sounds/engine.mp3',
  brake: 'sounds/brake.mp3',
  boost: 'sounds/boost.mp3',
  thruster: 'sounds/thruster.mp3',
  gravel: 'sounds/gravel.mp3',
  applause: 'sounds/applause.mp3'
}

/** Below this speed the tyres are rolling, not scrubbing: no screech. */
const SCRUB_SPEED = 4
/**
 * Sideways speed, in m/s, at which the tyres start to protest.
 *
 * This is computed here rather than sent: the snapshot already carries the velocity and
 * the orientation, and the sideways component is the dot product of the two. Doing it on
 * the client means every car on track screeches when it slides, not just yours, which is
 * most of what a drift sounds like from the outside.
 */
const SLIDE_SPEED = 3.5
/** Smallest volume change worth sending to the renderer. */
const VOLUME_STEP = 0.04
/**
 * Pitch is quantised far finer than volume. A coarse step is audible for exactly what it
 * is: the engine note jumping from one value to the next as the car accelerates sounds
 * like a gearbox changing up, which is the one thing an electric car should not do. At
 * 0.01 a step is a few hertz on a 420 Hz whine, and the write still only happens while
 * the speed is actually changing — at a constant speed nothing is sent at all.
 */
const PITCH_STEP = 0.01

type Loop = { entity: Entity; playing: boolean; volume: number; pitch: number }

type CarAudio = {
  engine: Loop
  brake: Loop
  boost: Loop
  thruster: Loop
  gravel: Loop
}

const audio = new Map<number, CarAudio>()
let cheerEntity: Entity | null = null

function loop(parent: Entity, clip: string, volume: number): Loop {
  const entity = engine.addEntity()
  Transform.create(entity, { parent, position: { x: 0, y: 0, z: 0 } })
  AudioSource.create(entity, {
    audioClipUrl: clip,
    loop: true,
    playing: false,
    volume,
    pitch: 1
  })
  return { entity, playing: false, volume, pitch: 1 }
}

function create(root: Entity): CarAudio {
  return {
    engine: loop(root, CLIPS.engine, 0.2),
    brake: loop(root, CLIPS.brake, 0.5),
    boost: loop(root, CLIPS.boost, 0.6),
    thruster: loop(root, CLIPS.thruster, 0.55),
    gravel: loop(root, CLIPS.gravel, 0.5)
  }
}

/**
 * Whether a car is off the asphalt, worked out here rather than sent.
 *
 * The server already does this test to decide how much grip the car has; repeating it on
 * the client costs a short search along the racing line and saves putting a flag on the
 * wire for a sound effect. The index each car was last found at is kept so the search
 * starts beside the answer, exactly as the server does it.
 */
const lineHint = new Map<number, number>()

function offTrack(car: SampledCar): boolean {
  const { distance, index } = lineOffset(car.pos, lineHint.get(car.id) ?? 0)
  lineHint.set(car.id, index)
  return distance > DRIVABLE_HALF_WIDTH
}

/** Applies a loop's state, touching the component only when something moved. */
function set(entry: Loop, playing: boolean, volume = entry.volume, pitch = entry.pitch): void {
  const movedVolume = Math.abs(volume - entry.volume) > VOLUME_STEP
  const movedPitch = Math.abs(pitch - entry.pitch) > PITCH_STEP
  if (entry.playing === playing && !movedVolume && !movedPitch) return
  const source = AudioSource.getMutable(entry.entity)
  if (entry.playing !== playing) {
    entry.playing = playing
    source.playing = playing
  }
  if (movedVolume) {
    entry.volume = volume
    source.volume = volume
  }
  if (movedPitch) {
    entry.pitch = pitch
    source.pitch = pitch
  }
}

/**
 * One car's worth of sound for this frame.
 *
 * `braking` is only meaningful for the local car; remote cars pass false, so you hear your
 * own tyres and not a phantom skid from someone else's controls.
 */
export function updateCarAudio(car: SampledCar, root: Entity, braking: boolean): void {
  const entry = audio.get(car.id) ?? create(root)
  if (!audio.has(car.id)) audio.set(car.id, entry)

  if ((car.flags & CarFlag.Respawning) !== 0) {
    silence(entry)
    return
  }

  // Road speed, not the forward component: the car is just as fast sideways in a drift.
  const speed = Math.sqrt(car.vel.x * car.vel.x + car.vel.z * car.vel.z)
  const load = Math.min(speed / CAR.maxSpeed, 1.4)
  const boosting = (car.flags & CarFlag.Boosting) !== 0
  const thrusting = (car.flags & CarFlag.Thrusting) !== 0
  const inverted = (car.flags & CarFlag.Inverted) !== 0
  const airborne = (car.flags & CarFlag.Airborne) !== 0

  // The motor whine climbs with speed and lifts again under boost. It keeps idling when
  // stopped, so a car on the grid is still a car and not a prop.
  set(entry.engine, true, 0.12 + load * 0.3 + (boosting ? 0.1 : 0), 0.7 + load * 0.95)
  // Tyres scrub when they are dragged sideways as well as when they are locked up, and
  // wheels off the ground have nothing to screech against either way.
  const right = quatRotate(car.rot, { x: 1, y: 0, z: 0 })
  const slide = Math.abs(car.vel.x * right.x + car.vel.y * right.y + car.vel.z * right.z)
  const scrubbing = !airborne && speed > SCRUB_SPEED && (braking || slide > SLIDE_SPEED)
  set(entry.brake, scrubbing, 0.2 + Math.min(slide / 10, 0.5), 0.9 + load * 0.3)
  set(entry.boost, boosting, 0.6, 0.95 + load * 0.25)
  // Inverted, the jets holding the car against the ceiling are the small attitude ones:
  // same gas, thinner nozzles, so the same clip an octave up reads as the right hardware.
  set(entry.thruster, thrusting, inverted ? 0.45 : 0.55, inverted ? 1.5 : 1)
  // Stones under the car: only while it is actually moving over them, and louder the
  // faster it is being dragged through.
  const onGravel = !airborne && speed > 1.5 && offTrack(car)
  set(entry.gravel, onGravel, 0.25 + Math.min(speed / CAR.gravelMaxSpeed, 1.4) * 0.45, 0.85 + load * 0.3)
}

function silence(entry: CarAudio): void {
  set(entry.engine, false)
  set(entry.brake, false)
  set(entry.boost, false)
  set(entry.thruster, false)
  set(entry.gravel, false)
}

/**
 * Forgets any car that was not in this frame's snapshot (left the race).
 *
 * The sources themselves are not touched: they are parented to the car's root, so
 * `dropMissing` in `car.ts` has already destroyed them along with it. All that is left
 * here is the bookkeeping, and it has to go in the same frame — writing a volume to a
 * destroyed AudioSource is a write into nothing.
 */
export function forgetMissing(present: Map<number, SampledCar>): void {
  for (const id of audio.keys()) {
    if (!present.has(id)) audio.delete(id)
  }
  for (const id of lineHint.keys()) {
    if (!present.has(id)) lineHint.delete(id)
  }
}

/**
 * The crowd, for a trick. Global rather than positional: it is the scene reacting to you,
 * not a loudspeaker somewhere on the circuit.
 */
export function cheer(): void {
  if (cheerEntity === null) {
    cheerEntity = engine.addEntity()
    Transform.create(cheerEntity)
    AudioSource.create(cheerEntity, {
      audioClipUrl: CLIPS.applause,
      loop: false,
      playing: false,
      volume: 0.8,
      global: true
    })
  }
  AudioSource.playSound(cheerEntity, CLIPS.applause, true)
}
