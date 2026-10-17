/**
 * WebSocket link to the physics server.
 *
 * Decentraland's scene runtime only exposes a text WebSocket, so the protocol is JSON.
 * Responsibilities here:
 *  - connect, with backoff, and re-join automatically after a drop
 *  - keep a clock estimate against the server via ping/pong, which is what lets the
 *    snapshot buffer know which server instant to render
 *  - stamp inputs with the server tick they are meant for and resend the tail of the
 *    stream so one lost packet never leaves the server with nothing to apply
 */

import {
  INPUT_LEAD_CUSHION_MS,
  INPUT_MS,
  INPUT_REDUNDANCY,
  NET,
  TICK_MS
} from '../../../shared/constants'
import { clamp } from '../../../shared/math'
import {
  parseServerMessage,
  type ClientMessage,
  type GameEvent,
  type Input,
  type PlayerInfo,
  type RaceMode,
  type Standing,
  type WireInput
} from '../../../shared/protocol'
import { TRACK } from '../../../shared/track'
import { SnapshotBuffer } from './snapshot-buffer'

export type ConnectionStatus = 'connecting' | 'connected' | 'offline'

export type Handlers = {
  onEvents(events: GameEvent[]): void
  onPlayers(players: PlayerInfo[]): void
  onStandings(standings: Standing[]): void
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000]

export class Connection {
  readonly buffer = new SnapshotBuffer()
  status: ConnectionStatus = 'connecting'
  /** Our own player id, once the server has accepted the join. */
  playerId = -1
  lastError = ''
  /**
   * Set when the server's circuit is not the one this build draws. Both sides generate it
   * from `shared/track.ts` and both are deployed on their own, so a server left running
   * from before a change puts the colliders somewhere the client is not drawing them —
   * invisible walls, ramps that are not there. The id carries a hash of the geometry, so
   * the mismatch is caught on the welcome instead of being debugged from the driver's seat.
   */
  trackMismatch = false

  private socket: WebSocket | null = null
  private clockOffset = 0
  private rtt = 100
  private rttSamples = 0
  private pingId = 1
  private pendingPings = new Map<number, number>()
  private unsentSince = 0
  private sincePing = 0
  private sinceReconnect = 0
  private attempts = 0
  private queue: Input[] = []
  private currentBits = 0

  constructor(
    private readonly name: string,
    private readonly handlers: Handlers
  ) {}

  /** The server this connection talks to, kept for the reconnect attempts. */
  private url = ''

  connect(url = this.url): void {
    this.url = url
    this.status = 'connecting'
    try {
      const socket = new WebSocket(this.url)
      this.socket = socket
      socket.onopen = () => {
        this.status = 'connected'
        this.attempts = 0
        this.lastError = ''
        this.send({ t: 'join', v: NET.protocolVersion, name: this.name })
        // Ping on the next update, which is the first moment a real timestamp exists.
        // Pinging from here used to pass 0 as the send time, so the first round-trip
        // sample came out as the entire scene uptime; that poisoned the clock offset,
        // every input was stamped minutes into the future, the server rejected the lot
        // and the car never moved.
        this.sincePing = 2000
      }
      socket.onmessage = (event) => this.onMessage(String(event.data))
      socket.onclose = () => {
        if (this.socket === socket) this.goOffline('connection closed')
      }
      socket.onerror = () => {
        if (this.socket === socket) this.goOffline('connection error')
      }
    } catch (err) {
      this.goOffline(`could not open socket: ${err}`)
    }
  }

  private goOffline(reason: string): void {
    this.status = 'offline'
    this.lastError = reason
    this.playerId = -1
    this.socket = null
    this.sinceReconnect = 0
    this.queue = []
    this.pendingPings.clear()
  }

  private send(message: ClientMessage): void {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return
    socket.send(JSON.stringify(message))
  }

  /** Current input state, set every frame by the input system. */
  setInput(bits: number): void {
    this.currentBits = bits
  }

  requestRespawn(): void {
    this.send({ t: 'respawn' })
  }

  setReady(ready: boolean): void {
    this.send({ t: 'ready', ready })
  }

  // --- Lobby menu ---
  startRace(): void {
    this.send({ t: 'start' })
  }

  leaveRace(): void {
    this.send({ t: 'leave-race' })
  }

  /** Watch instead of drive, or ask for a grid slot back. */
  spectate(on: boolean): void {
    this.send({ t: 'spectate', on })
  }

  setMode(mode: RaceMode): void {
    this.send({ t: 'mode', mode })
  }

  setBots(count: number): void {
    this.send({ t: 'bots', count })
  }

  setLaps(laps: number): void {
    this.send({ t: 'laps', laps })
  }

  get roundTripMs(): number {
    return this.rtt
  }

  /** Server clock estimate for right now. */
  serverNow(localNow: number): number {
    return localNow + this.clockOffset
  }

  /**
   * Drives the outgoing side of the link. `localNow` is a monotonically increasing
   * millisecond clock; the scene passes its accumulated frame time.
   */
  update(dt: number, localNow: number): void {
    this.lastLocalNow = localNow
    const ms = dt * 1000
    if (this.status === 'offline') {
      this.sinceReconnect += ms
      const delay = RECONNECT_DELAYS_MS[Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)]
      if (this.sinceReconnect >= delay) {
        this.attempts++
        this.connect()
      }
      return
    }

    this.sincePing += ms
    if (this.sincePing >= 2000) {
      this.sincePing = 0
      this.ping(localNow)
    }

    this.unsentSince += ms
    if (this.unsentSince >= INPUT_MS && this.playerId >= 0) {
      this.unsentSince = 0
      this.pushInputs(localNow)
    }
  }

  private ping(localNow: number): void {
    const id = this.pingId++
    this.pendingPings.set(id, localNow)
    this.send({ t: 'ping', id, clientTime: localNow })
  }

  /**
   * Stamps one input sample per server tick since the last send and transmits the last
   * few sends together. The stamp is deliberately ahead of the server's current tick by
   * half the round trip plus a jitter cushion, so the packet lands before the server
   * reaches that tick and the server never has to hold a stale input.
   */
  private pushInputs(localNow: number): void {
    const lead = clamp(Math.ceil((this.rtt / 2 + INPUT_LEAD_CUSHION_MS) / TICK_MS), 2, 20)
    const baseTick = Math.floor(this.serverNow(localNow) / TICK_MS) + lead
    const samples = Math.max(1, Math.round(INPUT_MS / TICK_MS))
    for (let i = 0; i < samples; i++) this.queue.push({ tick: baseTick + i, bits: this.currentBits })
    const keep = samples * INPUT_REDUNDANCY
    if (this.queue.length > keep) this.queue = this.queue.slice(-keep)
    const payload: WireInput[] = []
    for (const input of this.queue) payload.push([input.tick, input.bits])
    this.send({ t: 'in', i: payload })
  }

  private onMessage(raw: string): void {
    const message = parseServerMessage(raw)
    if (!message) return
    switch (message.t) {
      case 'welcome':
        this.playerId = message.id
        this.trackMismatch = message.trackId !== TRACK.id
        if (this.trackMismatch) {
          console.error(`[roadster] track mismatch: server has ${message.trackId}, scene has ${TRACK.id}`)
        }
        // Rough estimate ignoring latency; the first pong refines it a frame later.
        this.clockOffset = message.now - this.lastLocalNow
        this.buffer.setClock(this.clockOffset, this.rtt)
        break
      case 's':
        this.buffer.push(message.tick, message.now, message.cars, message.race)
        break
      case 'pong': {
        const sentAt = this.pendingPings.get(message.id)
        this.pendingPings.delete(message.id)
        if (sentAt === undefined) break
        // The pong carries back our own timestamp, so the round trip needs no shared clock.
        const sample = this.lastLocalNow - sentAt
        // A sample this large is not a round trip, it is a bad clock. Drop it rather than
        // letting it drag the offset — and with it every input stamp — off the rails.
        if (sample < 0 || sample > 5000) break
        this.rtt = this.rttSamples === 0 ? sample : this.rtt * 0.8 + sample * 0.2
        this.rttSamples++
        this.clockOffset = message.serverNow + this.rtt / 2 - this.lastLocalNow
        this.buffer.setClock(this.clockOffset, this.rtt)
        break
      }
      case 'ev':
        this.handlers.onEvents(message.e)
        break
      case 'players':
        this.handlers.onPlayers(message.players)
        break
      case 'standings':
        this.handlers.onStandings(message.standings)
        break
      case 'error':
        this.lastError = message.message
        break
    }
  }

  /**
   * The scene's monotonic clock, refreshed every frame. Message handlers run outside
   * `update`, so they need somewhere to read "now" from; the runtime gives no wall clock
   * the server can be compared against.
   */
  lastLocalNow = 0
}
