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
import {
  checkpointsOf,
  isTrackId,
  TRACK_IDS,
  trackById,
  trackFingerprint,
  type Track,
  type TrackId,
  type Trigger
} from '../../shared/tracks'
import {
  encodeCar,
  type GameEvent,
  type PlayerInfo,
  type RaceMode,
  type RacePhase,
  type RaceState,
  type ServerMessage,
  type Standing,
  type VoteCount,
  type WireInput
} from '../../shared/protocol'
import { BOT_SKILLS, BotDriver } from './bot-driver'
import { CarSim } from './car-sim'
import { createWorld } from './physics'
import type { PhysicsWorld } from './physics/types'
import type { RaceRecord } from './stats'

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
    readonly car: CarSim,
    /** Signed-in wallet, when there is one. Guests drive without. */
    readonly address?: string
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
  /** Called when a race ends, with who was in it. The room keeps no history itself. */
  onRaceFinished: ((record: RaceRecord) => void) | null = null
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
  /**
   * When the shared room's door closes, in server clock ms.
   *
   * Kept apart from `phaseEndsMs`, which is only what the HUD counts down: deriving the
   * window from that field meant clearing it on expiry, and a cleared timer looks exactly
   * like a timer that was never started, so the window re-armed itself every tick and
   * START was refused forever.
   */
  private joinWindowEndsMs = 0
  /** Each player's choice of circuit for the next race, counted at START. */
  private readonly votes = new Map<number, TrackId>()

  /** The circuit this room races on, its physics world, and its checkpoints in order. */
  private track: Track
  private world: PhysicsWorld
  private checkpoints: Trigger[]

  constructor(track: Track) {
    this.track = track
    this.world = createWorld(track)
    this.checkpoints = checkpointsOf(track)
  }

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

  join(name: string, connection: Connection, nowMs: number, address?: string): Player | null {
    if (this.players.size >= RACE.maxPlayers) return null
    const id = this.nextId++
    const spawn = this.track.spawns[this.racerCount() % this.track.spawns.length]
    const car = new CarSim(id, name, this.world.createVehicle(spawn.pos, spawn.yaw), spawn, this.track)
    car.lapStartMs = nowMs
    // The door opens for the first arrival into an empty room, not for each one: later
    // arrivals join the window already running.
    if (this.players.size === 0 && this.phase === 'lobby') {
      this.joinWindowEndsMs = nowMs + RACE.joinWindowMs
    }
    const player = new Player(id, name, connection, car, address)
    // Arriving while a race is on makes you a spectator, not a car dropped onto a moving
    // circuit two laps behind. The grid slot comes with the next lobby, which is the same
    // place everyone else gets theirs.
    if (this.phase !== 'lobby') this.park(player)
    this.players.set(id, player)
    this.trimBots()

    connection.send({
      t: 'welcome',
      id,
      tick: this.tick,
      now: nowMs,
      trackId: this.track.id,
      tracks: TRACK_IDS.map((track) => ({ id: track, fingerprint: trackFingerprint(trackById(track)) })),
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
    this.votes.delete(id)
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

  /**
   * A player's choice of circuit: one per player, spectators included, each replacing the
   * last, and only in the lobby. An id this server does not know is ignored. There is no
   * reply; the count comes back in the next snapshot.
   */
  onVote(id: number, track: unknown): void {
    if (this.phase !== 'lobby' || !this.players.has(id) || !isTrackId(track)) return
    this.votes.set(id, track)
  }

  onRespawnRequest(id: number): void {
    this.players.get(id)?.car.requestRespawn()
  }

  /**
   * START: run the countdown, for everyone in this room.
   *
   * Ignored while the join window is still open, which is the only thing that window is
   * for: it stops a race starting on top of people who are still walking in.
   */
  onStartRequest(nowMs: number): void {
    if (this.phase !== 'lobby') return
    if (this.mode === 'multiplayer' && nowMs < this.joinWindowEndsMs) return
    this.startRequested = true
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

  /** Takes a car off the circuit: out of the world, and not falling through it either. */
  private park(player: Player): void {
    player.spectator = true
    player.car.vehicle.reset({ x: -200, y: -60, z: -200 }, 0)
    player.car.vehicle.setGravityScale(0)
  }

  private setSpectator(id: number, spectate: boolean, nowMs: number): void {
    const player = this.players.get(id)
    if (!player || player.spectator === spectate) return
    player.spectator = spectate
    player.ready = false
    this.playersDirty = true
    this.standingsDirty = true
    if (spectate) {
      this.park(player)
      this.events.push({ t: 'leave', id })
      // Nobody left to race: end it rather than run a countdown for an empty grid.
      if (this.racerCount() === 0 && this.phase !== 'lobby') {
        this.phase = 'lobby'
        this.phaseEndsMs = 0
        this.startRequested = false
        this.votes.clear()
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
    this.setBotCount(Math.max(0, Math.min(RACE.maxBots, Math.floor(count))))
  }

  onLaps(laps: number): void {
    if (!Number.isFinite(laps)) return
    this.laps = Math.max(1, Math.min(9, Math.floor(laps)))
  }

  /** Adds or removes bots so the room has exactly `count` of them. */
  private setBotCount(count: number): void {
    this.botCount = count
    while (this.bots.size > count) this.removeLastBot()
    while (this.bots.size < count && this.racerCount() < this.track.spawns.length) {
      const id = this.nextId++
      const spawn = this.track.spawns[this.racerCount() % this.track.spawns.length]
      const index = this.bots.size
      const name = `BOT ${index + 1}`
      const car = new CarSim(id, name, this.world.createVehicle(spawn.pos, spawn.yaw), spawn, this.track)
      this.bots.set(id, {
        id,
        name,
        car,
        connection: null,
        driver: new BotDriver(BOT_SKILLS[index % BOT_SKILLS.length], this.track.centreline)
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
    while (this.racerCount() > this.track.spawns.length && this.bots.size > 0) this.removeLastBot()
  }

  // --- Tick ----------------------------------------------------------------

  /**
   * Advances the simulation by exactly one fixed tick.
   *
   * The tick number comes from the loop rather than from a counter of its own, because
   * there is more than one room and the client stamps its inputs against the *clock*:
   * `serverNow / TICK_MS`. A room that started counting at zero when it was created would
   * see every input as tens of thousands of ticks in the future and throw them all away.
   */
  step(nowMs: number, tick: number): void {
    this.tick = tick
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

  /** Hands the finished race to whoever is keeping the book, if anyone is. */
  private reportRace(racers: Racer[], nowMs: number): void {
    if (!this.onRaceFinished || racers.length === 0) return
    this.onRaceFinished({
      startedAt: Date.now() - Math.round(nowMs - this.raceStartMs),
      endedAt: Date.now(),
      mode: this.mode,
      track: this.track.base,
      laps: this.laps,
      participants: racers.map((r) => ({
        name: r.name,
        address: (r as Player).address,
        rank: r.car.rank,
        laps: r.car.lap,
        bestLapMs: Math.round(r.car.bestLapMs),
        totalMs: r.car.finished ? Math.round(r.car.finishedAtMs - this.raceStartMs) : 0,
        score: r.car.score,
        finished: r.car.finished,
        bot: r.driver !== null
      }))
    })
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
          this.beginRace(nowMs)
          return
        }
        // Nothing starts by itself. Multiplayer holds the door open for a while first;
        // solo is ready the moment its player is.
        this.phaseEndsMs =
          this.mode === 'multiplayer' && nowMs < this.joinWindowEndsMs ? this.joinWindowEndsMs : 0
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
        // A hard ceiling on the race, because the grace period only starts when somebody
        // finishes: a driver who never does would otherwise hold the room open forever,
        // and with one room that means nobody else gets a race.
        const outOfTime = nowMs - this.raceStartMs > RACE.maxRaceMs
        if (allDone || graceExpired || outOfTime || all.length === 0) {
          this.phase = 'finished'
          this.phaseEndsMs = nowMs + RACE.podiumMs
          this.events.push({ t: 'race-end', standings: this.standings() })
          this.reportRace(all, nowMs)
        }
        return
      }
      case 'finished': {
        if (nowMs >= this.phaseEndsMs) {
          this.phase = 'lobby'
          this.phaseEndsMs = 0
          this.startRequested = false
          // A fresh door for the next race, so the field can change between them.
          this.joinWindowEndsMs = nowMs + RACE.joinWindowMs
          for (const p of this.players.values()) p.ready = false
          this.votes.clear()
          this.resetGrid(nowMs)
          this.playersDirty = true
        }
        return
      }
    }
  }

  /**
   * START: count the vote, move the room to the winner and go straight to the countdown
   * with the cars on the new grid. The track event goes out before the phase does, so
   * every client can say which circuit it is, and whether a draw picked it, as the
   * countdown begins.
   */
  private beginRace(nowMs: number): void {
    const { track, votes, tie } = this.countVotes()
    this.votes.clear()
    if (track !== this.track.base) this.changeTrack(trackById(track))
    this.events.push({ t: 'track', track, votes, tie })
    this.beginCountdown(nowMs)
  }

  /** Most votes wins; nobody voting keeps the circuit; a draw is settled at random. */
  private countVotes(): { track: TrackId; votes: VoteCount; tie: boolean } {
    const votes = this.tally()
    let most = 0
    for (const id of TRACK_IDS) most = Math.max(most, votes[id] ?? 0)
    if (most === 0) return { track: this.track.base, votes, tie: false }
    const leaders = TRACK_IDS.filter((id) => votes[id] === most)
    // The only Math.random in the race, and it stays on the server: the clients learn the
    // result from the `track` event and never have to agree on a roll.
    const track = leaders[Math.floor(Math.random() * leaders.length)]
    return { track, votes, tie: leaders.length > 1 }
  }

  private tally(): VoteCount {
    const votes: VoteCount = {}
    for (const track of this.votes.values()) votes[track] = (votes[track] ?? 0) + 1
    return votes
  }

  /**
   * Moves the room to another circuit. A Rapier world cannot swap its colliders, so this is
   * a new world, and every car in the room — spectators' parked ones too — gets a chassis
   * in it. The caller puts the racers on the grid.
   */
  private changeTrack(track: Track): void {
    const old = this.world
    this.track = track
    this.checkpoints = checkpointsOf(track)
    this.world = createWorld(track)
    let slot = 0
    for (const racer of [...this.players.values(), ...this.bots.values()]) {
      const spawn = track.spawns[slot++ % track.spawns.length]
      racer.car.setTrack(track, this.world.createVehicle(spawn.pos, spawn.yaw))
      racer.driver?.follow(track.centreline)
    }
    for (const player of this.players.values()) if (player.spectator) this.park(player)
    old.dispose()
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
      const spawn = this.track.spawns[slot % this.track.spawns.length]
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
    const next = this.checkpoints[(racer.car.cp + 1) % this.checkpoints.length]
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
      joining: this.mode === 'multiplayer' && this.phase === 'lobby' && this.phaseEndsMs > 0,
      track: this.track.base,
      votes: this.phase === 'lobby' ? this.tally() : {}
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
