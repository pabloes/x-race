/**
 * Reads the keyboard into the protocol's input bits.
 *
 * Decentraland exposes digital input actions rather than axes, which is why the wire
 * format is a bitfield. The movement keys keep reporting through `inputSystem.isPressed`
 * while InputModifier has the avatar's locomotion disabled — that separation is the whole
 * point of InputModifier, and it is what lets WASD drive the car instead of the avatar.
 *
 *   W / S   throttle, brake (and nose down / nose up while airborne)
 *   W W     double tap and hold: speed boost, spends the charge bar
 *   A / D   steer
 *   Shift   handbrake, for sliding a corner
 *   Space   cold-gas thrusters, lifts the car straight up (spends charge fast)
 *   E       assisted barrel roll, while airborne
 *   F       request a respawn at the last checkpoint
 *
 * The double tap is detected here rather than on the server: it is a property of how the
 * player pressed the key, and the server only ever needs to know whether boost is on.
 */

import { InputAction, inputSystem, PointerEventType } from '@dcl/sdk/ecs'
import { TRICK } from '../../shared/constants'
import { InputBit } from '../../shared/protocol'

/** Milliseconds since the scene started, advanced by the caller each frame. */
let now = 0
/** When the throttle was last released, for double-tap detection. */
let releasedAt = -Infinity
let wasThrottle = false
/** Latched by a second tap, cleared when the throttle is let go. */
let boostArmed = false

export function readInputBits(dt: number): number {
  now += dt * 1000

  const throttle = inputSystem.isPressed(InputAction.IA_FORWARD)
  if (throttle && !wasThrottle) {
    // A press that follows a release closely enough is the second half of a double tap.
    if (now - releasedAt <= TRICK.doubleTapMs) boostArmed = true
  } else if (!throttle && wasThrottle) {
    releasedAt = now
    boostArmed = false
  }
  wasThrottle = throttle

  let bits = 0
  if (throttle) bits |= InputBit.Throttle
  if (boostArmed && throttle) bits |= InputBit.Boost
  if (inputSystem.isPressed(InputAction.IA_BACKWARD)) bits |= InputBit.Brake
  if (inputSystem.isPressed(InputAction.IA_LEFT)) bits |= InputBit.Left
  if (inputSystem.isPressed(InputAction.IA_RIGHT)) bits |= InputBit.Right
  if (inputSystem.isPressed(InputAction.IA_WALK)) bits |= InputBit.Handbrake
  if (inputSystem.isPressed(InputAction.IA_JUMP)) bits |= InputBit.Thrust
  if (inputSystem.isPressed(InputAction.IA_PRIMARY)) bits |= InputBit.Flip
  return bits
}

/** True on the frame the respawn key goes down. */
export function respawnPressed(): boolean {
  return inputSystem.isTriggered(InputAction.IA_SECONDARY, PointerEventType.PET_DOWN)
}
