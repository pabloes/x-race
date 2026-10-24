/**
 * Whether this is a touch explorer.
 *
 * The scene cannot feel a finger: there is no touch event, and the input system reports
 * the same actions whatever is pressing them. What it can do is ask the runtime what it
 * is running on, once, at startup. The answer decides whether the on-screen driving
 * controls are drawn at all — on a desktop they would be clutter over a keyboard that
 * already works — and whether the jump button means throttle.
 *
 * `getExplorerInformation` names the platform outright ("desktop", "mobile", "vr", "web");
 * the older `getPlatform` is the fallback for an explorer that does not answer it, matched
 * loosely. Either way the default is desktop: drawing nothing extra is the safe way to be
 * wrong.
 */

import { getPlatform } from '~system/EnvironmentApi'
import { getExplorerInformation } from '~system/Runtime'

let mobile = false

export function isMobile(): boolean {
  return mobile
}

export async function detectPlatform(): Promise<void> {
  try {
    const info = await getExplorerInformation({})
    mobile = String(info.platform ?? '').toLowerCase() === 'mobile'
    console.log(`[roadster] explorer "${info.platform}" (${info.agent}) -> ${mobile ? 'touch controls' : 'keyboard'}`)
    return
  } catch {
    // Older explorer: ask the deprecated API instead.
  }
  try {
    const result = await getPlatform({})
    mobile = /mobile|android|ios|phone|tablet/i.test(result.platform ?? '')
    console.log(`[roadster] platform "${result.platform}" -> ${mobile ? 'touch controls' : 'keyboard'}`)
  } catch {
    mobile = false
  }
}
