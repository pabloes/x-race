/**
 * Where the physics server lives.
 *
 * The scene runtime has no environment variables, so the two URLs are both compiled in and
 * the right one is picked at startup: `getRealm()` reports whether the scene is running as
 * a local preview or published in Decentraland, and that is exactly the question being
 * asked. Choosing by hand is how the scene ended up published against `ws://localhost`
 * once and tested against the wrong server twice in one afternoon.
 *
 * A published scene needs a `wss://` URL: browsers refuse plain `ws://` from an HTTPS page
 * and the explorer is no exception. The scene only needs the `USE_WEBSOCKET` permission,
 * already set in scene.json.
 */

import { getRealm } from '~system/Runtime'

/** Where `npm run server` listens. */
export const LOCAL_SERVER_URL = 'ws://localhost:8787'
/** The CapRover app. Change this line when the server moves. */
export const REMOTE_SERVER_URL = 'wss://elon-roadster-race.zeroxwork.com'

/**
 * Drive the deployed server from the preview.
 *
 * Normally the preview talks to `npm run server` on this machine, which is what you want
 * while changing the physics. It is not what you want when the question is how the game
 * feels over a real connection: that needs the preview pointed at the deployed server,
 * and this is the one line that does it. Harmless if it is left on — a published scene
 * uses the remote server either way.
 */
const PREVIEW_AGAINST_REMOTE = false

/**
 * The server this run should talk to: the local one in preview, the deployed one when
 * published. If the realm cannot be read for any reason, the deployed server is the safe
 * answer — a published scene pointing at localhost reaches nobody.
 */
export async function serverUrl(): Promise<string> {
  if (PREVIEW_AGAINST_REMOTE) return REMOTE_SERVER_URL
  try {
    const { realmInfo } = await getRealm({})
    return realmInfo?.isPreview ? LOCAL_SERVER_URL : REMOTE_SERVER_URL
  } catch {
    return REMOTE_SERVER_URL
  }
}

/** Shown in the standings. The scene could read the signed-in profile instead. */
export const PLAYER_NAME = 'driver'
