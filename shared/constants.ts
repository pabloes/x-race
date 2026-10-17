/**
 * Simulation, networking and vehicle constants.
 *
 * This file is imported by both the authoritative server (Node + Rapier) and the
 * Decentraland scene, so every number here is part of the contract between them.
 */

// --- Fixed timestep ---

/** Authoritative simulation rate. The server never advances physics with a variable dt. */
export const TICK_RATE = 60
export const TICK_DT = 1 / TICK_RATE
export const TICK_MS = 1000 / TICK_RATE

/**
 * How often the server serialises the world and broadcasts it.
 *
 * Raised from 20 Hz once the input latency was measured end to end: waiting for the next
 * snapshot was 25 ms of the budget on average, and a third more packets of about 40 bytes
 * per car is the cheapest 8 ms on the list.
 */
export const SNAPSHOT_RATE = 30
export const TICKS_PER_SNAPSHOT = TICK_RATE / SNAPSHOT_RATE
export const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE

// --- Client-side buffering ---

/**
 * The client renders this far behind the newest snapshot it holds, so it is always
 * interpolating between two known states instead of guessing. Must be > SNAPSHOT_MS
 * plus the expected jitter.
 */
export const INTERPOLATION_DELAY_MS = 100
/**
 * Your own car is rendered much closer to the present than everyone else's.
 *
 * Remote cars need the full delay: there is nothing to do about their latency but hold
 * two snapshots and interpolate. Your car is different — you are the one pressing the
 * key, so the delay is felt directly as sluggish steering. At 40 ms the buffer is
 * extrapolating a little more often, which costs a touch of smoothness on your own car
 * and buys back 80 ms of response.
 *
 * This is not client-side prediction. Predicting properly means running the same vehicle
 * physics locally and reconciling, and the scene runtime is QuickJS with no WebAssembly,
 * so Rapier cannot run there at all. What is left is to stop rendering your own car
 * further in the past than necessary.
 *
 * 25 ms rather than 40 now that the dead reckoning continues the car's rotation as well as
 * its position: the stutter that made a short delay expensive is gone, so the delay can
 * come down. Watch `ext` in the HUD — it is how far past the newest snapshot the render
 * ran, and if it sits above a snapshot interval this is too low.
 */
export const LOCAL_INTERPOLATION_DELAY_MS = 25
/** When snapshots stop arriving, the client dead-reckons at most this long before freezing. */
export const MAX_EXTRAPOLATION_MS = 250
/** Snapshots older than this are dropped from the jitter buffer. */
export const SNAPSHOT_BUFFER_MS = 1000

// --- Input channel ---

/** Client input send rate. Higher than the snapshot rate: inputs are tiny and latency-critical. */
export const INPUT_RATE = 60
export const INPUT_MS = 1000 / INPUT_RATE
/** Each packet repeats the last N inputs so a single lost packet never starves the sim. */
export const INPUT_REDUNDANCY = 3
/**
 * Fixed cushion added to half the round trip when stamping an input with the tick it is
 * meant for. It only has to cover network jitter; every millisecond here is a millisecond
 * of input delay, so it is kept tight and the redundancy above covers the odd late packet.
 */
export const INPUT_LEAD_CUSHION_MS = 8
/** Inputs that arrive more than this late are discarded (the server already moved on). */
export const MAX_INPUT_LAG_TICKS = 20
/** How long the server keeps reusing the last known input before treating the car as idle. */
export const INPUT_STARVE_TICKS = 30

// --- World ---

/**
 * Arcade gravity: heavier than real life so jumps land fast and the loop stays tight.
 * The track's jump distances and loop height are tuned against this value and the
 * speeds below, so changing one means re-checking the other.
 */
export const GRAVITY = -16

// --- Vehicle (Roadster-ish, tuned for arcade feel rather than realism) ---

export const CAR = {
  mass: 1200,
  /** Half-extents of the chassis collider. Car is 1.9 x 0.7 x 4.4 m. */
  halfExtents: { x: 0.95, y: 0.35, z: 2.2 },
  /** Chassis centre of mass offset, lowered to resist rolling over. */
  comOffset: { x: 0, y: -0.25, z: 0 },
  /**
   * Principal angular inertia. Roll (z) is kept low-ish for responsive barrel rolls while
   * pitch (x) stays high for stability under downforce.
   *
   * Yaw (y) came down from 2200 because it is felt directly: it is the resistance between
   * pressing a key and the car starting to come round. Measured, 2200 took 83 ms to reach
   * ninety per cent of the car's steady rate of turn and 1200 takes 50 ms, with the same
   * steady rate at the end of it. 1500 keeps most of that (50 ms) while leaving the car
   * settled enough for the bots, whose steering is two keys and no counter-steer.
   */
  inertia: { x: 1800, y: 1500, z: 900 },

  wheelRadius: 0.35,
  /** Wheel anchor points in chassis space. Order: FL, FR, RL, RR. */
  wheelAnchors: [
    { x: -0.85, y: -0.2, z: 1.5 },
    { x: 0.85, y: -0.2, z: 1.5 },
    { x: -0.85, y: -0.2, z: -1.5 },
    { x: 0.85, y: -0.2, z: -1.5 }
  ],
  suspensionRestLength: 0.35,
  suspensionStiffness: 60,
  /**
   * Damping is expressed per unit mass like the stiffness, so critical damping is
   * 2*sqrt(stiffness) = 15.5. These sit at roughly 0.37 and 0.2 of critical: enough to stop
   * the car pogoing, loose enough to keep the suspension lively over the jumps.
   */
  suspensionCompression: 5.6,
  suspensionRelaxation: 3.1,
  /**
   * Generous travel on purpose. A tight limit (0.18 was the first attempt) pegs the
   * spring against its stop on every bump and the controller then injects energy on each
   * tick, which launches the car off flat road and eventually stops it dead.
   */
  suspensionMaxTravel: 0.5,
  maxSuspensionForce: 60000,
  frictionSlip: 2.2,
  /**
   * Lateral tyre stiffness, and the single number that decides whether this car drifts.
   *
   * The raycast vehicle's side friction is enormous by default: at 0.9 the tyres hold
   * nearly 3 g sideways, the velocity snaps to wherever the chassis points, and no amount
   * of yaw assist produces a slide — measured, the slip angle through a full-lock corner
   * at 30 m/s was 1.9°. Lowering it is the only thing that makes the car move under you.
   *
   * 0.3 is where it was left, and it was chosen by driving the circuit, not by taste: the
   * corner that read 1.9° now reaches 7°, and the bots' best lap *improved* from 67 s to
   * 60.5 s because a car that rotates into a corner gets out of it pointing the right way.
   * Below that it collapses — at 0.25 two of four cars could not finish a lap in 150 s and
   * respawned 25 times — because a slide the driver cannot gather up is just a crash with
   * extra steps. Longitudinal grip is untouched, so braking from top speed is 25 m either
   * way.
   */
  sideFrictionStiffness: 0.3,

  /** Total engine force at full throttle, split across the four wheels (AWD). */
  engineForce: 22000,
  /** Reverse is deliberately weaker. */
  reverseForce: 9000,
  brakeForce: 90,
  handbrakeForce: 160,
  /** Rear wheels lose grip under handbrake so the car can drift through corners. */
  handbrakeFrictionSlip: 0.6,
  /**
   * Once the car is past this slip angle (radians) with the throttle in, the rear tyres
   * are let go to `driftRearGrip` and the slide sustains itself instead of snapping
   * straight. 0.1 rad is about 6°, which is roughly where a slide starts to look like one.
   */
  driftSlipAngle: 0.12,
  driftRearGrip: 1.2,

  /**
   * Top speed. Raised with the circuit: a 1.5 km lap at the old 22 m/s was a hundred
   * seconds of holding the throttle down. The corners are 26 to 54 m in radius, so most of
   * them cannot be taken flat — braking for the slow ones is the point.
   */
  maxSpeed: 30,
  maxSpeedBoost: 40,
  maxReverseSpeed: 9,

  /**
   * Steering angle at standstill and at top speed (radians), interpolated by speed.
   * The high-speed figure gives a ~17 m turning circle, comfortably inside the 26 m
   * corner radius: enough to make the corner without the twitchiness of a tighter lock.
   */
  maxSteerLowSpeed: 0.5,
  maxSteerHighSpeed: 0.2,
  /**
   * Steering follows the input through a first-order filter at this rate (1/s).
   *
   * Measured, not guessed: at 9 the car took 83 ms to reach half its steady rate of turn
   * and 133 ms to reach ninety per cent of it, *before* a single millisecond of network.
   * That is most of what "it turns late" was. At 24 the same figures are 33 ms and 83 ms,
   * and the steady rate is unchanged — the filter was costing response, not holding the
   * car down. Past 24 nothing improves: the limit becomes the chassis' own inertia.
   */
  steerRate: 24,

  /**
   * Aerodynamic downforce along the chassis' local -up, applied only while a wheel is
   * touching something: force = downforce * speed^2, so ~0.5 g at boost speed.
   *
   * Kept deliberately mild. The first attempt (72, i.e. 3.8 g flat out) squashed the
   * suspension past its travel limit, dragged the chassis along the road and brought the
   * car to a halt. The loop does not need it either — centripetal acceleration alone
   * holds the car at the apex above ~10 m/s — and the ceiling run is held by inverted
   * gravity, so this is only here for high-speed grip.
   */
  downforce: 9,
  /** Extra linear damping while airborne so the car does not float forever. */
  airDrag: 0.05,
  /** Angular damping while grounded, to settle wobble after a landing. */
  angularDamping: 3.2,

  /**
   * Grip assist: the fraction of sideways velocity cancelled per second while the wheels
   * are loaded and the handbrake is off.
   *
   * This is what makes the car arcade rather than simulation. A raycast vehicle with
   * realistic tyre slip understeers off the road the moment you turn in at speed, and the
   * player's answer has to be to lift and wait — fine in a sim, wrong here. Bleeding the
   * lateral component of the velocity makes the car go roughly where it is pointed, which
   * is what an arcade racer feels like. It is suppressed under handbrake, so a deliberate
   * slide is still available, and cut right down off the asphalt, which is what makes
   * running wide cost something.
   */
  gripAssist: 3.2,
  /**
   * Ceiling on what the grip assist can do, in m/s².
   *
   * Without it the assist is a rail: whatever sideways speed the car has is simply taken
   * away, and the car can never step out. With it, the assist handles the first couple of
   * m/s of slip — ordinary cornering still goes where you point — and a hard turn-in at
   * speed asks for more than it can give, so the back steps out and the car drifts. As the
   * slide bleeds off, the assist catches up and gathers it back up on its own, which is
   * what makes a drift in an arcade racer feel good rather than like a spin.
   */
  gripAssistMaxAccel: 5,
  /**
   * Yaw-rate steering: how fast the car turns at full lock, in rad/s, reached over the
   * first 12 m/s. Applied about the chassis' own up axis, so it keeps working upside down
   * on the ceiling, where the world up is the wrong way round.
   *
   * Tyres negotiate a rate of turn; an arcade car is given one. At 1.4 rad/s and 30 m/s
   * the car is asking to pivot on a 21 m radius, far tighter than the tyres could carry,
   * and it rotates anyway. The velocity cannot follow, because the grip assist above is
   * capped, and the gap between where the car points and where it is going is the drift.
   * The handbrake raises the asked-for rate, which is how you provoke one on purpose.
   *
   * `yawGain` is the proportional term on the rate error and `yawTorqueMax` its ceiling,
   * so the wild angular velocity that follows a bad landing cannot be amplified into a
   * pirouette.
   */
  yawRate: 1.8,
  yawRateHandbrake: 1.45,
  yawGain: 20000,
  yawTorqueMax: 24000,
  /** Torque used to steer/rotate the car mid-air (arcade air control). */
  airControlTorque: 6500,

  /**
   * Off the asphalt: gravel. Drag is a rate (1/s) against the velocity, so it costs more
   * the faster you are going — about 7 m/s² at top speed, 2 at a crawl — and the engine
   * can only answer with half its force, so cutting a corner across the grass is slower
   * than going round it. Grip drops too: the car slides, which is the feedback that tells
   * you where you are without looking down.
   */
  gravelDrag: 0.3,
  gravelEngine: 0.35,
  gravelGrip: 0.35,
  /**
   * Top speed on gravel, and how hard the car is slowed down to it.
   *
   * Arriving off the asphalt at racing speed should cost the corner, not just a little
   * time: `gravelBrakeAccel` is applied against the velocity while the car is above
   * `gravelMaxSpeed`, which from a flat-out 30 m/s is about a second and a half of being
   * dragged down to a crawl. From a standstill the car can still pull itself out — the
   * engine is cut to `gravelEngine`, not to zero — but it tops out at a third of its
   * road speed, so the way back to the race is to get back on the asphalt.
   */
  gravelMaxSpeed: 12,
  gravelBrakeAccel: 13,

  /**
   * Landing assist: a retro burn from the belly nozzles on the way down.
   *
   * Below `landingFallSpeed` nothing happens — a hop over a kerb lands the way physics
   * says. Past it the car levels itself hard and bleeds vertical speed toward
   * `landingTouchdownSpeed`, so a big jump ends on four wheels rather than on the roof.
   * It is not a physics bypass: the car is still a rigid body in the same world, still
   * collides with everything, and `landingBrakeAccel` is a finite thrust, not a teleport.
   * Suppressed during tricks and the inverted run, where the player asked for the
   * orientation they have.
   */
  landingFallSpeed: 6,
  landingTouchdownSpeed: 6,
  landingBrakeAccel: 16,
  landingLevelTorque: 24000,

  /**
   * Self-righting assist. With no air input the car is rotated back toward upright, so a
   * bad launch does not mean a guaranteed roof landing. It is suppressed while the player
   * is steering in the air, during a scripted trick, and during the inverted ceiling run,
   * where being upside down is the whole point.
   */
  selfRightTorque: 14000,
  selfRightDamping: 2600,

  /**
   * Cold-gas thrusters, on the space bar: a straight push along world up. Named after the
   * SpaceX package the real Roadster is supposed to carry.
   *
   * Gravity is switched off for the chassis while they fire, so this force is the whole
   * acceleration rather than a margin over the car's weight: 42000 N meant 35 m/s² and the
   * car went up like a firework. 13000 is a brisk 11 m/s², which lifts it off the road
   * without losing sight of it.
   */
  thrusterForce: 13000,
  /** Sideways/forward bleed while thrusting, so hovering does not feel frictionless. */
  thrusterDrag: 0.3,
  /**
   * Levelling torque while the thrusters fire. Far stronger than the passive assist:
   * holding space is meant to be a guaranteed recovery, not a suggestion.
   */
  thrusterLevelTorque: 42000
} as const

// --- Charge bar (battery) ---

export const CHARGE = {
  /** Bar is 0..1. You start with almost nothing and earn the rest by driving. */
  initial: 0.1,
  /** Regen per second while coasting or braking (regenerative braking). */
  regenPerSecond: 0.02,
  /** Regen per second while braking hard. */
  regenBrakingPerSecond: 0.06,
  /**
   * Regen per second at full drift angle, scaled down to nothing as the car straightens.
   *
   * This is where the charge actually comes from. Coasting pays a trickle, so a lap driven
   * straight and tidy never fills the bar: the thrusters and the boost are paid for with
   * the thing that costs time, which is sliding the car about and throwing it off ramps.
   */
  driftRegenPerSecond: 0.45,
  /** Drain per second while boosting. */
  drainPerSecond: 0.42,
  /**
   * Drain per second while the thrusters are firing. Costlier than boost, but not so
   * costly that the 10% you start with is gone in a twentieth of a second, which is what
   * 0.55 meant once the bar started nearly empty: the thrusters simply did not fire.
   */
  thrusterDrainPerSecond: 0.35,
  /** Minimum charge needed to start a boost (prevents stuttering at ~0). */
  boostFloor: 0.08,
  /** Reward for a clean landing after an airborne trick. */
  trickReward: 0.2,
  /** Reward per obstacle cleared in the air. */
  obstacleReward: 0.05,
  /** Reward for completing the inverted ceiling run. */
  invertReward: 0.3,
  /** Instant charge from driving over a boost pad. */
  padReward: 0.25,
  /** Boost multiplies engine force by this. */
  boostForceMultiplier: 1.9
} as const

// --- Tricks ---

export const TRICK = {
  /** Airborne time needed before a rotation counts as a trick. */
  minAirTimeMs: 350,
  /** Airborne time before mid-air steering engages, so bumps cannot be torqued. */
  minAirControlMs: 150,
  /** A second tap of the throttle within this window arms the speed boost. */
  doubleTapMs: 320,
  /** Degrees of accumulated roll/flip that count as one full rotation. */
  rotationDegrees: 360,
  /** Landing within this angle of upright counts as clean. */
  cleanLandingDegrees: 50,
  /** Car is considered stuck/flipped after this long upside down on the ground. */
  flippedResetMs: 2500,
  /** Respawn after this long wedged against geometry with power applied. */
  stuckResetMs: 3000
} as const

// --- Race ---

export const RACE = {
  laps: 3,
  /**
   * Racers needed before the shared room starts a race on its own.
   *
   * Two, not one: with one it started the moment a single driver walked in — the client
   * marks itself ready on connect, so "everyone is ready" was true immediately and the
   * countdown ran without anyone asking for it. A multiplayer lobby waiting for nobody is
   * just a solo race in the wrong room, and solo has its own room now. One player can
   * still race here, they just have to press START.
   */
  minPlayers: 2,
  /** Lobby wait before auto-starting once minPlayers is met. */
  lobbyMs: 15000,
  countdownMs: 4000,
  /** Grace period after the winner finishes before the race is force-ended. */
  finishGraceMs: 20000,
  /**
   * Hard ceiling on a race, whether or not anyone finishes.
   *
   * The grace period above only starts counting when somebody crosses the line, so a race
   * where nobody does has no end at all. There is one room, so a race that never ends is
   * a room nobody else can get into. Six minutes is about twice a careful three-lap run.
   */
  maxRaceMs: 360000,
  /** Podium screen duration before returning to the lobby. */
  podiumMs: 10000,
  /** A car that falls below this Y is respawned at its last checkpoint. */
  killY: -8,
  respawnDelayMs: 1200,
  maxPlayers: 8
} as const

export const NET = {
  defaultPort: 8787,
  /** Server pings idle sockets to detect half-open connections. */
  heartbeatMs: 5000,
  clientTimeoutMs: 15000,
  protocolVersion: 1
} as const
