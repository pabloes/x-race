/**
 * Offline tuning harness: runs the real fixed-timestep simulation with the same bot
 * driver the server uses
 * and prints telemetry, with no network and no Decentraland in the loop.
 *
 *   npm run harness              # one car on the default circuit, until it has done its laps
 *   npm run harness -- skyline   # same, on another circuit
 *   npm run harness -- 60 4      # 60 s, 4 cars
 *   npm run harness -- city 60 4
 *   VERBOSE=1 npm run harness -- 20
 *
 * This is how the track and the vehicle numbers get tuned: it reports whether the car
 * clears the obstacle fields, completes the inverted ceiling run, and how long a lap takes.
 */

import { CAR, TICK_DT, TICK_RATE } from '../../shared/constants'
import { clamp, quatConjugate, quatRotate, vlen, type Vec3 } from '../../shared/math'
import { InputBit } from '../../shared/protocol'
import { checkpointsOf, DEFAULT_TRACK, isTrackId, TRACK_IDS, trackById } from '../../shared/tracks'
import { BOT_SKILLS, BotDriver } from './bot-driver'
import { CarSim } from './car-sim'
import { pointInBox } from './geometry'
import { createWorld, initPhysics } from './physics'

const UP: Vec3 = { x: 0, y: 1, z: 0 }
const VERBOSE = process.env.VERBOSE === '1'
/** Without a duration the run ends when every car has done the laps, or after this long per lap. */
const SECONDS_PER_LAP_CAP = 120

type Driver = { car: CarSim; bot: BotDriver }

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const trackId = args[0] !== undefined && Number.isNaN(Number(args[0])) ? args.shift()! : DEFAULT_TRACK
  if (!isTrackId(trackId)) throw new Error(`unknown track '${trackId}'; known: ${TRACK_IDS.join(', ')}`)
  const TRACK = trackById(trackId)
  const CHECKPOINTS = checkpointsOf(TRACK)
  const untilLaps = args[0] === undefined
  const seconds = untilLaps ? TRACK.laps * SECONDS_PER_LAP_CAP : Number(args[0])
  const carCount = Number(args[1] ?? 1)

  await initPhysics()
  const world = createWorld(TRACK)
  console.log(`engine: ${world.engineName}`)
  console.log(
    `track: ${TRACK.id}  surfaces=${TRACK.surfaces.length}  obstacles=${TRACK.obstacles.length}  ` +
      `waypoints=${TRACK.centreline.length}`
  )

  const drivers: Driver[] = []
  for (let i = 0; i < carCount; i++) {
    const spawn = TRACK.spawns[i % TRACK.spawns.length]
    drivers.push({
      car: new CarSim(i, `bot${i}`, world.createVehicle(spawn.pos, spawn.yaw), spawn, TRACK),
      bot: new BotDriver(BOT_SKILLS[i % BOT_SKILLS.length], TRACK.centreline)
    })
  }

  const stats = drivers.map(() => ({
    maxSpeed: 0,
    maxY: 0,
    respawns: 0,
    tricks: [] as string[],
    laps: [] as number[],
    cpHits: new Set<number>()
  }))

  let totalTicks = Math.round(seconds * TICK_RATE)
  const startWall = performance.now()

  for (let tick = 0; tick < totalTicks; tick++) {
    if (untilLaps && drivers.every((d) => d.car.lap >= TRACK.laps)) {
      totalTicks = tick
      break
    }
    const nowMs = (tick * 1000) / TICK_RATE
    for (let i = 0; i < drivers.length; i++) {
      const d = drivers[i]
      const s = stats[i]
      d.car.setInput(d.bot.think(d.car))
      for (const e of d.car.update(TICK_DT, nowMs, true)) {
        if (e.t === 'respawn') s.respawns++
        if (e.t === 'trick') s.tricks.push(e.name)
        if (e.t === 'lap') s.laps.push(e.lapMs)
        if (e.t === 'cp') s.cpHits.add(e.cp)
      }
      const p = d.car.vehicle.position()
      s.maxSpeed = Math.max(s.maxSpeed, vlen(d.car.vehicle.linvel()))
      s.maxY = Math.max(s.maxY, p.y)
      if (VERBOSE && i === 0 && tick % 15 === 0) {
        const contacts = [0, 1, 2, 3].filter((w) => d.car.vehicle.wheel(w).contact).length
        const up = quatRotate(d.car.vehicle.rotation(), UP)
        console.log(
          `t=${(nowMs / 1000).toFixed(2)} pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} ` +
            `spd=${d.car.vehicle.forwardSpeed().toFixed(1)} wheels=${contacts} up.y=${up.y.toFixed(2)} ` +
            `cp=${d.car.cp} chg=${(d.car.charge * 100).toFixed(0)}%`
        )
      }
    }
    world.step()
  }

  const wall = performance.now() - startWall
  console.log(
    `\nsimulated ${totalTicks} ticks (${(totalTicks / TICK_RATE).toFixed(1)}s) in ${wall.toFixed(0)}ms = ` +
      `${((totalTicks / wall) * 1000).toFixed(0)} ticks/s, ${(wall / totalTicks).toFixed(3)}ms/tick for ${carCount} car(s)`
  )

  for (let i = 0; i < drivers.length; i++) {
    const car = drivers[i].car
    const s = stats[i]
    const p = car.vehicle.position()
    const missing = CHECKPOINTS.map((c) => c.index!).filter((idx) => !s.cpHits.has(idx))
    console.log(`\n--- car ${i} ---`)
    console.log(`  position      ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`)
    console.log(`  laps          ${car.lap}   cp=${car.cp}`)
    console.log(`  lap times     ${s.laps.map((l) => (l / 1000).toFixed(2) + 's').join(', ') || 'none'}`)
    console.log(`  max speed     ${s.maxSpeed.toFixed(1)} m/s (${(s.maxSpeed * 3.6).toFixed(0)} km/h)`)
    console.log(`  max height    ${s.maxY.toFixed(1)} m`)
    // Read off the circuit, not off CITY's checkpoint numbers. The car scores the run once
    // per race, so this says whether it was ever driven, not how many times.
    if (TRACK.triggers.some((t) => t.kind === 'invert')) {
      console.log(`  inverted run  ${s.tricks.includes('Ceiling Run') ? 'yes' : 'NO'}`)
    }
    console.log(`  tricks        ${s.tricks.length}  score=${car.score}  ${[...new Set(s.tricks)].join(', ')}`)
    console.log(`  respawns      ${s.respawns}`)
    console.log(`  charge        ${(car.charge * 100).toFixed(0)}%`)
    console.log(`  cp never hit  ${missing.length ? missing.join(', ') : 'none'}`)
  }

  if (untilLaps) {
    const done = drivers.filter((d) => d.car.lap >= TRACK.laps).length
    console.log(`\n${TRACK.base}: ${done}/${drivers.length} car(s) completed ${TRACK.laps} laps`)
    if (done < drivers.length) process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
