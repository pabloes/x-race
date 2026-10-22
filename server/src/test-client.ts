/**
 * Headless client: joins a running server, drives the centreline, and reports on the
 * netcode rather than on the physics.
 *
 *   npm run bot                  # one bot for 60 s
 *   npm run bot -- 4 90          # four bots for 90 s
 *   SERVER=ws://host:8787 npm run bot
 *
 * It implements the same clock sync and input-stamping the Decentraland scene uses, so if
 * the input buffer starves or snapshots arrive irregularly it shows up here first, with
 * no explorer in the loop.
 */

import WebSocket from 'ws'
import {
  INPUT_MS,
  INPUT_REDUNDANCY,
  NET,
  SNAPSHOT_MS,
  SNAPSHOT_RATE,
  TICK_MS,
  TICK_RATE
} from '../../shared/constants'
import { clamp, quatConjugate, quatRotate } from '../../shared/math'
import {
  decodeCar,
  InputBit,
  parseServerMessage,
  type CarState,
  type Input,
  type WireInput
} from '../../shared/protocol'
import { DEFAULT_TRACK, TRACK_IDS, trackById, type PathPoint } from '../../shared/tracks'

const URL = process.env.SERVER ?? `ws://localhost:${NET.defaultPort}`

class Bot {
  private socket: WebSocket
  private id = -1
  /** serverNow ≈ localNow + clockOffset. */
  private clockOffset = 0
  private rtt = 80
  private sentInputs: Input[] = []
  private inputTimer?: NodeJS.Timeout
  private pingTimer?: NodeJS.Timeout
  private pingId = 1
  private waypoint = 0
  /** The racing line of whatever circuit the room is on. */
  private path: PathPoint[] = trackById(DEFAULT_TRACK).centreline
  private me: CarState | null = null
  private bits = 0

  readonly stats = {
    snapshots: 0,
    events: 0,
    gaps: [] as number[],
    ackLag: [] as number[],
    rtt: [] as number[],
    lastSnapshotAt: 0,
    lap: 0,
    cp: -1,
    score: 0,
    charge: 0,
    joined: false,
    error: '',
    phase: '',
    pos: { x: 0, y: 0, z: 0 },
    speed: 0,
    flags: 0
  }

  constructor(
    readonly name: string,
    url: string
  ) {
    this.socket = new WebSocket(url)
    this.socket.on('open', () => {
      this.send({ t: 'join', v: NET.protocolVersion, name })
      this.inputTimer = setInterval(() => this.sendInputs(), INPUT_MS)
      this.pingTimer = setInterval(() => this.send({ t: 'ping', id: this.pingId++, clientTime: Date.now() }), 2000)
      this.send({ t: 'ping', id: this.pingId++, clientTime: Date.now() })
    })
    this.socket.on('message', (data) => this.onMessage(data.toString()))
    this.socket.on('error', (err) => {
      this.stats.error = err.message
    })
  }

  private send(message: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  /** The server tick this client's next input should be stamped for. */
  private targetTick(): number {
    const serverNow = Date.now() + this.clockOffset
    // Stamp far enough ahead that the packet lands before the server reaches that tick:
    // half the round trip, plus a fixed cushion for jitter.
    const lead = Math.ceil((this.rtt / 2 + 50) / TICK_MS)
    return Math.floor(serverNow / TICK_MS) + clamp(lead, 2, 20)
  }

  private onMessage(raw: string): void {
    const message = parseServerMessage(raw)
    if (!message) return
    switch (message.t) {
      case 'welcome': {
        this.id = message.id
        this.clockOffset = message.now - Date.now()
        this.stats.joined = true
        // The full id carries the geometry hash, so a server on another build of the
        // circuit is caught here rather than as a bot that drives into a field.
        const current = TRACK_IDS.find((id) => trackById(id).id === message.trackId)
        if (current === undefined) this.stats.error = `server runs track ${message.trackId}, not one of ours`
        else this.path = trackById(current).centreline
        break
      }
      case 's': {
        const at = Date.now()
        if (this.stats.lastSnapshotAt > 0) this.stats.gaps.push(at - this.stats.lastSnapshotAt)
        this.stats.lastSnapshotAt = at
        this.stats.snapshots++
        this.stats.ackLag.push(message.tick - message.ack)
        for (const wire of message.cars) {
          const car = decodeCar(wire)
          if (car.id !== this.id) continue
          this.me = car
          this.stats.lap = car.lap
          this.stats.cp = car.cp
          this.stats.score = car.score
          this.stats.charge = car.charge
          this.stats.pos = car.pos
          this.stats.speed = Math.hypot(car.vel.x, car.vel.y, car.vel.z)
          this.stats.flags = car.flags
        }
        this.stats.phase = message.race.phase
        if (message.race.phase === 'lobby') this.send({ t: 'ready', ready: true })
        this.think()
        break
      }
      case 'ev':
        this.stats.events += message.e.length
        if (process.env.LOG_EVENTS === '1') {
          for (const e of message.e) console.log(`  [${this.name}] ${JSON.stringify(e)}`)
        }
        break
      case 'pong': {
        // Round trip measured end to end, then the offset between the two clocks.
        const rtt = Date.now() - message.clientTime
        this.rtt = this.rtt * 0.8 + rtt * 0.2
        this.clockOffset = message.serverNow + this.rtt / 2 - Date.now()
        this.stats.rtt.push(rtt)
        break
      }
      case 'error':
        this.stats.error = message.message
        break
    }
  }

  /** Same centreline follower the offline harness uses, driven from snapshot state. */
  private think(): void {
    const car = this.me
    if (!car) return
    const inverse = quatConjugate(car.rot)
    const toLocal = (i: number) => {
      const t = this.path[i % this.path.length].pos
      return quatRotate(inverse, { x: t.x - car.pos.x, y: t.y - car.pos.y, z: t.z - car.pos.z })
    }
    for (let step = 0; step < 3; step++) {
      if (toLocal(this.waypoint).z < 2) this.waypoint++
      else break
    }
    const lateral = (p: { x: number; y: number; z: number }) =>
      Math.atan2(p.x, Math.max(Math.hypot(p.y, p.z), 0.5))
    const error = lateral(toLocal(this.waypoint))
    const curvature = Math.abs(lateral(toLocal(this.waypoint + 4)))
    const speed = Math.hypot(car.vel.x, car.vel.y, car.vel.z)
    const target = clamp(22 * (1 - curvature * 1.1), 9, 22)

    let bits = 0
    if (error > 0.04) bits |= InputBit.Right
    else if (error < -0.04) bits |= InputBit.Left
    if (speed < target) bits |= InputBit.Throttle
    else if (speed > target + 2.5) bits |= InputBit.Brake
    if (car.charge > 0.4 && curvature < 0.18) bits |= InputBit.Boost
    this.bits = bits
  }

  private sendInputs(): void {
    if (!this.stats.joined) return
    const tick = this.targetTick()
    // One sample per tick since the last send, so the server's queue never runs dry.
    const ticksPerSend = Math.max(1, Math.round(INPUT_MS / TICK_MS))
    for (let i = 0; i < ticksPerSend; i++) this.sentInputs.push({ tick: tick + i, bits: this.bits })
    // Resend the tail: a single lost packet then costs nothing.
    const keep = ticksPerSend * INPUT_REDUNDANCY
    if (this.sentInputs.length > keep) this.sentInputs = this.sentInputs.slice(-keep)
    const payload: WireInput[] = this.sentInputs.map((i) => [i.tick, i.bits])
    this.send({ t: 'in', i: payload })
  }

  close(): void {
    if (this.inputTimer) clearInterval(this.inputTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.socket.close()
  }
}

function summarise(values: number[]): string {
  if (values.length === 0) return 'n/a'
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return `mean=${mean.toFixed(1)} p50=${sorted[Math.floor(sorted.length / 2)]} max=${sorted[sorted.length - 1]}`
}

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 1)
  const seconds = Number(process.argv[3] ?? 60)
  console.log(`connecting ${count} bot(s) to ${URL} for ${seconds}s`)

  const bots = Array.from({ length: count }, (_, i) => new Bot(`bot${i + 1}`, URL))
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))

  console.log('')
  for (const bot of bots) {
    const s = bot.stats
    const expected = Math.round(seconds * SNAPSHOT_RATE)
    console.log(`--- ${bot.name} ---`)
    if (s.error) console.log(`  error         ${s.error}`)
    console.log(`  joined        ${s.joined}`)
    console.log(`  snapshots     ${s.snapshots} (expected ~${expected})`)
    console.log(`  snapshot gap  ${summarise(s.gaps)} ms (target ${SNAPSHOT_MS.toFixed(0)})`)
    console.log(`  rtt           ${summarise(s.rtt)} ms`)
    console.log(`  input ack lag ${summarise(s.ackLag)} ticks (0 = server never waited)`)
    console.log(`  events        ${s.events}`)
    console.log(`  progress      lap=${s.lap} cp=${s.cp} score=${s.score} charge=${(s.charge * 100).toFixed(0)}%`)
    console.log(`  phase         ${s.phase}  pos=${s.pos.x.toFixed(1)},${s.pos.y.toFixed(1)},${s.pos.z.toFixed(1)} speed=${s.speed.toFixed(1)} flags=${s.flags}`)
    bot.close()
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
