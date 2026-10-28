/**
 * Which room a connection is in.
 *
 * There is one multiplayer room, shared by everyone: it is the race people can watch,
 * and the only thing that is in sync between players. A player who picks SOLO gets a
 * room of their own, with its own physics world, so their bots and their restarts are
 * nobody else's business — and so that starting a solo race never waits for, interrupts
 * or is interrupted by whatever the shared room is doing.
 *
 * Switching mode is a move between rooms, not a setting: the connection leaves one and
 * joins the other, which sends it a fresh welcome with a new id. That is also why the
 * tick number is handed down from the loop (see `Room.step`): every room counts in the
 * same ticks, so a client's input stamps stay valid across the move.
 */

import type { RaceMode } from '../../shared/protocol'
import { DEFAULT_TRACK, trackById } from '../../shared/tracks'
import { Room, type Connection } from './room'
import type { RaceRecord } from './stats'

type Seat = { room: Room; playerId: number; name: string; address?: string }

export class Rooms {
  private readonly shared: Room
  private readonly seats = new Map<Connection, Seat>()
  private readonly solo = new Map<Connection, Room>()

  /** Every room reports its finished races here, solo rooms included. */
  constructor(private readonly onRaceFinished: (record: RaceRecord) => void = () => {}) {
    this.shared = this.build('multiplayer')
  }

  private build(mode: RaceMode): Room {
    const room = new Room(trackById(DEFAULT_TRACK))
    room.onMode(mode)
    room.onRaceFinished = this.onRaceFinished
    return room
  }

  get playerCount(): number {
    let count = this.shared.playerCount
    for (const room of this.solo.values()) count += room.playerCount
    return count
  }

  /** The shared room plus one per solo player, for the health endpoint. */
  get roomCount(): number {
    return 1 + this.solo.size
  }

  get sharedTick(): number {
    return this.shared.currentTick
  }

  seatOf(connection: Connection): Seat | undefined {
    return this.seats.get(connection)
  }

  join(name: string, connection: Connection, nowMs: number, address?: string): Seat | null {
    const room = this.build('solo')
    const player = room.join(name, connection, nowMs, address)
    if (!player) return null
    room.onBotCount(1)
    const seat: Seat = { room, playerId: player.id, name, address }
    this.solo.set(connection, room)
    this.seats.set(connection, seat)
    return seat
  }

  /**
   * Moves a connection between the shared room and its own.
   *
   * The mode is no longer something one player can change for everybody — which is what
   * it was when there was a single room and a single setting on it.
   */
  setMode(connection: Connection, mode: RaceMode, nowMs: number): Seat | undefined {
    const seat = this.seats.get(connection)
    if (!seat) return undefined
    const wantsSolo = mode === 'solo'
    const isSolo = seat.room !== this.shared
    if (wantsSolo === isSolo) return seat

    seat.room.leave(seat.playerId)
    this.dropEmptySolo(connection)

    let target: Room
    if (wantsSolo) {
      target = this.build('solo')
      this.solo.set(connection, target)
    } else {
      target = this.shared
    }
    const player = target.join(seat.name, connection, nowMs, seat.address)
    if (!player) {
      this.seats.delete(connection)
      return undefined
    }
    const moved: Seat = { room: target, playerId: player.id, name: seat.name, address: seat.address }
    this.seats.set(connection, moved)
    return moved
  }

  leave(connection: Connection): void {
    const seat = this.seats.get(connection)
    if (!seat) return
    seat.room.leave(seat.playerId)
    this.seats.delete(connection)
    this.dropEmptySolo(connection)
  }

  /** A private room with nobody in it is a physics world stepping for no reason. */
  private dropEmptySolo(connection: Connection): void {
    const room = this.solo.get(connection)
    if (room && room.playerCount === 0) this.solo.delete(connection)
  }

  step(nowMs: number, tick: number): void {
    this.shared.step(nowMs, tick)
    for (const room of this.solo.values()) room.step(nowMs, tick)
  }
}
