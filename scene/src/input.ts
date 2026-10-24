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
 * On a phone the explorer's own buttons stand in for some keys: jump is the throttle
 * (thrusters move to an on-screen LIFT button), E rolls and F respawns, the same actions
 * as on a keyboard. Steering, lift and boost are buttons of ours (`touch`). The explorer's
 * hand button is IA_POINTER, which every touch on a phone also fires, our buttons
 * included, so nothing reads it.
 *
 * The double tap is detected here rather than on the server: it is a property of how the
 * player pressed the key, and the server only ever needs to know whether boost is on.
 */

import { InputAction, inputSystem, PointerEventType } from '@dcl/sdk/ecs'
import { TRICK } from '../../shared/constants'
import { InputBit } from '../../shared/protocol'
import { isMobile } from './platform'

/**
 * What the on-screen buttons are holding down, for explorers with no keyboard.
 *
 * Both steering buttons at once is the brake (and reverse): a phone has no room for a
 * fourth big button on the left, and pressing both is not otherwise a thing anyone does.
 * BOOST is the throttle as well, because the thumb on it cannot also be on jump.
 */
export const touch = {
  left: false,
  right: false,
  lift: false,
  boost: false
}

/** Milliseconds since the scene started, advanced by the caller each frame. */
let now = 0
/** When the throttle was last pressed and last released, for double-tap detection. */
let pressedAt = -Infinity
let releasedAt = -Infinity
let wasThrottle = false
/** Latched by a second tap, cleared when the throttle is let go. */
let boostArmed = false

export function readInputBits(dt: number): number {
  now += dt * 1000

  const mobile = isMobile()
  const throttle =
    inputSystem.isPressed(InputAction.IA_FORWARD) ||
    (mobile && inputSystem.isPressed(InputAction.IA_JUMP)) ||
    touch.boost
  if (throttle && !wasThrottle) {
    // A double tap is a *tap* and then a press: the one before this has to have been
    // short as well as recent. Timing only the gap meant that any brief lift of the
    // throttle re-armed the boost on the way back in — and since letting go is the only
    // way to end a boost, the boost would not drop until you had stayed off the throttle
    // for the whole window, which is a long time to coast in the middle of a corner.
    const tapped = releasedAt - pressedAt <= TRICK.doubleTapMs
    if (now - releasedAt <= TRICK.doubleTapMs && tapped) boostArmed = true
    pressedAt = now
  } else if (!throttle && wasThrottle) {
    releasedAt = now
    boostArmed = false
  }
  wasThrottle = throttle

  let bits = 0
  if (throttle) bits |= InputBit.Throttle
  if ((boostArmed && throttle) || touch.boost) bits |= InputBit.Boost
  const touchBrake = touch.left && touch.right
  if (inputSystem.isPressed(InputAction.IA_BACKWARD) || touchBrake) bits |= InputBit.Brake
  if (inputSystem.isPressed(InputAction.IA_LEFT) || (touch.left && !touchBrake)) bits |= InputBit.Left
  if (inputSystem.isPressed(InputAction.IA_RIGHT) || (touch.right && !touchBrake)) bits |= InputBit.Right
  if (inputSystem.isPressed(InputAction.IA_WALK)) bits |= InputBit.Handbrake
  if ((!mobile && inputSystem.isPressed(InputAction.IA_JUMP)) || touch.lift) bits |= InputBit.Thrust
  if (inputSystem.isPressed(InputAction.IA_PRIMARY)) bits |= InputBit.Flip
  return bits
}

/**
 * The battery ran dry, so stop asking for boost.
 *
 * The latch is the client's: the server only reads the bit, and it drops the boost of its
 * own accord at an empty bar. Left armed, the request survives the battery, and the next
 * charge pad or long drift relights the boost mid-corner without the driver having asked
 * for it again. Clearing it here means a boost always starts with a double tap, which is
 * also what the dark lamp on the HUD then says.
 */
export function dropBoost(): void {
  boostArmed = false
}

/** True on the frame the respawn key goes down. */
export function respawnPressed(): boolean {
  return inputSystem.isTriggered(InputAction.IA_SECONDARY, PointerEventType.PET_DOWN)
}
