/**
 * HUD. Everything shown here comes from the server's snapshots and events; the UI holds
 * no game state of its own beyond the toast timers.
 *
 * The layout is pure flexbox — a top bar, a middle band and a bottom band, each in flow —
 * instead of a set of absolutely positioned panels. Absolute offsets have to be hand-tuned
 * for one window size and start landing on top of each other as soon as the window is short
 * or narrow; in flow the bar pushes the band below it down rather than covering it, and the
 * top bar wraps instead of running off the edge.
 *
 * The HUD also leaves three corners empty, because they are not ours to draw in: the
 * explorer owns the minimap at the top right, its own buttons at the top left and the chat
 * at the bottom left. So the menu is centred at the top, the panels run down the left, the
 * messages sit in the middle, speed is bottom-centre and the connection line bottom-right.
 */

import ReactEcs, { Label, ReactEcsRenderer, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { CHARGE, RACE } from '../../shared/constants'
import { TRACK } from '../../shared/track'
import { CarFlag, formatTime, type RaceMode, type RacePhase, type Standing } from '../../shared/protocol'

/**
 * What the top bar can ask the server to do. `index.ts` fills these in; the UI never
 * talks to the connection directly, and it never changes a setting locally — it asks,
 * and redraws from whatever the next snapshot says the room actually is.
 */
export const menu = {
  setMode: (_mode: RaceMode) => {},
  setBots: (_count: number) => {},
  setLaps: (_laps: number) => {},
  start: () => {},
  leaveRace: () => {}
}

export type HudState = {
  connected: boolean
  statusText: string
  pingMs: number
  /** Netgraph: frames per second, snapshot spacing, and how far the render ran past the
   *  newest snapshot. Together they say whether a stutter is the network or the frame. */
  fps: number
  snapshotGapMs: number
  extrapolationMs: number
  /** The server is running a different build of the circuit than this scene draws. */
  trackMismatch: boolean
  /** Host of the race server this run picked, so it is never a guess which one you are on. */
  serverHost: string
  /** Every car on track, for the minimap. */
  blips: { id: number; x: number; z: number; mine: boolean }[]
  /** Where the next checkpoint is, so the map answers "where do I go now". */
  nextCheckpoint: { x: number; z: number; label: string } | null
  phase: RacePhase
  phaseMs: number
  raceTimeMs: number
  lap: number
  laps: number
  /** Checkpoints passed this lap, out of `checkpoints`. */
  checkpoint: number
  checkpoints: number
  rank: number
  drivers: number
  speedKmh: number
  charge: number
  flags: number
  score: number
  bestLapMs: number
  standings: Standing[]
  /** Transient messages: tricks, lap splits, respawns. */
  toast: string
  toastMs: number
  bigMessage: string
  // --- room settings, mirrored from the server ---
  mode: RaceMode
  bots: number
  autoStart: boolean
}

export const hud: HudState = {
  connected: false,
  statusText: 'connecting to race server…',
  pingMs: 0,
  fps: 0,
  snapshotGapMs: 0,
  extrapolationMs: 0,
  trackMismatch: false,
  serverHost: '',
  blips: [],
  nextCheckpoint: null,
  phase: 'lobby',
  phaseMs: 0,
  raceTimeMs: 0,
  lap: 0,
  laps: RACE.laps,
  checkpoint: 0,
  checkpoints: TRACK.checkpointCount,
  rank: 1,
  drivers: 0,
  speedKmh: 0,
  charge: 0,
  flags: 0,
  score: 0,
  bestLapMs: 0,
  standings: [],
  toast: '',
  toastMs: 0,
  bigMessage: '',
  mode: 'solo',
  bots: 0,
  autoStart: false
}

const PANEL = Color4.create(0, 0, 0, 0.55)
const BAR = Color4.create(0, 0, 0, 0.72)
const ACCENT = Color4.create(0.1, 0.85, 1, 1)
const WARN = Color4.create(1, 0.55, 0.1, 1)

/** Gap above the left column, clearing the explorer's own top-left controls. */
const LEFT_COLUMN_TOP = 26
/** Side of the HUD track map, in pixels. */
const MAP_SIZE = 168
/**
 * Gap above the right column. The explorer draws its own minimap and compass in that
 * corner, so ours starts below it rather than fighting it for the same pixels.
 */
const RIGHT_COLUMN_TOP = 180

function chargeColour(): Color4 {
  if (hud.charge <= CHARGE.boostFloor) return Color4.create(0.8, 0.2, 0.2, 1)
  if ((hud.flags & CarFlag.Thrusting) !== 0) return Color4.create(0.4, 1, 0.6, 1)
  if ((hud.flags & CarFlag.Boosting) !== 0) return Color4.create(1, 0.85, 0.2, 1)
  return ACCENT
}

/** A small clickable chip. Everything in the top bar is built from these. */
function Chip(props: {
  label: string
  active?: boolean
  wide?: boolean
  accent?: Color4
  onClick: () => void
}) {
  const bg = props.active ? (props.accent ?? ACCENT) : Color4.create(1, 1, 1, 0.12)
  return (
    <UiEntity
      uiTransform={{
        width: props.wide === true ? 92 : 46,
        height: 26,
        margin: { left: 3, top: 2, bottom: 2 },
        justifyContent: 'center',
        alignItems: 'center'
      }}
      uiBackground={{ color: bg }}
      onMouseDown={props.onClick}
    >
      <Label
        value={props.label}
        fontSize={13}
        color={props.active === true ? Color4.Black() : Color4.White()}
        textAlign="middle-center"
      />
    </UiEntity>
  )
}

/** A fixed gap between chip groups. */
function Gap() {
  return <UiEntity uiTransform={{ width: 16, height: 1 }} />
}

/**
 * Top bar: pick the race, then start it. Mirrors the server's room settings rather than
 * holding its own, so two players looking at the same room see the same thing. It is
 * centred and wraps, so it never reaches the corners the explorer draws in and never
 * overflows a narrow window.
 */
function TopBar() {
  const inLobby = hud.phase === 'lobby'
  const racing = hud.phase === 'racing' || hud.phase === 'countdown'
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'center',
        margin: { top: 10 }
      }}
    >
      <UiEntity
        uiTransform={{
          maxWidth: '74%',
          height: 'auto',
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          alignContent: 'center',
          justifyContent: 'center',
          padding: { left: 12, right: 12, top: 5, bottom: 5 }
        }}
        uiBackground={{ color: BAR }}
      >
        <Label value="ELON ROADSTER RACE" fontSize={16} color={ACCENT} />

        <Gap />
        <Label value="MODE" fontSize={11} color={Color4.Gray()} />
        <Chip label="SOLO" active={hud.mode === 'solo'} onClick={() => menu.setMode('solo')} />
        <Chip label="MULTI" active={hud.mode === 'multiplayer'} onClick={() => menu.setMode('multiplayer')} />

        <Gap />
        <Label value="BOTS" fontSize={11} color={Color4.Gray()} />
        <Chip label="-" onClick={() => menu.setBots(hud.bots - 1)} />
        <UiEntity uiTransform={{ width: 26, justifyContent: 'center' }}>
          <Label value={String(hud.bots)} fontSize={15} color={Color4.White()} textAlign="middle-center" />
        </UiEntity>
        <Chip label="+" onClick={() => menu.setBots(hud.bots + 1)} />

        <Gap />
        <Label value="LAPS" fontSize={11} color={Color4.Gray()} />
        <Chip label="1" active={hud.laps === 1} onClick={() => menu.setLaps(1)} />
        <Chip label="3" active={hud.laps === 3} onClick={() => menu.setLaps(3)} />
        <Chip label="5" active={hud.laps === 5} onClick={() => menu.setLaps(5)} />

        <Gap />
        {inLobby ? (
          <Chip label="START RACE" wide active accent={Color4.create(0.3, 0.9, 0.4, 1)} onClick={() => menu.start()} />
        ) : null}
        {racing || hud.phase === 'finished' ? (
          <Chip label="LEAVE" wide accent={WARN} active onClick={() => menu.leaveRace()} />
        ) : null}
      </UiEntity>
    </UiEntity>
  )
}

/** Lap, position, checkpoint progress and clock. */
function RacePanel() {
  return (
    <UiEntity uiTransform={{ flexDirection: 'column', padding: 10 }} uiBackground={{ color: PANEL }}>
      <Label value={`LAP ${Math.min(hud.lap + 1, hud.laps)} / ${hud.laps}`} fontSize={20} color={Color4.White()} />
      <Label value={`POS ${hud.rank} / ${Math.max(hud.drivers, 1)}`} fontSize={16} color={Color4.White()} />
      <Label value={`CP ${hud.checkpoint} / ${hud.checkpoints}`} fontSize={15} color={ACCENT} />
      <Label value={formatTime(hud.raceTimeMs)} fontSize={17} color={ACCENT} />
      {hud.bestLapMs > 0 ? (
        <Label value={`best ${formatTime(hud.bestLapMs)}`} fontSize={13} color={Color4.Gray()} />
      ) : null}
      <Label value={`score ${hud.score}`} fontSize={13} color={WARN} />
    </UiEntity>
  )
}

/**
 * Track map: a dot per car, and the checkpoint you are being asked for next.
 *
 * The plate is a flat top-down render of the same track data the colliders come from
 * (`tools/make-minimap.py`), so it cannot drift from the circuit being driven. The dots
 * are positioned children: the image maps the whole parcel block onto the square with no
 * crop and no margin, north up, so a car at world (x, z) is at (x/extent, (extent-z)/extent)
 * of the way across and down. Nothing else about the projection is allowed to change
 * without changing the tool to match.
 *
 * The checkpoint marker is the one piece of the HUD that answers "where now": checkpoints
 * are mandatory and in order, so the useful thing to draw is the next one and its number,
 * not all twelve.
 */
function Minimap() {
  const next = hud.nextCheckpoint
  // The label sits to the right of the marker, except near the right edge, where it would
  // run off the plate and be clipped.
  const nextLeft = next ? (next.x / TRACK.extent) * MAP_SIZE : 0
  const nextTop = next ? ((TRACK.extent - next.z) / TRACK.extent) * MAP_SIZE : 0
  const labelOnLeft = nextLeft > MAP_SIZE * 0.62
  return (
    <UiEntity
      uiTransform={{ width: MAP_SIZE, height: MAP_SIZE, margin: { right: 8 } }}
      uiBackground={{ texture: { src: 'images/minimap.png' }, textureMode: 'stretch' }}
    >
      {next ? (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: nextLeft - 6, top: nextTop - 6 },
            width: 12,
            height: 12,
            justifyContent: 'center',
            alignItems: 'center'
          }}
          uiBackground={{ color: WARN }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: labelOnLeft ? { left: -46, top: -3 } : { left: 15, top: -3 },
              width: 44,
              height: 16,
              justifyContent: labelOnLeft ? 'flex-end' : 'flex-start'
            }}
          >
            <Label value={next.label} fontSize={12} color={WARN} textAlign="middle-center" />
          </UiEntity>
        </UiEntity>
      ) : null}
      {hud.blips.map((blip) => {
        const size = blip.mine ? 9 : 7
        return (
          <UiEntity
            key={blip.id}
            uiTransform={{
              positionType: 'absolute',
              position: {
                left: (blip.x / TRACK.extent) * MAP_SIZE - size / 2,
                top: ((TRACK.extent - blip.z) / TRACK.extent) * MAP_SIZE - size / 2
              },
              width: size,
              height: size
            }}
            uiBackground={{ color: blip.mine ? ACCENT : Color4.create(1, 1, 1, 0.7) }}
          />
        )
      })}
    </UiEntity>
  )
}

/**
 * Standings. They live on the left, under nothing: the race panel and the map moved to
 * the right, below the explorer's own minimap.
 */
function Standings() {
  if (hud.standings.length === 0) return null
  return (
    <UiEntity
      uiTransform={{ flexDirection: 'column', padding: 8, minWidth: 180, margin: { top: 8 } }}
      uiBackground={{ color: PANEL }}
    >
      <Label value="STANDINGS" fontSize={13} color={ACCENT} />
      {hud.standings.slice(0, 6).map((s) => (
        <Label
          key={s.id}
          value={`${s.rank}. ${s.name}  ${s.finished ? formatTime(s.totalMs) : `L${s.lap + 1}`}`}
          fontSize={13}
          color={Color4.White()}
        />
      ))}
    </UiEntity>
  )
}

/**
 * Countdown, podium and the trick/lap toasts. Both stack in one centred column, so a
 * toast arriving during the countdown pushes it down instead of printing over it.
 */
function Messages() {
  return (
    <UiEntity
      uiTransform={{
        flexGrow: 1,
        height: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {hud.bigMessage !== '' ? (
        <UiEntity
          uiTransform={{ width: 420, justifyContent: 'center', padding: 12 }}
          uiBackground={{ color: PANEL }}
        >
          <Label value={hud.bigMessage} fontSize={34} color={Color4.White()} textAlign="middle-center" />
        </UiEntity>
      ) : null}
      {hud.toastMs > 0 ? (
        <UiEntity
          uiTransform={{ width: 320, justifyContent: 'center', padding: 8, margin: { top: 8 } }}
          uiBackground={{ color: Color4.create(0, 0, 0, 0.4) }}
        >
          <Label value={hud.toast} fontSize={21} color={WARN} textAlign="middle-center" />
        </UiEntity>
      ) : null}
    </UiEntity>
  )
}

/** Speed, charge and the state of the car's two forms of thrust. */
function SpeedPanel() {
  const boosting = (hud.flags & CarFlag.Boosting) !== 0
  const thrusting = (hud.flags & CarFlag.Thrusting) !== 0
  const inverted = (hud.flags & CarFlag.Inverted) !== 0
  const airborne = (hud.flags & CarFlag.Airborne) !== 0
  return (
    <UiEntity
      uiTransform={{ width: 330, flexDirection: 'column', alignItems: 'center', padding: 9 }}
      uiBackground={{ color: PANEL }}
    >
      <Label
        value={`${Math.round(hud.speedKmh)} km/h${boosting ? '  BOOST' : ''}`}
        fontSize={26}
        color={boosting ? Color4.create(1, 0.85, 0.2, 1) : Color4.White()}
      />
      {/* Charge bar: an outer track with an inner fill scaled by the battery level. */}
      <UiEntity
        uiTransform={{ width: 292, height: 16, margin: { top: 4 } }}
        uiBackground={{ color: Color4.create(1, 1, 1, 0.15) }}
      >
        <UiEntity
          uiTransform={{ width: `${Math.max(0, Math.min(1, hud.charge)) * 100}%`, height: '100%' }}
          uiBackground={{ color: chargeColour() }}
        />
      </UiEntity>
      <Label value={`CHARGE ${Math.round(hud.charge * 100)}%`} fontSize={12} color={Color4.Gray()} />
      {thrusting ? <Label value="THRUSTERS" fontSize={14} color={ACCENT} /> : null}
      {inverted ? <Label value="INVERTED — gravity flipped" fontSize={14} color={WARN} /> : null}
      {airborne && !inverted && !thrusting ? (
        <Label value="Space thrusters · E barrel roll" fontSize={12} color={Color4.Gray()} />
      ) : null}
    </UiEntity>
  )
}

/** Connection and controls, bottom-right so the explorer's chat keeps the bottom-left. */
function StatusLine() {
  return (
    <UiEntity
      uiTransform={{ flexGrow: 1, flexBasis: 0, flexDirection: 'column', alignItems: 'flex-end' }}
    >
      <Label
        value={
          hud.trackMismatch
            ? 'SERVER RUNNING A DIFFERENT TRACK BUILD'
            : hud.connected
              ? `online  ${Math.round(hud.pingMs)} ms`
              : hud.statusText
        }
        fontSize={12}
        color={hud.trackMismatch ? WARN : hud.connected ? Color4.create(0.5, 0.9, 0.5, 1) : WARN}
        textAlign="middle-right"
      />
      <Label
        value={hud.serverHost}
        fontSize={11}
        color={Color4.Gray()}
        textAlign="middle-right"
      />
      <Label
        value={`${Math.round(hud.fps)} fps · snap ${Math.round(hud.snapshotGapMs)} ms · ext ${Math.round(hud.extrapolationMs)} ms`}
        fontSize={11}
        color={hud.extrapolationMs > 60 || hud.fps < 30 ? WARN : Color4.Gray()}
        textAlign="middle-right"
      />
      <Label value="WASD drive · WW boost · Space thrusters" fontSize={11} color={Color4.Gray()} textAlign="middle-right" />
      <Label value="Shift handbrake · E roll · F respawn" fontSize={11} color={Color4.Gray()} textAlign="middle-right" />
    </UiEntity>
  )
}

function Hud() {
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        justifyContent: 'space-between',
        // Only the chips should swallow clicks; the rest of the screen stays playable.
        pointerFilter: 'none'
      }}
    >
      <TopBar />

      {/* Middle band: panels left, messages centre, and a gutter on the right that is
          deliberately empty — the explorer's minimap lives there. */}
      <UiEntity uiTransform={{ width: '100%', flexGrow: 1, flexDirection: 'row', alignItems: 'flex-start' }}>
        <UiEntity
          uiTransform={{
            width: 'auto',
            flexDirection: 'column',
            margin: { left: 14, top: LEFT_COLUMN_TOP }
          }}
        >
          <Standings />
        </UiEntity>
        <Messages />
        <UiEntity
          uiTransform={{
            width: 'auto',
            flexDirection: 'row',
            alignItems: 'flex-start',
            margin: { right: 14, top: RIGHT_COLUMN_TOP }
          }}
        >
          <Minimap />
          <RacePanel />
        </UiEntity>
      </UiEntity>

      {/* Bottom band: speed centred, status right, bottom-left left to the chat. */}
      <UiEntity
        uiTransform={{
          width: '100%',
          flexDirection: 'row',
          alignItems: 'flex-end',
          padding: { left: 14, right: 14, bottom: 14 }
        }}
      >
        <UiEntity uiTransform={{ flexGrow: 1, flexBasis: 0, height: 1 }} />
        <SpeedPanel />
        <StatusLine />
      </UiEntity>
    </UiEntity>
  )
}

export function setupUi(): void {
  ReactEcsRenderer.setUiRenderer(Hud)
}
