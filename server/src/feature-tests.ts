/**
 * Targeted physics tests for the set pieces and the driving aids: the launch ramp, the
 * thrusters, the self-righting assist and the inverted ceiling run.
 *
 *   npm run test:features
 *
 * Each scenario drops a car at a known point with a known speed, holds a fixed input, and
 * asserts what the car did. This is far more useful than watching a general-purpose AI
 * drive: it pins down the minimum entry speed for every feature and fails loudly when a
 * change to the track or the vehicle breaks one of them.
 */

import { CAR, TICK_DT } from '../../shared/constants'
import { quatFromEulerDegrees, quatRotate, vlen, type Vec3 } from '../../shared/math'
import { InputBit } from '../../shared/protocol'
import { CHECKPOINTS, TRACK } from '../../shared/track'
import { CarSim } from './car-sim'
import { initRapier, RapierWorld } from './physics/rapier'

const UP: Vec3 = { x: 0, y: 1, z: 0 }
const FORWARD: Vec3 = { x: 0, y: 0, z: 1 }
const VERBOSE = process.env.VERBOSE === '1'

const PATH = TRACK.centreline

/** Index of the point on the racing line closest to `p`, in the XZ plane. */
function nearestIndex(p: Vec3): number {
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < PATH.length; i++) {
    const d = (PATH[i].x - p.x) ** 2 + (PATH[i].z - p.z) ** 2
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  }
  return best
}

/**
 * A grid slot `metres` of road *before* the point at `index`, facing along the line.
 *
 * Scenarios are anchored to the track rather than to literal coordinates: the circuit is
 * generated, so the first time it was regenerated every hand-written start position ended
 * up in a field, and sixteen of eighteen scenarios failed for that reason alone.
 */
function approach(index: number, metres: number): { pos: Vec3; yaw: number } {
  let i = index
  let walked = 0
  while (walked < metres) {
    const previous = (i - 1 + PATH.length) % PATH.length
    walked += Math.hypot(PATH[i].x - PATH[previous].x, PATH[i].z - PATH[previous].z)
    i = previous
  }
  const next = PATH[(i + 1) % PATH.length]
  return {
    pos: { x: PATH[i].x, y: 0.95, z: PATH[i].z },
    yaw: (Math.atan2(next.x - PATH[i].x, next.z - PATH[i].z) * 180) / Math.PI
  }
}

/** The first checkpoint the car meets after `index`: the one that proves it got through. */
function checkpointAfter(index: number): number {
  const marks = CHECKPOINTS.map((cp) => ({
    index: cp.index ?? 0,
    gap: (nearestIndex(cp.pos) - index + PATH.length) % PATH.length
  }))
  return marks.reduce((a, b) => (b.gap < a.gap ? b : a)).index
}

// Where the set pieces actually are on the generated circuit.
const RAMPS = TRACK.surfaces.filter((s) => s.kind === 'ramp')
const INVERT_ZONE = TRACK.triggers.find((t) => t.kind === 'invert')
const INVERT_INDEX = INVERT_ZONE ? nearestIndex(INVERT_ZONE.pos) : 0
// Of the two ramps, the kicker is the one that feeds the invert zone; the other is the jump.
const KICKER = RAMPS.reduce((a, b) =>
  Math.abs(nearestIndex(b.pos) - INVERT_INDEX) < Math.abs(nearestIndex(a.pos) - INVERT_INDEX) ? b : a
)
const JUMP = RAMPS.find((r) => r !== KICKER) ?? KICKER
const JUMP_INDEX = nearestIndex(JUMP.pos)
const KICKER_INDEX = nearestIndex(KICKER.pos)
/** Flat road, for the tests that only need a surface: the front row of the grid. */
const GRID = TRACK.spawns[0]

type Scenario = {
  name: string
  start: { pos: Vec3; yaw: number }
  speed: number
  seconds: number
  bits: number
  /** Checkpoint that proves the feature was completed. */
  requireCp?: number
  /** Initial angular velocity, for testing the self-righting assist. */
  spin?: Vec3
  /** Scenario passes if the car ends the run upright and on its wheels. */
  requireUpright?: boolean
  /** Scenario passes if the car got at least this high. */
  requireHeight?: number
  /** Scenario passes if the car drove upside down on the ceiling slab. */
  requireCeiling?: boolean
}

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
  end: Vec3
}

async function run(s: Scenario): Promise<Result> {
  const world = new RapierWorld()
  const car = new CarSim(0, s.name, world.createVehicle(s.start.pos, s.start.yaw), s.start)
  // Checkpoints only count in lap order, so pretend the car already passed the previous
  // one; otherwise an isolated scenario can never register the checkpoint under test.
  if (s.requireCp !== undefined) car.cp = s.requireCp - 1
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
    end: { x: 0, y: 0, z: 0 }
  }

  const ticks = Math.round(s.seconds * 60)
  for (let tick = 0; tick < ticks; tick++) {
    // Throttle doubles as nose-down pitch in the air, so it is released once airborne —
    // holding it through a jump front-flips the car, which is a player mistake, not a bug.
    const airborne = ![0, 1, 2, 3].some((i) => car.vehicle.wheel(i).contact)
    car.setInput(airborne ? s.bits & ~(InputBit.Throttle | InputBit.Boost) : s.bits)
    for (const e of car.update(TICK_DT, (tick * 1000) / 60, true)) {
      if (e.t === 'cp') r.cps.push(e.cp)
      if (e.t === 'trick') r.tricks.push(e.name)
      if (e.t === 'invert' && e.entered) r.inverted = true
      if (e.t === 'respawn') r.respawns++
    }
    world.step()
    const p = car.vehicle.position()
    const up = quatRotate(car.vehicle.rotation(), UP)
    r.maxY = Math.max(r.maxY, p.y)
    r.minY = Math.min(r.minY, p.y)
    r.maxSpeed = Math.max(r.maxSpeed, vlen(car.vehicle.linvel()))
    if (up.y < -0.5) r.wentUpsideDown = true
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

const THROTTLE = InputBit.Throttle
const BOOST = InputBit.Throttle | InputBit.Boost

const SCENARIOS: Scenario[] = [
  // Jump: approach the launch ramp at a range of speeds. Fast runs must clear the pillars
  // and land on the road beyond; slow runs are expected to fall short.
  ...[18, 22, 26, 30, 34].map((speed) => ({
    name: `jump @ ${speed} m/s`,
    start: approach(JUMP_INDEX, 30),
    speed,
    seconds: 7,
    bits: speed > 28 ? BOOST : THROTTLE,
    requireCp: checkpointAfter(JUMP_INDEX)
  })),
  // Thrusters: the space bar has to beat gravity from a standstill and extend a jump.
  {
    name: 'thrust standstill',
    start: { pos: { ...GRID.pos, y: 0.95 }, yaw: GRID.yaw },
    speed: 0,
    seconds: 2.5,
    bits: InputBit.Thrust,
    requireHeight: 4
  },
  {
    name: 'thrust at speed',
    start: { pos: { ...GRID.pos, y: 0.95 }, yaw: GRID.yaw },
    speed: 20,
    seconds: 2.5,
    bits: InputBit.Thrust | InputBit.Throttle,
    requireHeight: 4
  },
  // Self-righting: thrown into the air spinning, with no input, the car should still be
  // on its wheels by the time it stops.
  {
    name: 'recover roll',
    start: { pos: { ...GRID.pos, y: 6 }, yaw: GRID.yaw },
    speed: 12,
    seconds: 6,
    bits: 0,
    spin: { x: 0, y: 0, z: 5 },
    requireUpright: true
  },
  {
    name: 'recover pitch',
    start: { pos: { ...GRID.pos, y: 6 }, yaw: GRID.yaw },
    speed: 12,
    seconds: 6,
    bits: 0,
    spin: { x: 4, y: 1, z: 0 },
    requireUpright: true
  },
  // Ceiling run: the kicker throws the car into the invert zone, the server half-rolls it
  // and inverted gravity should hold it under the slab all the way to the exit ramp.
  ...[20, 24, 28, 32].map((speed) => ({
    name: `ceiling @ ${speed} m/s`,
    start: approach(KICKER_INDEX, 30),
    speed,
    seconds: 7,
    bits: BOOST,
    // Not a checkpoint: the gate after the zone is round the next corner, and a scenario
    // holding one fixed input cannot steer to it. What is being tested is the slab — wheels
    // in contact while upside down — and that the car comes off it back onto its wheels.
    requireCeiling: true,
    requireUpright: true
  }))
]

async function main(): Promise<void> {
  await initRapier()
  let failures = 0
  let group = ''
  for (const s of SCENARIOS) {
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
      (s.requireCeiling !== true || r.ceilingTicks >= 15)
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
    `\n${SCENARIOS.length - failures}/${SCENARIOS.length} scenarios met their requirement ` +
      `(slow approaches are expected to fall short)`
  )
  console.log(`car: ${CAR.mass} kg, ${CAR.engineForce} N, top ${CAR.maxSpeed}/${CAR.maxSpeedBoost} m/s`)
  console.log(`track: ${TRACK.surfaces.length} surfaces, ${TRACK.obstacles.length} obstacles`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
