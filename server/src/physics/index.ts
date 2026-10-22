/**
 * Which physics engine the server runs.
 *
 * Rapier is the default and is what the car is tuned against. Cannon exists because it is
 * the only one of the two that can also run in the Decentraland scene, so it is what
 * client-side prediction would have to be built on; being able to switch with an
 * environment variable is what makes it possible to compare them on the same circuit,
 * with the same tests, before committing to either.
 *
 *   PHYSICS=cannon npm run test:features
 *   PHYSICS=cannon npm run harness
 */

import { CannonWorld } from './cannon'
import { initRapier, RapierWorld } from './rapier'
import type { Track } from '../../../shared/tracks'
import type { PhysicsWorld } from './types'

export type EngineName = 'rapier' | 'cannon'

export function selectedEngine(): EngineName {
  return process.env.PHYSICS === 'cannon' ? 'cannon' : 'rapier'
}

/** Prepares whatever the engine needs before a world can exist (Rapier loads wasm). */
export async function initPhysics(): Promise<void> {
  if (selectedEngine() === 'rapier') await initRapier()
}

/** A world holding `track`'s colliders. A different circuit is a different world. */
export function createWorld(track: Track): PhysicsWorld {
  return selectedEngine() === 'cannon' ? new CannonWorld(track) : new RapierWorld(track)
}

/** The engine's name without building a world for it: every room builds its own. */
export function engineName(): string {
  return selectedEngine() === 'cannon' ? 'cannon-es' : 'rapier3d'
}
