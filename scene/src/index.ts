/**
 * Scene entry point.
 *
 * The client's whole job is: read input, ship it to the server, and draw the world the
 * server reports. It runs no physics of its own, so there is no divergence to reconcile —
 * what every player sees is the same authoritative simulation, just rendered
 * INTERPOLATION_DELAY_MS in the past so it can always interpolate rather than guess.
 *
 * One system per frame:
 *  1. advance the local clock and the connection (input send, ping, reconnect)
 *  2. sample every car from the snapshot buffer at the render instant and draw it
 *  3. keep the chase camera on our own car and refresh the HUD
 */

import { engine } from '@dcl/sdk/ecs'
import { SNAPSHOT_RATE, TICK_RATE } from '../../shared/constants'
import { vlen } from '../../shared/math'
import { CarFlag, InputBit, type GameEvent, type PlayerInfo, type Standing } from '../../shared/protocol'
import { isTrackId, trackById } from '../../shared/tracks'
import { activeCheckpoints, activeTrack, setActiveTrack } from './active-track'
import { cheer, forgetMissing, updateCarAudio } from './audio'
import { carRoot, dropMissing, parkCar, renderCar, setDriverNames } from './car'
import { updateSkidmarks } from './skidmarks'
import { detach, follow } from './camera'
import { playerIdentity, serverUrl } from './config'
import { dropBoost, readInputBits, respawnPressed } from './input'
import { Connection } from './net/connection'
import { SPIKE_CANNON, startCannonSpike } from './spike-cannon'
import { detectPlatform } from './platform'
import { setDecorFocus } from './decor'
import { buildTrack, clearTrack } from './track-render'
import { hud, menu, setupUi } from './ui'

/**
 * What the speedometer multiplies the real speed by.
 *
 * Display only: the simulation is unchanged, and every distance on this circuit is laid
 * out against the real figure. The car tops out at 30 m/s, which is a true 108 km/h, and
 * at the scale of a Decentraland parcel that reads as slower than it feels. 1.5 puts the
 * needle where the driving says it should be: about 160 flat out, 215 on boost.
 */
const SPEEDO_EXAGGERATION = 1.5

/** Monotonic scene clock in ms, accumulated from frame deltas. */
let localNow = 0
let players: PlayerInfo[] = []
/** This frame's own input bits, kept for the sounds that have no flag on the wire. */
let inputBits = 0
/**
 * What the flyover is captioned with, from the `track` event. Kept apart from the HUD,
 * because the event can land a snapshot before the phase leaves the lobby, and the lobby
 * clears the big message every frame; it is dropped once the countdown starts.
 */
let trackNotice = ''

const connection = new Connection({
  onEvents: handleEvents,
  onPlayers: (list) => {
    players = list
    const me = list.find((p) => p.id === connection.playerId)
    hud.spectator = me?.spectator === true
    setDriverNames(list, connection.playerId)
  },
  onStandings: (list) => {
    hud.standings = list
  }
})

function toast(message: string, ms = 2200): void {
  hud.toast = message
  hud.toastMs = ms
}

function handleEvents(events: GameEvent[]): void {
  for (const event of events) {
    const mine = 'id' in event && event.id === connection.playerId
    switch (event.t) {
      case 'countdown':
        hud.bigMessage = 'GET READY'
        break
      case 'go':
        hud.bigMessage = 'GO!'
        setTimeout(() => {
          if (hud.bigMessage === 'GO!') hud.bigMessage = ''
        }, 900)
        break
      case 'trick':
        if (mine) {
          toast(`${event.name}  +${event.points}`)
          cheer()
        }
        break
      case 'lap':
        if (mine) toast(`LAP ${event.lap}  ${event.best ? 'BEST ' : ''}${(event.lapMs / 1000).toFixed(2)}s`)
        break
      case 'pad':
        if (mine) toast('CHARGE PAD')
        break
      case 'respawn':
        if (mine) toast('RESPAWN')
        break
      case 'invert':
        if (mine && event.entered) toast('ROADSTER FLIP')
        break
      case 'finish':
        if (mine) hud.bigMessage = `FINISHED  P${event.rank}`
        break
      case 'race-end':
        hud.standings = event.standings
        hud.bigMessage = podiumText(event.standings)
        break
      case 'track':
        // The vote has been counted. Said out loud when a draw decided it, because
        // otherwise a circuit nobody seems to have picked just appears.
        if (isTrackId(event.track)) {
          const name = trackById(event.track).name
          trackNotice = event.tie ? `${name}, BY DRAW` : name
        }
        break
    }
  }
}

function podiumText(standings: Standing[]): string {
  const winner = standings.find((s) => s.rank === 1)
  return winner ? `WINNER: ${winner.name}` : 'RACE OVER'
}

function netSystem(dt: number): void {
  localNow += dt * 1000
  connection.update(dt, localNow)
  inputBits = readInputBits(dt)
  connection.setInput(inputBits)
  if (respawnPressed()) connection.requestRespawn()
}

function renderSystem(dt: number): void {
  // The local car is sampled on a much shorter delay than the rest; see the buffer.
  const cars = connection.buffer.sample(localNow, connection.playerId)
  const braking = (inputBits & (InputBit.Brake | InputBit.Handbrake)) !== 0
  hud.boostRequested = (inputBits & InputBit.Boost) !== 0
  for (const [, car] of cars) {
    renderCar(car)
    updateSkidmarks(car)
    const root = carRoot(car.id)
    if (root !== null) updateCarAudio(car, root, braking && car.id === connection.playerId)
  }
  dropMissing(cars)
  forgetMissing(cars)

  hud.blips = []
  for (const [, car] of cars) {
    if ((car.flags & CarFlag.Respawning) !== 0) continue
    hud.blips.push({ id: car.id, x: car.pos.x, z: car.pos.z, mine: car.id === connection.playerId })
  }

  const mine = cars.get(connection.playerId)
  // Cinematic hook. While the room's phase is 'intro' the flyover owns the camera, in
  // place of `follow`/`detach`: with scene/src/cinematic.ts merged, `introElapsedMs(race
  // phase, phaseMs, dt)` and then `playIntro(activeTrack(), activeTrack().intro, elapsed)`,
  // reading `connection.buffer.latestRace()` like the HUD does.
  setDecorFocus(mine ? { x: mine.pos.x, z: mine.pos.z } : null)
  if (mine) {
    follow(mine, dt)
    hud.speedKmh = vlen(mine.vel) * 3.6 * SPEEDO_EXAGGERATION
    hud.charge = mine.charge
    // Empty battery: the car has already stopped boosting, so stop asking for it too.
    if (mine.charge <= 0) dropBoost()
    hud.flags = mine.flags
    hud.lap = mine.lap
    hud.rank = mine.rank
    hud.score = mine.score
    hud.checkpoint = mine.cp + 1
    // Checkpoints are mandatory and in order, so "next" is simply the one after the last
    // one taken, wrapping back to the start line at the end of a lap.
    const checkpoints = activeCheckpoints()
    const next = (mine.cp + 1) % checkpoints.length
    hud.nextCheckpoint = {
      x: checkpoints[next].pos.x,
      z: checkpoints[next].pos.z,
      label: `${next + 1}/${checkpoints.length}`
    }
  } else {
    detach()
    hud.nextCheckpoint = null
  }
  hud.drivers = cars.size > 0 ? cars.size : players.length
}

function hudSystem(dt: number): void {
  const race = connection.buffer.latestRace()
  hud.connected = connection.status === 'connected' && connection.playerId >= 0
  hud.pingMs = connection.roundTripMs
  // Smoothed, because a per-frame reciprocal of dt is unreadable.
  hud.fps += (1 / Math.max(dt, 0.001) - hud.fps) * 0.1
  // The menu folds into its button over a third of a second, rather than cutting, so it
  // is obvious where it went and where to click to get it back.
  const target = hud.menuMinimised ? 0 : 1
  const step = dt / 0.32
  hud.menuAnim = target > hud.menuAnim
    ? Math.min(target, hud.menuAnim + step)
    : Math.max(target, hud.menuAnim - step)
  hud.snapshotGapMs = connection.buffer.lastGapMs
  hud.trackMismatch = connection.trackMismatch
  hud.extrapolationMs = connection.buffer.extrapolatingMs
  hud.statusText =
    connection.status === 'offline'
      ? `offline — ${connection.lastError || 'reconnecting'}`
      : connection.playerId < 0
        ? 'joining race…'
        : 'connecting to race server…'

  if (race) {
    // The room switched circuit: take the old one down and draw the new one. Compared by
    // id rather than on the `track` event, so a player who joins after the switch, or
    // misses the event, still ends up on the circuit the room is racing on.
    if (isTrackId(race.track) && setActiveTrack(race.track)) {
      clearTrack()
      buildTrack(activeTrack())
      hud.checkpoints = activeTrack().checkpointCount
      hud.track = race.track
    }
    hud.votes = race.votes ?? {}
    // A vote lives for one lobby, on the server and so here.
    if (race.phase !== 'lobby') hud.myVote = null
    hud.phase = race.phase
    hud.phaseMs = race.phaseMs
    hud.raceTimeMs = race.timeMs
    hud.laps = race.laps
    hud.mode = race.mode
    hud.bots = race.bots
    hud.joining = race.joining
    if (race.phase === 'countdown') {
      trackNotice = ''
      const seconds = Math.ceil(race.phaseMs / 1000)
      hud.bigMessage = seconds > 0 ? String(seconds) : 'GO!'
    } else if (race.phase === 'intro') {
      // Whoever arrives mid-flyover missed the event, but should still see the name.
      hud.bigMessage = trackNotice !== '' ? trackNotice : activeTrack().name
    } else if (race.phase === 'lobby') {
      // The menu is on screen in the lobby and says this itself; printing it again in the
      // middle of the screen just put two texts on top of each other.
      hud.bigMessage = ''
    } else if (race.phase === 'racing' && hud.bigMessage !== 'GO!' && !hud.bigMessage.startsWith('FINISHED')) {
      hud.bigMessage = ''
    }
  }

  if (hud.toastMs > 0) {
    hud.toastMs -= dt * 1000
    if (hud.toastMs <= 0) hud.toast = ''
  }
}

export function main(): void {
  // Asked once: it decides whether the on-screen driving controls exist at all.
  void detectPlatform()
  buildTrack(activeTrack())
  // A Roadster parked on the gravel beside the grid, where the avatar arrives (the
  // `paddock` spawn point in scene.json), nose towards the newcomer. On the gravel plane,
  // which sits a centimetre up, so the wheels rest on it rather than in it.
  parkCar({ x: 255.5, y: 0.66, z: 46.5 }, 275)
  // Measurement only, on the cannon-prediction branch: see spike-cannon.ts. Off unless
  // it is being read, because a cannon world stepping in the scene thread is exactly the
  // sort of thing that makes the car feel late while you are trying to judge the car.
  if (SPIKE_CANNON) startCannonSpike()
  setupUi()
  // The top bar only ever asks; the room decides, and the next snapshot tells us what it
  // decided. Nothing here mutates the local settings optimistically.
  menu.setMode = (mode) => connection.setMode(mode)
  menu.setBots = (count) => connection.setBots(count)
  menu.setLaps = (laps) => connection.setLaps(laps)
  // Highlighted straight away: the server sends no confirmation, only the count.
  menu.vote = (track) => {
    hud.myVote = track
    connection.vote(track)
  }
  menu.start = () => connection.startRace()
  menu.leaveRace = () => connection.leaveRace()
  menu.setSpectator = (on) => connection.spectate(on)

  // The realm has to be asked before the first socket is opened, so the connection starts
  // one turn of the event loop later than everything else. The HUD already says
  // "connecting to race server…" until the welcome lands, so there is nothing to hide.
  void Promise.all([serverUrl(), playerIdentity()]).then(([url, identity]) => {
    connection.identity = identity
    console.log(`[roadster] server ${url} as ${identity.name}${identity.address ? ` (${identity.address})` : ' (guest)'}`)
    // Strip the scheme: the host is the part worth a line of the HUD.
    hud.serverHost = url.replace(/^wss?:\/\//, '')
    connection.connect(url)
    // Ready by default, so a multiplayer lobby is not waiting on us.
    connection.setReady(true)
  })

  engine.addSystem(netSystem, 200)
  engine.addSystem(renderSystem, 100)
  engine.addSystem(hudSystem, 50)

  console.log(`[roadster] client up — rendering ${TICK_RATE} Hz simulation from ${SNAPSHOT_RATE} Hz snapshots`)
}
