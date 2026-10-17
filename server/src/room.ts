/**
 * The authoritative race room: one physics world, one fixed-rate tick loop, a per-player
 * input buffer, and the lobby settings the menu drives.
 *
 * Timing model
 * ------------
 * The server advances physics at exactly TICK_RATE with a constant dt and never
 * integrates with a variable frame time. Clients do not simulate at all; they stamp each
 * input with the server tick they believe is coming up and the server consumes one input
 * per player per tick from a small queue. If a packet is late the previous input is held
 * rather than cutting the throttle, and the snapshot carries back the last tick actually
 * consumed so the client can adjust how far ahead it stamps.
 *
 * Snapshots go out every TICKS_PER_SNAPSHOT ticks (30 Hz) with the server clock attached;
 * the client renders INTERPOLATION_DELAY_MS in the past so it is always interpolating
 * between two snapshots it already holds.
 *
 * Bots are full racers: same physics, same rules, same tick. They differ from a human
 * only in where their input bits come from.
 */

import {
  INPUT_STARVE_TICKS,
  MAX_INPUT_LAG_TICKS,
  RACE,
  TICK_DT,
  TICKS_PER_SNAPSHOT,
  TICK_RATE
} from '../../shared/constants'
import { CHECKPOINTS, TRACK } from '../../shared/track'
import {
  encodeCar,
  type GameEvent,
  type PlayerInfo,
  type RaceMode,
  type RacePhase,
  type RaceState,
  type ServerMessage,
  type Standing,
  type WireInput
} from '../../shared/protocol'
import { BOT_SKILLS, BotDriver } from './bot-driver'
import { CarSim } from './car-sim'
import type { PhysicsWorld } from './physics/types'

export type Connection = {
  send(message: ServerMessage): void
  close(reason: string): void
}

const LOG_INPUT = process.env.LOG_INPUT === '1'

/** Anything that occupies a grid slot: a connected player or a bot. */
type Racer = {
  id: number
  name: string
  car: CarSim
  /** Null for bots. */
  connection: Connection | null
  driver: BotDriver | null
}

class Player implements Racer {
  readonly connection: Connection
  readonly driver = null
  /** Inputs waiting to be consumed, keyed by the tick they were stamped for. */
  readonly pending = new Map<number, number>()
  lastBits = 0
  /** Highest input tick actually consumed, echoed back in every snapshot. */
  ack = -1
  starveTicks = 0
  ready = false
  /**
   * Watching rather than driving. A spectator keeps its connection, its snapshots and its
   * standings — it is in the room, just not on the grid — and its car is parked out of
   * the world until it asks to race again.
   */
  spectator = false

  constructor(
    readonly id: number,
    public name: string,
    connection: Connection,
    readonly car: CarSim
  ) {
    this.connection = connection
  }

  queueInputs(inputs: WireInput[], currentTick: number): void {
    for (const [tick, bits] of inputs) {
      if (typeof tick !== 'number' || typeof bits !== 'number') continue
      // Anything this old is already behind the simulation.
      if (tick <= currentTick - MAX_INPUT_LAG_TICKS) continue
      // Nor accept inputs stamped absurdly far in the future.
      if (tick > currentTick + TICK_RATE) continue
      if (!this.pending.has(tick)) this.pending.set(tick, bits)
    }
  }

  /** Consumes the newest input stamped at or before `tick`, holding the last one if none. */
  consume(tick: number): number {
    let bestTick = -Infinity
    for (const t of this.pending.keys()) {
      if (t <= tick && t > bestTick) bestTick = t
    }
    if (bestTick > -Infinity) {
      this.lastBits = this.pending.get(bestTick)!
      this.ack = Math.max(this.ack, bestTick)
      this.starveTicks = 0
    } else {
      this.starveTicks++
      // A client that has gone quiet for long enough coasts to a stop rather than
      // continuing at full throttle forever.
      if (this.starveTicks > INPUT_STARVE_TICKS) this.lastBits = 0
    }
    for (const t of [...this.pending.keys()]) {
      if (t <= tick) this.pending.delete(t)
    }
    return this.lastBits
  }

  info(): PlayerInfo {
    return { id: this.id, name: this.name, ready: this.ready, bot: false, spectator: this.spectator }
  }
}

export class Room {
  private readonly players = new Map<number, Player>()
  private readonly bots = new Map<number, Racer>()
  private nextId = 1
  private tick = 0
  private phase: RacePhase = 'lobby'
  private phaseEndsMs = 0
  private raceStartMs = 0
  private firstFinishMs = 0
  private events: GameEvent[] = []
  private standingsDirty = false
  private playersDirty = false

  // --- Lobby settings, owned by the menu ---
  private mode: RaceMode = 'solo'
  private botCount = 0
  private laps: number = RACE.laps
  /** Set by the START button; cleared when the countdown begins. */
  private startRequested = false

  constructor(private readonly world: PhysicsWorld) {}

  get playerCount(): number {
    return this.players.size
  }

  get currentTick(): number {
    return this.tick
  }

  get engineName(): string {
    return this.world.engineName
  }

  /** Everyone actually on the grid: spectators are in the room but not in the race. */
  private *racers(): Generator<Racer> {
    for (const p of this.players.values()) if (!p.spectator) yield p
    for (const b of this.bots.values()) yield b
  }

  private racerCount(): number {
    let count = this.bots.size
    for (const p of this.players.values()) if (!p.spectator) count++
    return count
  }

  // --- Membership ----------------------------------------------------------

  join(name: string, connection: Connection, nowMs: number): Player | null {
    if (this.players.size >= RACE.maxPlayers) return null
    const id = this.nextId++
    const spawn = TRACK.spawns[this.racerCount() % TRACK.spawns.length]
    const car = new CarSim(id, name, this.world.createVehicle(spawn.pos, spawn.yaw), spawn)
    car.lapStartMs = nowMs
    const player = new Player(id, name, connection, car)
    this.players.set(id, player)
    this.trimBots()

    connection.send({
      t: 'welcome',
      id,
      tick: this.tick,
      now: nowMs,
      trackId: TRACK.id,
      tickRate: TICK_RATE,
      snapshotRate: TICK_RATE / TICKS_PER_SNAPSHOT,
      players: this.playerInfos()
    })
    this.events.push({ t: 'join', id, name })
    this.playersDirty = true
    this.standingsDirty = true
    return player
  }

  leave(id: number): void {
    const player = this.players.get(id)
    if (!player) return
    this.world.removeVehicle(player.car.vehicle)
    this.players.delete(id)
    this.events.push({ t: 'leave', id })
    this.playersDirty = true
    this.standingsDirty = true
    // With nobody left there is no race to be in the middle of, and no reason to keep
    // simulating a grid full of bots.
    if (this.players.size === 0) {
      this.setBotCount(0)
      this.phase = 'lobby'
      this.phaseEndsMs = 0
      this.startRequested = false
    }
  }

  // --- Lobby controls ------------------------------------------------------

  onInputs(id: number, inputs: WireInput[]): void {
    this.players.get(id)?.queueInputs(inputs, this.tick)
  }

  onReady(id: number, ready: boolean): void {
    const player = this.players.get(id)
    if (!player) return
    player.ready = ready
    this.playersDirty = true
  }

  onRespawnRequest(id: number): void {
    this.players.get(id)?.car.requestRespawn()
  }

  /** START: skip the lobby wait and go straight to the countdown. */
  onStartRequest(): void {
    if (this.phase === 'lobby') this.startRequested = true
  }

  /**
   * LEAVE RACE: this player steps out, the race carries on.
   *
   * It used to put the *room* back in the lobby, which meant one person leaving ended
   * everyone else's race. A player who leaves becomes a spectator; the race ends on its
   * own terms, and only when the grid is empty does the room fall back to the lobby.
   */
  onLeaveRace(id: number, nowMs: number): void {
    this.setSpectator(id, true, nowMs)
  }

  /**
   * Spectate or race.
   *
   * Asking to race mid-race does not drop a car onto a moving circuit: the flag is set
   * and the grid slot arrives with the next lobby, which is where everyone else's does.
   */
  onSpectate(id: number, spectate: boolean, nowMs: number): void {
    this.setSpectator(id, spectate, nowMs)
  }

  private setSpectator(id: number, spectate: boolean, nowMs: number): void {
    const player = this.players.get(id)
    if (!player || player.spectator === spectate) return
    player.spectator = spectate
    player.ready = false
    this.playersDirty = true
    this.standingsDirty = true
    if (spectate) {
      // Out of the world rather than left on the circuit, and with gravity off so it is
      // not falling for the rest of the race.
      player.car.vehicle.reset({ x: -200, y: -60, z: -200 }, 0)
      player.car.vehicle.setGravityScale(0)
      this.events.push({ t: 'leave', id })
      // Nobody left to race: end it rather than run a countdown for an empty grid.
      if (this.racerCount() === 0 && this.phase !== 'lobby') {
        this.phase = 'lobby'
        this.phaseEndsMs = 0
        this.startRequested = false
      }
    } else {
      player.car.vehicle.setGravityScale(1)
      this.events.push({ t: 'join', id, name: player.name })
      if (this.phase === 'lobby') this.resetGrid(nowMs)
    }
  }

  onMode(mode: RaceMode): void {
    if (mode !== 'solo' && mode !== 'multiplayer') return
    this.mode = mode
    // Switching mode clears the lobby timer so nothing starts unexpectedly.
    this.phaseEndsMs = 0
  }

  onBotCount(count: number): void {
    if (!Number.isFinite(count)) return
    this.setBotCount(Math.max(0, Math.min(TRACK.spawns.length - 1, Math.floor(count))))
  }

  onLaps(laps: number): void {
    if (!Number.isFinite(laps)) return
    this.laps = Math.max(1, Math.min(9, Math.floor(laps)))
  }

  /** Adds or removes bots so the room has exactly `count` of them. */
  private setBotCount(count: number): void {
    this.botCount = count
    while (this.bots.size > count) this.removeLastBot()
    while (this.bots.size < count && this.racerCount() < TRACK.spawns.length) {
      const id = this.nextId++
      const spawn = TRACK.spawns[this.racerCount() % TRACK.spawns.length]
      const index = this.bots.size
      const name = `BOT ${index + 1}`
      const car = new CarSim(id, name, this.world.createVehicle(spawn.pos, spawn.yaw), spawn)
      this.bots.set(id, {
        id,
        name,
        car,
        connection: null,
        driver: new BotDriver(BOT_SKILLS[index % BOT_SKILLS.length])
      })
      this.events.push({ t: 'join', id, name })
    }
    this.playersDirty = true
    this.standingsDirty = true
  }

  private removeLastBot(): void {
    const entries = [...this.bots.entries()]
    const last = entries[entries.length - 1]
    if (!last) return
    this.world.removeVehicle(last[1].car.vehicle)
    this.bots.delete(last[0])
    this.events.push({ t: 'leave', id: last[0] })
  }

  /** Drops bots that no longer fit once a human takes a grid slot. */
  private trimBots(): void {
    while (this.racerCount() > TRACK.spawns.length && this.bots.size > 0) this.removeLastBot()
  }

  // --- Tick ----------------------------------------------------------------

  /** Advances the simulation by exactly one fixed tick. */
  step(nowMs: number): void {
    this.tick++
    this.updatePhase(nowMs)
    const racing = this.phase === 'racing'

    for (const racer of this.racers()) {
      let bits: number
      if (racer.driver !== null) {
        bits = racing ? racer.driver.think(racer.car) : 0
      } else {
        const player = racer as Player
        bits = player.consume(this.tick)
        // Set LOG_INPUT=1 to see what each client is actually sending. A real keyboard
        // reaching the scene runtime is the one link that cannot be exercised headlessly,
        // so this is how a "my car will not move" report gets diagnosed.
        if (LOG_INPUT && this.tick % 20 === 0) {
          console.log(
            `[input] #${player.id} ${player.name} bits=${bits} (${bits.toString(2).padStart(8, '0')}) ` +
              `queued=${player.pending.size} starved=${player.starveTicks} phase=${this.phase}`
          )
        }
      }
      racer.car.setInput(bits)
      for (const e of racer.car.update(TICK_DT, nowMs, racing)) {
        this.events.push(e)
        if (e.t === 'lap') {
          this.standingsDirty = true
          if (e.lap >= this.laps) this.finish(racer, nowMs)
        }
      }
    }

    this.world.step()
    this.updateRanks()

    if (this.tick % TICKS_PER_SNAPSHOT === 0) this.broadcastSnapshot(nowMs)
    if (this.events.length > 0) {
      const batch = this.events
      this.events = []
      this.broadcast({ t: 'ev', e: batch })
    }
    if (this.playersDirty) {
      this.playersDirty = false
      this.broadcast({ t: 'players', players: this.playerInfos() })
    }
    if (this.standingsDirty) {
      this.standingsDirty = false
      this.broadcast({ t: 'standings', standings: this.standings() })
    }
  }

  private finish(racer: Racer, nowMs: number): void {
    if (racer.car.finished) return
    racer.car.finished = true
    racer.car.finishedAtMs = nowMs
    let rank = 0
    for (const r of this.racers()) if (r.car.finished) rank++
    racer.car.rank = rank
    if (this.firstFinishMs === 0) this.firstFinishMs = nowMs
    this.events.push({ t: 'finish', id: racer.id, rank, totalMs: nowMs - this.raceStartMs })
    this.standingsDirty = true
  }

  private updatePhase(nowMs: number): void {
    switch (this.phase) {
      case 'lobby': {
        if (this.players.size === 0) {
          this.phaseEndsMs = 0
          this.startRequested = false
          return
        }
        if (this.startRequested) {
          this.beginCountdown(nowMs)
          return
        }
        // Solo waits for the START button. Multiplayer also auto-starts once everyone is
        // ready or the lobby timer runs out, so a room of strangers still gets going.
        if (this.mode === 'multiplayer') {
          const racing = [...this.players.values()].filter((p) => !p.spectator)
          const everyoneReady = racing.length > 0 && racing.every((p) => p.ready)
          if (this.phaseEndsMs === 0) this.phaseEndsMs = nowMs + RACE.lobbyMs
          if (everyoneReady || nowMs >= this.phaseEndsMs) this.beginCountdown(nowMs)
        } else {
          this.phaseEndsMs = 0
        }
        return
      }
      case 'countdown': {
        if (nowMs >= this.phaseEndsMs) {
          this.phase = 'racing'
          this.phaseEndsMs = 0
          this.raceStartMs = nowMs
          this.firstFinishMs = 0
          for (const r of this.racers()) r.car.lapStartMs = nowMs
          this.events.push({ t: 'go' })
        }
        return
      }
      case 'racing': {
        const all = [...this.racers()]
        const allDone = all.length > 0 && all.every((r) => r.car.finished)
        const graceExpired = this.firstFinishMs > 0 && nowMs - this.firstFinishMs > RACE.finishGraceMs
        if (allDone || graceExpired || all.length === 0) {
          this.phase = 'finished'
          this.phaseEndsMs = nowMs + RACE.podiumMs
          this.events.push({ t: 'race-end', standings: this.standings() })
        }
        return
      }
      case 'finished': {
        if (nowMs >= this.phaseEndsMs) {
          this.phase = 'lobby'
          this.phaseEndsMs = 0
          this.startRequested = false
          for (const p of this.players.values()) p.ready = false
          this.resetGrid(nowMs)
          this.playersDirty = true
        }
        return
      }
    }
  }

  private beginCountdown(nowMs: number): void {
    this.phase = 'countdown'
    this.startRequested = false
    this.phaseEndsMs = nowMs + RACE.countdownMs
    this.resetGrid(nowMs)
    this.events.push({ t: 'countdown', ms: RACE.countdownMs })
  }

  private resetGrid(nowMs: number): void {
    let slot = 0
    for (const racer of this.racers()) {
      const spawn = TRACK.spawns[slot % TRACK.spawns.length]
      racer.car.resetForRace(spawn, nowMs)
      racer.driver?.reset()
      slot++
    }
    this.standingsDirty = true
  }

  /**
   * Race position. Finished cars are ordered by their finishing time; everyone else by
   * how far round the lap they are, with the distance to their next checkpoint breaking
   * ties so two cars between the same pair of checkpoints still get a stable order.
   */
  private updateRanks(): void {
    const sorted = [...this.racers()].sort((a, b) => {
      if (a.car.finished !== b.car.finished) return a.car.finished ? -1 : 1
      if (a.car.finished && b.car.finished) return a.car.finishedAtMs - b.car.finishedAtMs
      const byProgress = b.car.progress() - a.car.progress()
      if (byProgress !== 0) return byProgress
      return this.distanceToNextCheckpoint(a) - this.distanceToNextCheckpoint(b)
    })
    sorted.forEach((r, i) => {
      r.car.rank = i + 1
    })
  }

  private distanceToNextCheckpoint(racer: Racer): number {
    const next = CHECKPOINTS[(racer.car.cp + 1) % CHECKPOINTS.length]
    const p = racer.car.vehicle.position()
    return Math.hypot(next.pos.x - p.x, next.pos.y - p.y, next.pos.z - p.z)
  }

  private raceState(nowMs: number): RaceState {
    return {
      phase: this.phase,
      phaseMs: this.phaseEndsMs > 0 ? Math.max(0, Math.round(this.phaseEndsMs - nowMs)) : 0,
      timeMs: this.phase === 'racing' ? Math.round(nowMs - this.raceStartMs) : 0,
      laps: this.laps,
      mode: this.mode,
      bots: this.botCount,
      autoStart: this.mode === 'multiplayer' && this.phase === 'lobby' && this.phaseEndsMs > 0
    }
  }

  private playerInfos(): PlayerInfo[] {
    const out: PlayerInfo[] = []
    for (const p of this.players.values()) out.push(p.info())
    for (const b of this.bots.values()) out.push({ id: b.id, name: b.name, ready: true, bot: true, spectator: false })
    return out
  }

  private standings(): Standing[] {
    return [...this.racers()]
      .map((r) => ({
        id: r.id,
        name: r.name,
        lap: r.car.lap,
        rank: r.car.rank,
        totalMs: r.car.finished ? Math.round(r.car.finishedAtMs - this.raceStartMs) : 0,
        bestLapMs: Math.round(r.car.bestLapMs),
        score: r.car.score,
        finished: r.car.finished
      }))
      .sort((a, b) => a.rank - b.rank)
  }

  private broadcastSnapshot(nowMs: number): void {
    const cars = [...this.racers()].map((r) => encodeCar(r.car.toState()))
    const race = this.raceState(nowMs)
    for (const player of this.players.values()) {
      player.connection.send({ t: 's', tick: this.tick, now: nowMs, cars, race, ack: player.ack })
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const player of this.players.values()) player.connection.send(message)
  }
}
