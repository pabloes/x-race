/**
 * Targeted physics tests for the set pieces and the driving aids: the launch ramp, the
 * thrusters, the self-righting assist and the inverted ceiling run.
 *
 *   npm run test:features             # the default circuit
 *   npm run test:features -- skyline  # scenarios from scenarios/<id>.ts
 *
 * Each scenario drops a car at a known point with a known speed, holds a fixed input, and
 * asserts what the car did. This is far more useful than watching a general-purpose AI
 * drive: it pins down the minimum entry speed for every feature and fails loudly when a
 * change to the track or the vehicle breaks one of them.
 */

import { CAR, TICK_DT } from '../../shared/constants'
import { quatFromEulerDegrees, quatRotate, vlen, type Vec3 } from '../../shared/math'
import { InputBit } from '../../shared/protocol'
import { DEFAULT_TRACK, isTrackId, lineOffset, TRACK_IDS, trackById } from '../../shared/tracks'
import { CarSim } from './car-sim'
import { createWorld, initPhysics } from './physics'
import { SCENARIOS, type Scenario } from './scenarios'

const UP: Vec3 = { x: 0, y: 1, z: 0 }
const FORWARD: Vec3 = { x: 0, y: 0, z: 1 }
const VERBOSE = process.env.VERBOSE === '1'

const TRACK_ID = process.argv[2] ?? DEFAULT_TRACK
if (!isTrackId(TRACK_ID)) throw new Error(`unknown track '${TRACK_ID}'; known: ${TRACK_IDS.join(', ')}`)
const TRACK = trackById(TRACK_ID)

type Result = {
  maxY: number
  minY: number
  maxSpeed: number
  cps: number[]
  tricks: string[]
  inverted: boolean
  wentUpsideDown: boolean
  endedUpright: boolean
  endedGrounded: boolean
  /** Ticks spent with wheels on the slab, upside down: what a ceiling run actually is. */
  ceilingTicks: number
  respawns: number
  /** Upright, on its wheels and how high, a second after the first respawn. */
  afterRespawn: { upright: boolean; grounded: boolean; y: number } | null
  /** Closest the car came to the scenario's `requirePass` point. */
  closest: number
  end: Vec3
}

async function run(s: Scenario): Promise<Result> {
  const world = createWorld(TRACK)
  const car = new CarSim(0, s.name, world.createVehicle(s.start.pos, s.start.yaw), s.start, TRACK)
  // Checkpoints only count in lap order, so pretend the car already passed the previous
  // one; otherwise an isolated scenario can never register the checkpoint under test.
  if (s.requireCp !== undefined) car.cp = s.requireCp - 1
  if (s.lastCp !== undefined) {
    car.cp = s.lastCp
    car.cpTotal = s.lastCp
  }
  // Full battery. These scenarios measure what the car does, not what the charge economy
  // allows: a race starts at a tenth of a bar on purpose, and a thruster test that fails
  // because the bar ran out is testing the wrong thing.
  car.charge = 1
  // Launch the car at the scenario speed along its own forward axis.
  const forward = quatRotate(quatFromEulerDegrees(0, s.start.yaw, 0), FORWARD)
  car.vehicle.setLinvel({ x: forward.x * s.speed, y: 0, z: forward.z * s.speed })
  if (s.spin) car.vehicle.setAngvel(s.spin)

  const r: Result = {
    maxY: -Infinity,
    minY: Infinity,
    maxSpeed: 0,
    cps: [],
    tricks: [],
    inverted: false,
    wentUpsideDown: false,
    endedUpright: false,
    endedGrounded: false,
    ceilingTicks: 0,
    respawns: 0,
    afterRespawn: null,
    closest: Infinity,
    end: { x: 0, y: 0, z: 0 }
  }
  let respawnTick = -1
  let lineIndex = 0

  const ticks = Math.round(s.seconds * 60)
  for (let tick = 0; tick < ticks; tick++) {
    // Throttle doubles as nose-down pitch in the air, so it is released once airborne —
    // holding it through a jump front-flips the car, which is a player mistake, not a bug.
    const airborne = ![0, 1, 2, 3].some((i) => car.vehicle.wheel(i).contact)
    let bits = airborne ? s.bits & ~(InputBit.Throttle | InputBit.Boost) : s.bits
    if (s.flipOnce && r.tricks.length === 0) bits |= InputBit.Flip
    if (s.thrustOnHint) {
      lineIndex = lineOffset(TRACK, car.vehicle.position(), lineIndex).index
      // The point the car is heading for, not the one it is level with: a bot aims ahead.
      if (TRACK.centreline[(lineIndex + 1) % TRACK.centreline.length].hint === 'thrust') bits |= InputBit.Thrust
    }
    if (s.requireRespawn && r.respawns > 0) bits = 0
    car.setInput(bits)
    for (const e of car.update(TICK_DT, (tick * 1000) / 60, true)) {
      if (e.t === 'cp') r.cps.push(e.cp)
      if (e.t === 'trick') r.tricks.push(e.name)
      if (e.t === 'invert' && e.entered) r.inverted = true
      if (e.t === 'respawn' && r.respawns++ === 0) respawnTick = tick
    }
    world.step()
    const p = car.vehicle.position()
    const up = quatRotate(car.vehicle.rotation(), UP)
    r.maxY = Math.max(r.maxY, p.y)
    r.minY = Math.min(r.minY, p.y)
    r.maxSpeed = Math.max(r.maxSpeed, vlen(car.vehicle.linvel()))
    if (up.y < -0.5) r.wentUpsideDown = true
    if (s.requirePass) {
      r.closest = Math.min(r.closest, Math.hypot(p.x - s.requirePass.pos.x, p.y - s.requirePass.pos.y, p.z - s.requirePass.pos.z))
    }
    if (respawnTick >= 0 && tick === respawnTick + 60) {
      r.afterRespawn = {
        upright: up.y > 0.7,
        grounded: [0, 1, 2, 3].some((i) => car.vehicle.wheel(i).contact),
        y: p.y
      }
    }
    if (up.y < -0.5 && p.y > 4 && [0, 1, 2, 3].some((i) => car.vehicle.wheel(i).contact)) {
      r.ceilingTicks++
    }
    if (VERBOSE && tick % 15 === 0) {
      console.log(
        `    t=${(tick / 60).toFixed(2)} pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} ` +
          `spd=${car.vehicle.forwardSpeed().toFixed(1)} up.y=${up.y.toFixed(2)} ` +
          `wheels=${[0, 1, 2, 3].filter((i) => car.vehicle.wheel(i).contact).length}`
      )
    }
  }

  const up = quatRotate(car.vehicle.rotation(), UP)
  r.endedUpright = up.y > 0.7
  r.endedGrounded = [0, 1, 2, 3].some((i) => car.vehicle.wheel(i).contact)
  r.end = car.vehicle.position()
  world.removeVehicle(car.vehicle)
  return r
}

const SCENARIO_LIST: Scenario[] = SCENARIOS[TRACK_ID](TRACK)

async function main(): Promise<void> {
  await initPhysics()
  let failures = 0
  let group = ''
  for (const s of SCENARIO_LIST) {
    const g = s.name.split(' ')[0]
    if (g !== group) {
      group = g
      console.log(`\n=== ${g} ===`)
    }
    const r = await run(s)
    const ok =
      (s.requireCp === undefined || r.cps.includes(s.requireCp)) &&
      (s.requireUpright !== true || (r.endedUpright && r.endedGrounded)) &&
      (s.requireHeight === undefined || r.maxY >= s.requireHeight) &&
      (s.requireCeiling !== true || r.ceilingTicks >= 15) &&
      (s.requireRespawn !== true ||
        (r.afterRespawn !== null && r.afterRespawn.upright && r.afterRespawn.grounded)) &&
      (s.requireMinY === undefined || r.minY >= s.requireMinY) &&
      (s.requirePass === undefined || r.closest <= s.requirePass.radius) &&
      (s.requireTrick === undefined || r.tricks.includes(s.requireTrick))
    const flags = [
      `maxY=${r.maxY.toFixed(1)}`,
      `maxSpd=${r.maxSpeed.toFixed(1)}`,
      `cps=[${[...new Set(r.cps)].join(',')}]`,
      r.wentUpsideDown ? 'upsideDown' : '',
      r.inverted ? 'invertZone' : '',
      r.ceilingTicks ? `onCeiling=${(r.ceilingTicks / 60).toFixed(2)}s` : '',
      r.endedUpright ? 'upright' : 'NOT-upright',
      r.endedGrounded ? 'grounded' : 'airborne',
      r.respawns ? `respawns=${r.respawns}` : '',
      r.afterRespawn ? `back at y=${r.afterRespawn.y.toFixed(1)}${r.afterRespawn.upright ? '' : ' NOT-upright'}` : '',
      s.requirePass ? `passed ${r.closest.toFixed(1)} m off` : '',
      s.requireMinY !== undefined ? `minY=${r.minY.toFixed(1)}` : '',
      r.tricks.length ? `tricks=${[...new Set(r.tricks)].join('/')}` : ''
    ]
      .filter(Boolean)
      .join('  ')
    console.log(`  ${ok ? 'PASS' : 'fail'}  ${s.name.padEnd(18)} ${flags}`)
    console.log(
      `        end=${r.end.x.toFixed(1)},${r.end.y.toFixed(1)},${r.end.z.toFixed(1)}`
    )
    if (!ok) failures++
  }
  console.log(
    `\n${SCENARIO_LIST.length - failures}/${SCENARIO_LIST.length} scenarios met their requirement ` +
      `(slow approaches are expected to fall short)`
  )
  console.log(`car: ${CAR.mass} kg, ${CAR.engineForce} N, top ${CAR.maxSpeed}/${CAR.maxSpeedBoost} m/s`)
  console.log(`track: ${TRACK.id}, ${TRACK.surfaces.length} surfaces, ${TRACK.obstacles.length} obstacles`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
