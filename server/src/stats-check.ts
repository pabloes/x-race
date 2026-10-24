/**
 * Checks the record book with synthetic races on chosen dates: what each range (today,
 * week, month, year, all time) includes, that bots do not count, one line per driver, the
 * top-ten cap, the yearly purge, and that all of it survives writing the file and reading it
 * back, including a file from before there were records or more than one circuit.
 *
 *   npm run test:stats
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Stats, type Participant, type RaceRecord } from './stats'
import { statsPage } from './stats-page'

const DAY = 86_400_000
const now = Date.now()
const dir = mkdtempSync(join(tmpdir(), 'roadster-stats-'))
const file = join(dir, 'stats.json')

let failed = 0
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

function driver(name: string, bestLapMs: number, totalMs: number, extra: Partial<Participant> = {}): Participant {
  return {
    name,
    address: `0x${name.padEnd(40, '0').slice(0, 40)}`,
    rank: 1,
    laps: 3,
    bestLapMs,
    totalMs,
    score: 0,
    finished: totalMs > 0,
    bot: false,
    ...extra
  }
}

function race(daysAgo: number, track: 'city' | 'skyline', laps: number, participants: Participant[]): RaceRecord {
  const endedAt = now - daysAgo * DAY
  return { startedAt: endedAt - 90_000, endedAt, mode: 'multiplayer', track, laps, participants }
}

try {
  console.log('record book:')
  const stats = new Stats(file)
  // Oldest first, as a real server would see them.
  stats.recordRace(race(400, 'city', 3, [driver('ancient', 20_000, 70_000)]))
  stats.recordRace(race(200, 'city', 3, [driver('spring', 21_000, 71_000)]))
  stats.recordRace(race(20, 'city', 3, [driver('lastmonth', 22_000, 72_000)]))
  stats.recordRace(race(3, 'city', 3, [driver('thisweek', 23_000, 73_000)]))
  stats.recordRace(
    race(0, 'city', 3, [
      driver('today', 24_210, 74_000),
      driver('robot', 1_000, 10_000, { bot: true }),
      driver('walker', 0, 0, { address: undefined, finished: false })
    ])
  )
  // The same driver twice today: only the better time stands.
  stats.recordRace(race(0, 'city', 3, [driver('today', 24_500, 73_500)]))
  stats.recordRace(race(0, 'skyline', 1, [driver('sky', 30_000, 31_000)]))
  stats.recordRace(race(0, 'city', 5, [driver('long', 25_000, 130_000)]))

  const names = (track: 'city' | 'skyline', metric: string, range: Parameters<Stats['records']>[2], s = stats) =>
    s.records(track, metric, range, now).map((m) => m.name)
  const expect = (what: string, got: string[], want: string[]) =>
    check(what, JSON.stringify(got) === JSON.stringify(want), `got ${got.join(', ') || 'none'}`)

  expect('today: only today', names('city', 'lap', 'today'), ['today', 'long'])
  expect('week: today and 3 days ago', names('city', 'lap', 'week'), ['thisweek', 'today', 'long'])
  expect('month: back to 20 days', names('city', 'lap', 'month'), ['lastmonth', 'thisweek', 'today', 'long'])
  expect('year: back to 200 days', names('city', 'lap', 'year'), ['spring', 'lastmonth', 'thisweek', 'today', 'long'])
  expect('all time keeps the 400-day lap after the purge', names('city', 'lap', 'all'), [
    'ancient',
    'spring',
    'lastmonth',
    'thisweek',
    'today',
    'long'
  ])
  check('bots never count', !names('city', 'lap', 'all').includes('robot'))
  const mine = stats.records('city', 'race-3', 'today', now)
  check('one line per driver, at their best', mine.length === 1 && mine[0].ms === 73_500, `${mine.map((m) => m.ms).join(', ')}`)
  expect('race totals are per lap count', names('city', 'race-5', 'all'), ['long'])
  expect('circuits are kept apart', names('skyline', 'race-1', 'all'), ['sky'])
  check('race lengths with times are listed', JSON.stringify(stats.raceMetrics('city')) === '["race-3","race-5"]')

  // Fifteen drivers on one day: ten places, and today's faster lap ahead of them all.
  for (let i = 0; i < 15; i++) stats.recordRace(race(1, 'skyline', 3, [driver(`d${i}`, 40_000 + i * 100, 0)]))
  expect('ten places, the fastest ten', names('skyline', 'lap', 'week'), ['sky', ...[...Array(9).keys()].map((i) => `d${i}`)])

  console.log('persistence:')
  const reloaded = new Stats(file)
  for (const range of ['today', 'week', 'month', 'year', 'all'] as const) {
    expect(`${range} reads back the same`, names('city', 'lap', range, reloaded), names('city', 'lap', range))
  }
  expect('skyline reads back the same', names('skyline', 'lap', 'week', reloaded), names('skyline', 'lap', 'week'))

  console.log('a file from before the record book:')
  writeFileSync(
    file,
    JSON.stringify({
      visitors: [],
      guestVisits: 0,
      races: [{ startedAt: now - 100_000, endedAt: now - 10_000, mode: 'solo', laps: 3, participants: [driver('old', 26_000, 0)] }]
    })
  )
  const old = new Stats(file)
  expect('races without a circuit are CITY, and seed the book', names('city', 'lap', 'today', old), ['old'])

  console.log('page:')
  const page = statsPage(stats, 'rapier3d', 1, 0, new URLSearchParams('track=city&range=week'))
  check('times read 0:24.21', page.includes('0:24.21'))
  check('the range and circuit links are there', page.includes('/stats?track=skyline&amp;range=week') && page.includes('ALL TIME'))
  check('boards for 1, 3 and 5 laps', ['1 lap<', '3 laps', '5 laps'].every((t) => page.includes(t)))
  const defaults = statsPage(stats, 'rapier3d', 1, 0)
  check('no query: CITY, all time', defaults.includes('ancient'))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nstats: ok')
