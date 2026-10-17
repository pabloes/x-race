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
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
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
  leaveRace: () => {},
  setSpectator: (_on: boolean) => {}
}

/** Width the menu is drawn at before scaling: every size inside it is relative to this. */
const MENU_DESIGN_WIDTH = 420

/**
 * The menu's size, derived from the canvas.
 *
 * The UI is laid out in pixels, which on a 4K screen is a postage stamp and in a small
 * window is a wall. So the panel is given a share of the screen — a bit over a third of
 * the width, and never so tall that it runs off a short window — and everything inside it
 * is multiplied by `k`, the ratio between that width and the width it was drawn at. The
 * proportions are then fixed by construction rather than by a clamp that happens to look
 * right on one monitor.
 */
function menuMetrics(): { width: number; k: number } {
  const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  const width = canvas
    ? Math.max(300, Math.min(canvas.width * 0.36, canvas.height * 0.62))
    : MENU_DESIGN_WIDTH
  return { width, k: width / MENU_DESIGN_WIDTH }
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
  /** Measurement line from the cannon spike; empty when it is not running. */
  spike: string
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
  /** Watching instead of driving. */
  spectator: boolean
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
  spike: '',
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
  autoStart: false,
  spectator: false
}

const PANEL = Color4.create(0, 0, 0, 0.55)
const BAR = Color4.create(0, 0, 0, 0.72)
const ACCENT = Color4.create(0.1, 0.85, 1, 1)
const WARN = Color4.create(1, 0.55, 0.1, 1)

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
  scale: number
  active?: boolean
  wide?: boolean
  accent?: Color4
  onClick: () => void
}) {
  const bg = props.active ? (props.accent ?? ACCENT) : Color4.create(1, 1, 1, 0.12)
  const k = props.scale
  return (
    <UiEntity
      uiTransform={{
        width: (props.wide === true ? 104 : 52) * k,
        height: 32 * k,
        margin: { left: 4 * k, right: 4 * k, top: 4 * k, bottom: 4 * k },
        justifyContent: 'center',
        alignItems: 'center'
      }}
      uiBackground={{ color: bg }}
      onMouseDown={props.onClick}
    >
      <Label
        value={props.label}
        fontSize={14 * k}
        color={props.active === true ? Color4.Black() : Color4.White()}
        textAlign="middle-center"
      />
    </UiEntity>
  )
}

/**
 * One setting of the menu: its caption above its controls.
 *
 * Side by side was the obvious layout and it did not survive contact with the renderer:
 * a Label is sized by its own text, not by the box it is given, so the captions ran under
 * the chips at any scale where the text was wider than the column. Stacked, there is
 * nothing to collide with.
 */
function Row(props: { label: string; scale: number; children?: unknown }) {
  const k = props.scale
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: 'auto',
        flexDirection: 'column',
        alignItems: 'center',
        margin: { top: 4 * k, bottom: 2 * k }
      }}
    >
      <Label value={props.label} fontSize={12 * k} color={Color4.Gray()} textAlign="middle-center" />
      <UiEntity
        uiTransform={{ width: '100%', height: 'auto', flexDirection: 'row', justifyContent: 'center' }}
      >
        {props.children}
      </UiEntity>
    </UiEntity>
  )
}

/**
 * The menu, in the middle of the screen.
 *
 * It is the thing you look at between races, so it sits where you are already looking
 * rather than along the top edge, and it is sized from the canvas (see `uiScale`) so it
 * keeps its proportions on a phone-sized window and on a 4K monitor.
 *
 * It mirrors the server's room settings rather than holding its own, so two players
 * looking at the same room see the same thing, and it is only drawn when there is a
 * decision to make: between races, or while spectating one.
 */
function Menu() {
  const { width, k } = menuMetrics()
  const inLobby = hud.phase === 'lobby'
  if (!inLobby && !hud.spectator) return null
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        width: '100%',
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center'
      }}
    >
      <UiEntity
        uiTransform={{
          width,
          height: 'auto',
          flexDirection: 'column',
          alignItems: 'center',
          padding: { left: 18 * k, right: 18 * k, top: 14 * k, bottom: 16 * k }
        }}
        uiBackground={{ color: BAR }}
      >
        <Label value="ELON ROADSTER RACE" fontSize={22 * k} color={ACCENT} />
        <Label
          value={
            hud.spectator
              ? 'SPECTATING'
              : hud.autoStart
                ? 'WAITING FOR DRIVERS'
                : 'SET UP THE RACE'
          }
          fontSize={12 * k}
          color={Color4.Gray()}
        />
        <UiEntity uiTransform={{ width: 1, height: 10 * k }} />

        <Row label="MODE" scale={k}>
          <Chip label="SOLO" scale={k} active={hud.mode === 'solo'} onClick={() => menu.setMode('solo')} />
          <Chip
            label="MULTI"
            scale={k}
            active={hud.mode === 'multiplayer'}
            onClick={() => menu.setMode('multiplayer')}
          />
        </Row>

        <Row label="BOTS" scale={k}>
          <Chip label="-" scale={k} onClick={() => menu.setBots(hud.bots - 1)} />
          <UiEntity uiTransform={{ width: 32 * k, justifyContent: 'center' }}>
            <Label value={String(hud.bots)} fontSize={17 * k} color={Color4.White()} textAlign="middle-center" />
          </UiEntity>
          <Chip label="+" scale={k} onClick={() => menu.setBots(hud.bots + 1)} />
        </Row>

        <Row label="LAPS" scale={k}>
          <Chip label="1" scale={k} active={hud.laps === 1} onClick={() => menu.setLaps(1)} />
          <Chip label="3" scale={k} active={hud.laps === 3} onClick={() => menu.setLaps(3)} />
          <Chip label="5" scale={k} active={hud.laps === 5} onClick={() => menu.setLaps(5)} />
        </Row>

        <UiEntity uiTransform={{ width: 1, height: 8 * k }} />
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
          {hud.spectator ? (
            <Chip
              label="RACE"
              scale={k}
              wide
              active
              accent={Color4.create(0.3, 0.9, 0.4, 1)}
              onClick={() => menu.setSpectator(false)}
            />
          ) : (
            // Wrapped rather than a fragment: the scene's JSX factory builds entities, and
            // an entity is what a row of chips has to be.
            <UiEntity uiTransform={{ width: 'auto', flexDirection: 'row' }}>
              <Chip
                label="START RACE"
                scale={k}
                wide
                active={inLobby}
                accent={Color4.create(0.3, 0.9, 0.4, 1)}
                onClick={() => menu.start()}
              />
              <Chip label="SPECTATE" scale={k} wide onClick={() => menu.setSpectator(true)} />
            </UiEntity>
          )}
        </UiEntity>
        {hud.spectator ? (
          <Label
            value="walk around with your avatar while the race runs"
            fontSize={11 * k}
            color={Color4.Gray()}
          />
        ) : null}
      </UiEntity>
    </UiEntity>
  )
}

/**
 * While a race is on, the only thing the menu still owes you is a way out. One chip at
 * the top, so the middle of the screen belongs to the circuit.
 */
function RaceBar() {
  const { k } = menuMetrics()
  if (hud.spectator || hud.phase === 'lobby') return null
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { top: 10 } }}>
      <Chip label="LEAVE RACE" scale={k} wide accent={WARN} active onClick={() => menu.leaveRace()} />
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

/** Standings, under the race panel and the map in the right-hand column. */
function Standings() {
  if (hud.standings.length === 0) return null
  return (
    <UiEntity
      uiTransform={{ flexDirection: 'column', padding: 8, minWidth: 190, margin: { top: 8 } }}
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
      {hud.spike !== '' ? (
        <Label value={hud.spike} fontSize={12} color={Color4.create(1, 0.8, 0.3, 1)} textAlign="middle-right" />
      ) : null}
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
      <RaceBar />

      {/* Middle band: panels left, messages centre, and a gutter on the right that is
          deliberately empty — the explorer's minimap lives there. */}
      <UiEntity uiTransform={{ width: '100%', flexGrow: 1, flexDirection: 'row', alignItems: 'flex-start' }}>
        <Messages />
        {/* Everything that is read rather than watched lives in one column on the right,
            below the explorer's own minimap: lap and position, the track map beside them,
            and the standings under both. */}
        <UiEntity
          uiTransform={{
            width: 'auto',
            flexDirection: 'column',
            alignItems: 'flex-end',
            margin: { right: 14, top: RIGHT_COLUMN_TOP }
          }}
        >
          <UiEntity uiTransform={{ width: 'auto', flexDirection: 'row', alignItems: 'flex-start' }}>
            <Minimap />
            <RacePanel />
          </UiEntity>
          <Standings />
        </UiEntity>
      </UiEntity>

      <Menu />

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
