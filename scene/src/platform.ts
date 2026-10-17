/**
 * Whether this is a touch explorer.
 *
 * The scene cannot feel a finger: there is no touch event, and the input system reports
 * the same actions whatever is pressing them. What it can do is ask the runtime what it
 * is running on, once, at startup. The answer decides whether the on-screen driving
 * controls are drawn at all — on a desktop they would be clutter over a keyboard that
 * already works.
 *
 * `getPlatform` is marked deprecated in the runtime typings and is still the only thing
 * that answers this question, so the string is matched loosely and the fallback is
 * desktop: drawing nothing extra is the safe way to be wrong.
 */

import { getPlatform } from '~system/EnvironmentApi'

let mobile = false

export function isMobile(): boolean {
  return mobile
}

export async function detectPlatform(): Promise<void> {
  try {
    const result = await getPlatform({})
    mobile = /mobile|android|ios|phone|tablet/i.test(result.platform ?? '')
    console.log(`[roadster] platform "${result.platform}" -> ${mobile ? 'touch controls' : 'keyboard'}`)
  } catch {
    mobile = false
  }
}
