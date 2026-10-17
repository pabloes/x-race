/**
 * Wire protocol.
 *
 * Decentraland's scene runtime only exposes `WebSocket.send(data: string)`, so there is
 * no binary frame available and everything here is JSON. To keep the hot path small,
 * car state travels as a fixed-layout number array (see `encodeCar` / `decodeCar`) and
 * floats are rounded before serialising; everything else uses readable objects.
 */

import type { Quat, Vec3 } from './math'

// --- Input ------------------------------------------------------------------

/** Bit flags for a single tick of input. Decentraland only gives digital keys. */
export const enum InputBit {
  Throttle = 1 << 0,
  Brake = 1 << 1,
  Left = 1 << 2,
  Right = 1 << 3,
  Handbrake = 1 << 4,
  /** Speed boost, armed by double-tapping the throttle. */
  Boost = 1 << 5,
  /** Requests the assisted flip / barrel roll while airborne. */
  Flip = 1 << 6,
  /** Cold-gas thrusters: lifts the car straight up. */
  Thrust = 1 << 7
}

/** One input sample: the tick it was produced for, and the keys held at that moment. */
export type Input = { tick: number; bits: number }

/** `[tick, bits]` — the compact form sent over the wire. */
export type WireInput = [number, number]

export function encodeInput(i: Input): WireInput {
  return [i.tick, i.bits]
}

export function decodeInput(w: WireInput): Input {
  return { tick: w[0], bits: w[1] }
}

export function hasBit(bits: number, bit: InputBit): boolean {
  return (bits & bit) !== 0
}

/** Steering axis derived from the left/right bits. */
export function steerAxis(bits: number): number {
  return (hasBit(bits, InputBit.Right) ? 1 : 0) - (hasBit(bits, InputBit.Left) ? 1 : 0)
}

// --- Car state --------------------------------------------------------------

export const enum CarFlag {
  Grounded = 1 << 0,
  Boosting = 1 << 1,
  /** Gravity is inverted for this car (ceiling run). */
  Inverted = 1 << 2,
  /** A server-driven trick rotation is in progress. */
  Tricking = 1 << 3,
  Handbraking = 1 << 4,
  Respawning = 1 << 5,
  Finished = 1 << 6,
  /** The car is airborne and accumulating rotation for a trick score. */
  Airborne = 1 << 7,
  /** Thrusters firing. */
  Thrusting = 1 << 8
}

export type CarState = {
  /** Stable per-connection id, also used as the key for the client's entity pool. */
  id: number
  pos: Vec3
  rot: Quat
  /** Linear velocity, used by the client to extrapolate when snapshots are late. */
  vel: Vec3
  /** Front wheel steering angle in radians, for visual wheel turn. */
  steer: number
  /** Wheel spin angle in radians, shared by all four wheels. */
  spin: number
  /** Suspension compression per wheel, 0 = extended, 1 = fully compressed. FL FR RL RR. */
  susp: [number, number, number, number]
  flags: number
  /** Battery / boost bar, 0..1. */
  charge: number
  lap: number
  /** Index of the last checkpoint passed. */
  cp: number
  /** 1-based race position. */
  rank: number
  /** Accumulated trick score this race. */
  score: number
}

/**
 * Fixed layout:
 * 0 id | 1-3 pos | 4-7 rot | 8-10 vel | 11 steer | 12 spin | 13-16 susp
 * 17 flags | 18 charge | 19 lap | 20 cp | 21 rank | 22 score
 */
export type WireCar = number[]
export const WIRE_CAR_LENGTH = 23

const P2 = 100
const P3 = 1000

function r(v: number, p: number): number {
  return Math.round(v * p) / p
}

export function encodeCar(c: CarState): WireCar {
  return [
    c.id,
    r(c.pos.x, P2),
    r(c.pos.y, P2),
    r(c.pos.z, P2),
    r(c.rot.x, P3),
    r(c.rot.y, P3),
    r(c.rot.z, P3),
    r(c.rot.w, P3),
    r(c.vel.x, P2),
    r(c.vel.y, P2),
    r(c.vel.z, P2),
    r(c.steer, P2),
    r(c.spin, P2),
    r(c.susp[0], P2),
    r(c.susp[1], P2),
    r(c.susp[2], P2),
    r(c.susp[3], P2),
    c.flags,
    r(c.charge, P3),
    c.lap,
    c.cp,
    c.rank,
    c.score
  ]
}

export function decodeCar(w: WireCar): CarState {
  return {
    id: w[0],
    pos: { x: w[1], y: w[2], z: w[3] },
    rot: { x: w[4], y: w[5], z: w[6], w: w[7] },
    vel: { x: w[8], y: w[9], z: w[10] },
    steer: w[11],
    spin: w[12],
    susp: [w[13], w[14], w[15], w[16]],
    flags: w[17],
    charge: w[18],
    lap: w[19],
    cp: w[20],
    rank: w[21],
    score: w[22]
  }
}

// --- Race state -------------------------------------------------------------

export type RacePhase = 'lobby' | 'countdown' | 'racing' | 'finished'

export type RaceState = {
  phase: RacePhase
  /** Milliseconds until the phase changes (countdown, podium timer, lobby wait). */
  phaseMs: number
  /** Elapsed race time in ms; 0 before the start. */
  timeMs: number
  laps: number
  /** Room settings, so the menu always shows what the server actually has. */
  mode: RaceMode
  bots: number
  /** True while the lobby is counting down to an automatic start. */
  autoStart: boolean
}

export type Standing = {
  id: number
  name: string
  lap: number
  rank: number
  /** Total race time in ms once finished, otherwise 0. */
  totalMs: number
  bestLapMs: number
  score: number
  finished: boolean
}

export type PlayerInfo = { id: number; name: string; ready: boolean; bot: boolean; spectator: boolean }

// --- Events -----------------------------------------------------------------

export type GameEvent =
  | { t: 'join'; id: number; name: string }
  | { t: 'leave'; id: number }
  | { t: 'countdown'; ms: number }
  | { t: 'go' }
  | { t: 'lap'; id: number; lap: number; lapMs: number; best: boolean }
  | { t: 'cp'; id: number; cp: number }
  | { t: 'trick'; id: number; name: string; points: number }
  | { t: 'invert'; id: number; entered: boolean }
  | { t: 'pad'; id: number }
  | { t: 'respawn'; id: number }
  | { t: 'finish'; id: number; rank: number; totalMs: number }
  | { t: 'race-end'; standings: Standing[] }

// --- Messages ---------------------------------------------------------------

/** What the lobby menu can ask the server to do. */
export type RaceMode = 'solo' | 'multiplayer'

export type ClientMessage =
  | { t: 'join'; v: number; name: string }
  | { t: 'in'; i: WireInput[] }
  | { t: 'ready'; ready: boolean }
  | { t: 'respawn' }
  /** Start the countdown now instead of waiting for the lobby timer. */
  | { t: 'start' }
  /** Step out of the current race. The race carries on without you. */
  | { t: 'leave-race' }
  /** Watch instead of drive, or ask for a grid slot back. */
  | { t: 'spectate'; on: boolean }
  /** Solo locks the room to this player plus bots; multiplayer opens it up. */
  | { t: 'mode'; mode: RaceMode }
  /** Number of bots the room should field, 0..7. */
  | { t: 'bots'; count: number }
  | { t: 'laps'; laps: number }
  /** Clock sync probe. The server echoes it back as `pong` with its own clock attached. */
  | { t: 'ping'; id: number; clientTime: number }

export type ServerMessage =
  | {
      t: 'welcome'
      id: number
      /** Server tick at the moment the welcome was sent. */
      tick: number
      /** Server clock in ms, the reference for all snapshot timestamps. */
      now: number
      trackId: string
      tickRate: number
      snapshotRate: number
      players: PlayerInfo[]
    }
  | {
      t: 's'
      tick: number
      now: number
      cars: WireCar[]
      race: RaceState
      /** Highest input tick the server has consumed for this client, for RTT/lag display. */
      ack: number
    }
  | { t: 'ev'; e: GameEvent[] }
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'standings'; standings: Standing[] }
  /**
   * Reply to the client's `ping`, carrying both the client's original timestamp and the
   * server clock, which is all the client needs to derive the round trip and the offset
   * between the two clocks without either side trusting the other's wall clock.
   */
  | { t: 'pong'; id: number; clientTime: number; serverNow: number }
  | { t: 'error'; message: string }

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw)
    return m && typeof m.t === 'string' ? (m as ClientMessage) : null
  } catch {
    return null
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const m = JSON.parse(raw)
    return m && typeof m.t === 'string' ? (m as ServerMessage) : null
  } catch {
    return null
  }
}

export function formatTime(ms: number): string {
  if (ms <= 0) return '0:00.00'
  const total = Math.floor(ms)
  const m = Math.floor(total / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const cs = Math.floor((total % 1000) / 10)
  return `${m}:${s < 10 ? '0' : ''}${s}.${cs < 10 ? '0' : ''}${cs}`
}
