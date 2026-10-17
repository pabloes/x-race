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
import { cheer, silenceMissing, updateCarAudio } from './audio'
import { CHECKPOINTS } from '../../shared/track'
import { carRoot, hideMissing, renderCar } from './car'
import { updateSkidmarks } from './skidmarks'
import { attachTo, detach } from './camera'
import { PLAYER_NAME, serverUrl } from './config'
import { readInputBits, respawnPressed } from './input'
import { Connection } from './net/connection'
import { SPIKE_CANNON, startCannonSpike } from './spike-cannon'
import { detectPlatform } from './platform'
import { buildTrack } from './track-render'
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

const connection = new Connection(PLAYER_NAME, {
  onEvents: handleEvents,
  onPlayers: (list) => {
    players = list
    const me = list.find((p) => p.id === connection.playerId)
    hud.spectator = me?.spectator === true
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

function renderSystem(): void {
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
  hideMissing(cars)
  silenceMissing(cars)

  hud.blips = []
  for (const [, car] of cars) {
    if ((car.flags & CarFlag.Respawning) !== 0) continue
    hud.blips.push({ id: car.id, x: car.pos.x, z: car.pos.z, mine: car.id === connection.playerId })
  }

  const mine = cars.get(connection.playerId)
  if (mine) {
    const root = carRoot(mine.id)
    if (root !== null) attachTo(root)
    hud.speedKmh = vlen(mine.vel) * 3.6 * SPEEDO_EXAGGERATION
    hud.charge = mine.charge
    hud.flags = mine.flags
    hud.lap = mine.lap
    hud.rank = mine.rank
    hud.score = mine.score
    hud.checkpoint = mine.cp + 1
    // Checkpoints are mandatory and in order, so "next" is simply the one after the last
    // one taken, wrapping back to the start line at the end of a lap.
    const next = (mine.cp + 1) % CHECKPOINTS.length
    hud.nextCheckpoint = {
      x: CHECKPOINTS[next].pos.x,
      z: CHECKPOINTS[next].pos.z,
      label: `${next + 1}/${CHECKPOINTS.length}`
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
    hud.phase = race.phase
    hud.phaseMs = race.phaseMs
    hud.raceTimeMs = race.timeMs
    hud.laps = race.laps
    hud.mode = race.mode
    hud.bots = race.bots
    hud.joining = race.joining
    if (race.phase === 'countdown') {
      const seconds = Math.ceil(race.phaseMs / 1000)
      hud.bigMessage = seconds > 0 ? String(seconds) : 'GO!'
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
  buildTrack()
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
  menu.start = () => connection.startRace()
  menu.leaveRace = () => connection.leaveRace()
  menu.setSpectator = (on) => connection.spectate(on)

  // The realm has to be asked before the first socket is opened, so the connection starts
  // one turn of the event loop later than everything else. The HUD already says
  // "connecting to race server…" until the welcome lands, so there is nothing to hide.
  void serverUrl().then((url) => {
    console.log(`[roadster] server ${url}`)
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
