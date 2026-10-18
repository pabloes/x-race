/**
 * What the server remembers about who played and what happened.
 *
 * Two things, and they are deliberately small: a roll of unique visitors, and the last
 * few hundred races with who was in them. It is a record of a game being played, not an
 * analytics product, and everything here is answered from memory in a few microseconds so
 * it can never slow a tick down.
 *
 * **It does not survive a restart.** Rooms are in memory, and so is this; a redeploy
 * starts the book again. If `STATS_FILE` is set the roll is written there after each race
 * and read back on boot, which is what makes it survive — and on CapRover that path has
 * to be inside a persistent volume, or the file goes with the container.
 *
 * A visitor is one wallet. Guests have none, so they are counted together as a single
 * line rather than given invented identities: better an honest "and some guests" than a
 * number that looks precise and is not.
 */

import { readFileSync, writeFileSync } from 'node:fs'

export type Participant = {
  name: string
  address?: string
  rank: number
  laps: number
  bestLapMs: number
  score: number
  finished: boolean
  bot: boolean
}

export type RaceRecord = {
  startedAt: number
  endedAt: number
  mode: string
  laps: number
  participants: Participant[]
}

type Visitor = {
  name: string
  address?: string
  firstSeenAt: number
  lastSeenAt: number
  visits: number
  races: number
}

/** Races kept in the log. Old ones fall off the end rather than growing without limit. */
const MAX_RACES = 300

export class Stats {
  private readonly visitors = new Map<string, Visitor>()
  private readonly races: RaceRecord[] = []
  private guestVisits = 0
  readonly startedAt = Date.now()

  constructor(private readonly file = process.env.STATS_FILE) {
    this.load()
  }

  /** Someone opened the scene. Called once per connection that gets as far as joining. */
  sawVisitor(name: string, address?: string): void {
    const now = Date.now()
    if (!address) {
      this.guestVisits++
      return
    }
    const key = address.toLowerCase()
    const seen = this.visitors.get(key)
    if (seen) {
      seen.lastSeenAt = now
      seen.visits++
      seen.name = name || seen.name
    } else {
      this.visitors.set(key, {
        name: name || 'driver',
        address,
        firstSeenAt: now,
        lastSeenAt: now,
        visits: 1,
        races: 0
      })
    }
  }

  recordRace(record: RaceRecord): void {
    this.races.push(record)
    while (this.races.length > MAX_RACES) this.races.shift()
    for (const p of record.participants) {
      if (p.bot || !p.address) continue
      const seen = this.visitors.get(p.address.toLowerCase())
      if (seen) seen.races++
    }
    this.save()
  }

  summary(): {
    uniqueVisitors: number
    guestVisits: number
    races: number
    startedAt: number
    visitors: Visitor[]
    recent: RaceRecord[]
  } {
    return {
      uniqueVisitors: this.visitors.size,
      guestVisits: this.guestVisits,
      races: this.races.length,
      startedAt: this.startedAt,
      visitors: [...this.visitors.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
      recent: [...this.races].reverse()
    }
  }

  private load(): void {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as {
        visitors: Visitor[]
        races: RaceRecord[]
        guestVisits: number
      }
      for (const v of saved.visitors ?? []) {
        if (v.address) this.visitors.set(v.address.toLowerCase(), v)
      }
      this.races.push(...(saved.races ?? []).slice(-MAX_RACES))
      this.guestVisits = saved.guestVisits ?? 0
      console.log(`[stats] loaded ${this.visitors.size} visitor(s) and ${this.races.length} race(s)`)
    } catch {
      // No file yet, or an unreadable one: start the book fresh rather than refuse to boot.
    }
  }

  private save(): void {
    if (!this.file) return
    try {
      writeFileSync(
        this.file,
        JSON.stringify({
          visitors: [...this.visitors.values()],
          races: this.races,
          guestVisits: this.guestVisits
        })
      )
    } catch (error) {
      console.warn(`[stats] could not write ${this.file}: ${String(error)}`)
    }
  }
}
