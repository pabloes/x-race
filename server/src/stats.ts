/**
 * What the server remembers about who played and what happened.
 *
 * Two things, and they are deliberately small: a roll of unique visitors, and the last
 * few hundred races with who was in them. It is a record of a game being played, not an
 * analytics product, and everything here is answered from memory in a few microseconds so
 * it can never slow a tick down.
 *
 * **It only survives a restart if it has somewhere to live.** Rooms are in memory, and so
 * is this; a redeploy starts the book again. If `STATS_FILE` is set the roll is written
 * there whenever it changes and read back on boot, which is what makes it survive — and
 * on CapRover that path has to be inside a persistent directory, or the file goes with
 * the container the next time the app is deployed.
 *
 * A visitor is one wallet. Guests have none, so they are counted together as a single
 * line rather than given invented identities: better an honest "and some guests" than a
 * number that looks precise and is not.
 *
 * **Records** live beside the race log rather than in it: the log keeps 300 races, which on
 * a busy day is not even a week, so a best lap of the year cannot be read back from it. The
 * record book keeps, per circuit and metric (best lap, best race over 1, 3, 5... laps), the
 * ten best drivers of every UTC day for a year, plus the ten best of all time. Any range of
 * days is then answered exactly: whoever is in a range's top ten was in their own day's.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { isTrackId, type TrackId } from '../../shared/tracks'

export type Participant = {
  name: string
  address?: string
  rank: number
  laps: number
  bestLapMs: number
  /** Start to finish line, 0 if the car did not finish (and in races logged before it existed). */
  totalMs?: number
  score: number
  finished: boolean
  bot: boolean
}

export type RaceRecord = {
  startedAt: number
  endedAt: number
  mode: string
  /** Missing in races logged before there was more than one circuit: those were CITY. */
  track?: TrackId
  laps: number
  participants: Participant[]
}

/** `lap`, or `race-<laps>` for a whole race of that many laps. */
export type Metric = string

/** One time in the record book: who, how fast, when and in which kind of room. */
export type Mark = {
  track: TrackId
  metric: Metric
  ms: number
  name: string
  address?: string
  at: number
  mode: string
}

export type Range = 'today' | 'week' | 'month' | 'year' | 'all'

/** Days back from today (inclusive) each range covers, in UTC days. */
const RANGE_DAYS: Record<Exclude<Range, 'all'>, number> = { today: 1, week: 7, month: 30, year: 365 }

/** Places kept per circuit, metric and day, and for all time. */
const TOP = 10
/** Days of daily lists kept: a year, plus the day the oldest one in the year's range starts. */
const KEEP_DAYS = 366
const DAY_MS = 86_400_000
const dayOf = (ms: number): number => Math.floor(ms / DAY_MS)
/** Guests have no wallet, so a guest is their name; the two can never collide. */
const driverOf = (m: Mark): string => (m.address ? m.address.toLowerCase() : `guest:${m.name}`)

/**
 * `list` with `mark` in it, if it earns a place: each driver once, at their best, fastest
 * first, at most `TOP` long. Returns whether anything changed.
 */
function place(list: Mark[], mark: Mark): boolean {
  const driver = driverOf(mark)
  const mine = list.findIndex((m) => driverOf(m) === driver)
  if (mine !== -1) {
    if (list[mine].ms <= mark.ms) return false
    list.splice(mine, 1)
  } else if (list.length >= TOP && list[list.length - 1].ms <= mark.ms) {
    return false
  }
  list.push(mark)
  list.sort((a, b) => a.ms - b.ms || a.at - b.at)
  list.length = Math.min(list.length, TOP)
  return true
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
  /** Record book, keyed `track|metric|day` (day lists) and `track|metric` (all time). */
  private readonly daily = new Map<string, Mark[]>()
  private readonly allTime = new Map<string, Mark[]>()
  private guestVisits = 0
  readonly startedAt = Date.now()

  constructor(private readonly file = process.env.STATS_FILE) {
    this.load()
    // Write once at boot, so a path that cannot be written says so in the startup log
    // instead of at the first visitor, hours later, in one line nobody is watching for.
    if (this.file) this.save()
  }

  /** Someone opened the scene. Called once per connection that gets as far as joining. */
  sawVisitor(name: string, address?: string): void {
    const now = Date.now()
    if (!address) {
      this.guestVisits++
      this.save()
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
    // Written here as well as after a race: a visitor who looks around and leaves without
    // finishing anything is still a visitor, and waiting for a race to save them means
    // losing every one of them on a quiet afternoon. Arrivals are human-paced, so this is
    // a few writes an hour, not a hot path.
    this.save()
  }

  recordRace(record: RaceRecord): void {
    this.races.push(record)
    while (this.races.length > MAX_RACES) this.races.shift()
    this.enterRecords(record)
    this.purgeDays(record.endedAt)
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

  /**
   * The top ten of a circuit and metric over a range of UTC days ending today (`now`), or of
   * all time: one line per driver, fastest first.
   */
  records(track: TrackId, metric: Metric, range: Range, now = Date.now()): Mark[] {
    if (range === 'all') return [...(this.allTime.get(`${track}|${metric}`) ?? [])]
    const today = dayOf(now)
    const out: Mark[] = []
    for (let day = today - RANGE_DAYS[range] + 1; day <= today; day++) {
      for (const mark of this.daily.get(`${track}|${metric}|${day}`) ?? []) place(out, mark)
    }
    return out
  }

  /** Every race metric with a time on this circuit, by laps: `race-1`, `race-3`, ... */
  raceMetrics(track: TrackId): Metric[] {
    const laps = new Set<number>()
    for (const key of this.allTime.keys()) {
      const [t, metric] = key.split('|')
      if (t === track && metric.startsWith('race-')) laps.add(Number(metric.slice(5)))
    }
    return [...laps].sort((a, b) => a - b).map((n) => `race-${n}`)
  }

  /** A race's times into the book. Bots are not drivers; unfinished races have no total. */
  private enterRecords(record: RaceRecord): boolean {
    const track: TrackId = record.track && isTrackId(record.track) ? record.track : 'city'
    let changed = false
    for (const p of record.participants) {
      if (p.bot) continue
      const base = { track, name: p.name, address: p.address, at: record.endedAt, mode: record.mode }
      if (p.bestLapMs > 0) changed = this.enter({ ...base, metric: 'lap', ms: p.bestLapMs }) || changed
      if (p.finished && p.totalMs && p.totalMs > 0) {
        changed = this.enter({ ...base, metric: `race-${record.laps}`, ms: p.totalMs }) || changed
      }
    }
    return changed
  }

  private enter(mark: Mark): boolean {
    const dayKey = `${mark.track}|${mark.metric}|${dayOf(mark.at)}`
    const allKey = `${mark.track}|${mark.metric}`
    const day = this.daily.get(dayKey) ?? []
    const ever = this.allTime.get(allKey) ?? []
    const changed = place(day, mark)
    const everChanged = place(ever, mark)
    if (day.length > 0) this.daily.set(dayKey, day)
    if (ever.length > 0) this.allTime.set(allKey, ever)
    return changed || everChanged
  }

  /** Day lists older than a year are no use to any range and go; all-time ones stay. */
  private purgeDays(now: number): void {
    const oldest = dayOf(now) - KEEP_DAYS
    for (const key of this.daily.keys()) {
      if (Number(key.slice(key.lastIndexOf('|') + 1)) < oldest) this.daily.delete(key)
    }
  }

  private load(): void {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as {
        visitors: Visitor[]
        races: RaceRecord[]
        guestVisits: number
        records?: { daily: Mark[][]; allTime: Mark[][] }
      }
      for (const v of saved.visitors ?? []) {
        if (v.address) this.visitors.set(v.address.toLowerCase(), v)
      }
      this.races.push(...(saved.races ?? []).slice(-MAX_RACES))
      this.guestVisits = saved.guestVisits ?? 0
      if (saved.records) {
        for (const list of saved.records.daily) {
          if (list.length > 0) this.daily.set(`${list[0].track}|${list[0].metric}|${dayOf(list[0].at)}`, list)
        }
        for (const list of saved.records.allTime) {
          if (list.length > 0) this.allTime.set(`${list[0].track}|${list[0].metric}`, list)
        }
      } else {
        // A file from before the record book: seed it from the races the log still has.
        for (const race of this.races) this.enterRecords(race)
      }
      this.purgeDays(Date.now())
      console.log(
        `[stats] loaded ${this.visitors.size} visitor(s), ${this.races.length} race(s) and ` +
          `${this.daily.size} day(s) of records`
      )
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
          guestVisits: this.guestVisits,
          records: { daily: [...this.daily.values()], allTime: [...this.allTime.values()] }
        })
      )
    } catch (error) {
      console.warn(`[stats] could not write ${this.file}: ${String(error)}`)
    }
  }
}
