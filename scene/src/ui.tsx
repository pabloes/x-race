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
 * messages sit in the middle, speed is bottom-centre, and the key legend and the
 * connection box share the bottom-right corner.
 */

import ReactEcs, { Label, ReactEcsRenderer, UiEntity } from '@dcl/sdk/react-ecs'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { CHARGE, RACE } from '../../shared/constants'
import { CarFlag, formatTime, type RaceMode, type RacePhase, type Standing, type VoteCount } from '../../shared/protocol'
import { TRACK_IDS, trackById, type TrackId } from '../../shared/tracks'
import { activeTrack } from './active-track'
import { touch } from './input'
import { isMobile } from './platform'

/**
 * What the top bar can ask the server to do. `index.ts` fills these in; the UI never
 * talks to the connection directly, and it never changes a setting locally — it asks,
 * and redraws from whatever the next snapshot says the room actually is.
 */
export const menu = {
  setMode: (_mode: RaceMode) => {},
  setBots: (_count: number) => {},
  setLaps: (_laps: number) => {},
  vote: (_track: TrackId) => {},
  start: () => {},
  leaveRace: () => {},
  setSpectator: (_on: boolean) => {}
}

/** Size the menu is drawn at before scaling: everything inside it is relative to this. */
const MENU_DESIGN_WIDTH = 420
const MENU_DESIGN_HEIGHT = 362
/** The button the menu folds into. */
const TAB_DESIGN_WIDTH = 150
const TAB_DESIGN_HEIGHT = 40

/**
 * The screen this HUD is written for.
 *
 * Every size and every font in this file is a pixel of it. `setupUi` hands it to the
 * renderer as the virtual screen, and from there one factor — the fit of this screen
 * inside the real canvas — scales the whole HUD, text included, so a panel takes the
 * same share of a phone, a laptop and a 4K monitor. Making the HUD bigger or smaller
 * everywhere is a matter of changing these two numbers.
 *
 * 16:10 rather than 16:9 on purpose: the renderer rewrites a 16:9 virtual screen to its
 * own 1600x720 on a phone, and the menu below works its share of the screen out from
 * these numbers, so they have to be the ones actually in force.
 */
const VIRTUAL_WIDTH = 1440
const VIRTUAL_HEIGHT = 900

/**
 * The menu's size, derived from the canvas.
 *
 * `UiCanvasInformation` reports the real canvas in device pixels — 2750 across on a
 * retina laptop where the UI is laid out 1440 wide — so it has to be put back into the
 * virtual pixels everything else here is written in before anything is measured against
 * it. Taking those numbers at face value is what drew this menu at half the width of the
 * screen, hanging off the right edge and clipped at the bottom.
 *
 * The panel is given a share of the screen — a bit over a third of the width, and never
 * so tall that it runs off a short window — and everything inside it is multiplied by
 * `k`, the ratio between that width and the width it was drawn at. The proportions are
 * then fixed by construction rather than by a clamp that happens to look right on one
 * monitor.
 */
function menuMetrics(): { width: number; k: number; canvasWidth: number; canvasHeight: number } {
  const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  const deviceWidth = canvas !== null && canvas.width > 0 ? canvas.width : VIRTUAL_WIDTH
  const deviceHeight = canvas !== null && canvas.height > 0 ? canvas.height : VIRTUAL_HEIGHT
  const scale = Math.min(deviceWidth / VIRTUAL_WIDTH, deviceHeight / VIRTUAL_HEIGHT)
  const canvasWidth = deviceWidth / scale
  const canvasHeight = deviceHeight / scale
  const width = Math.max(300, Math.min(canvasWidth * 0.36, canvasHeight * 0.62))
  return { width, k: width / MENU_DESIGN_WIDTH, canvasWidth, canvasHeight }
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
  /** The circuit the room is on, and the lobby's vote count. */
  track: TrackId
  votes: VoteCount
  /** What this player voted for this lobby, kept locally because the server does not echo it. */
  myVote: TrackId | null
  mode: RaceMode
  bots: number
  /** The join window is open: START is not available yet. */
  joining: boolean
  /** Watching instead of driving. */
  spectator: boolean
  /** The menu is folded away into its button at the top of the screen. */
  menuMinimised: boolean
  /** Previous frame's role, to fold the menu the moment you become a spectator. */
  wasSpectator: boolean
  /**
   * The boost bit this client is sending right now.
   *
   * Not the same thing as the car boosting: the double tap stays latched while the
   * throttle is held, so the request can be alive with an empty battery and nothing
   * happening. Showing both is how a player can tell "I am asking and it will not fire"
   * from "I am not asking".
   */
  boostRequested: boolean
  /** 0 folded, 1 open. Eased every frame so the fold is a movement, not a cut. */
  menuAnim: number
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
  checkpoints: activeTrack().checkpointCount,
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
  track: activeTrack().base,
  votes: {},
  myVote: null,
  mode: 'solo',
  bots: 0,
  joining: false,
  spectator: false,
  menuMinimised: false,
  wasSpectator: false,
  boostRequested: false,
  menuAnim: 1
}

const PANEL = Color4.create(0, 0, 0, 0.55)
const BAR = Color4.create(0, 0, 0, 0.72)
const ACCENT = Color4.create(0.1, 0.85, 1, 1)
const WARN = Color4.create(1, 0.55, 0.1, 1)

/**
 * The map plate of each circuit, rendered by `tools/make-minimap.py`. A circuit without
 * one gets a plain panel: the dots are still right, there is just nothing under them.
 */
const MINIMAPS: Partial<Record<TrackId, string>> = {
  city: 'images/minimap.png'
}

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
  /** For chips built from a list. */
  key?: string
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
        width: (props.wide === true ? 112 : 62) * k,
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
        // A chip's label is one word by definition. Left to wrap, the Bevy client broke
        // MULTI into "MULT" and "I" as soon as the glyphs were a hair wider than the box,
        // and a chip that changes height mid-row drags the whole menu with it.
        textWrap="nowrap"
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
 * rather than along the top edge, and it is sized from the canvas (see `menuMetrics`) so it
 * keeps its proportions on a phone-sized window and on a 4K monitor.
 *
 * It mirrors the server's room settings rather than holding its own, so two players
 * looking at the same room see the same thing, and it is only drawn when there is a
 * decision to make: between races, or while spectating one.
 */
function Menu() {
  const { width, k, canvasWidth, canvasHeight } = menuMetrics()
  const inLobby = hud.phase === 'lobby'
  if (!inLobby && !hud.spectator) return null

  // Where the panel is between folded and open. Smoothstepped, so it leaves and arrives
  // gently instead of sliding at a constant speed.
  // Spectating is a decision to watch, so the menu stays out of the way until asked for,
  // however the player got there — the button, a disconnect, or the race starting without
  // them. The flag is the player's; this only makes sure it follows the role.
  if (hud.spectator && !hud.wasSpectator) hud.menuMinimised = true
  hud.wasSpectator = hud.spectator

  const t = hud.menuAnim
  const ease = t * t * (3 - 2 * t)
  const openWidth = width
  const openHeight = MENU_DESIGN_HEIGHT * k
  const tabWidth = TAB_DESIGN_WIDTH * k
  const tabHeight = TAB_DESIGN_HEIGHT * k
  const boxWidth = tabWidth + (openWidth - tabWidth) * ease
  const boxHeight = tabHeight + (openHeight - tabHeight) * ease
  const topWhenFolded = 12 * k
  const topWhenOpen = Math.max(12 * k, (canvasHeight - openHeight) / 2)
  const top = topWhenFolded + (topWhenOpen - topWhenFolded) * ease
  const left = (canvasWidth - boxWidth) / 2
  // The two faces of the same box. Crossing at the midpoint of the move means neither is
  // ever drawn at a size it was not laid out for.
  const showPanel = ease > 0.55
  const showTab = ease < 0.45

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left, top },
        width: boxWidth,
        height: boxHeight,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: showPanel
          ? { left: 18 * k, right: 18 * k, top: 14 * k, bottom: 16 * k }
          : { left: 0, right: 0, top: 0, bottom: 0 }
      }}
      uiBackground={{ color: BAR }}
      // Only while folded. Pointer events reach the parent too, so an always-on handler
      // here caught the click on SPECTATE as well and reopened the panel in the same
      // frame it was asked to close: the menu looked like it simply ignored the button.
      onMouseDown={showTab ? () => { hud.menuMinimised = false } : undefined}
    >
      {showTab ? (
        <Label
          value={hud.spectator ? 'SPECTATING · MENU' : 'MENU'}
          fontSize={14 * k}
          color={ACCENT}
          textAlign="middle-center"
        />
      ) : null}
      <UiEntity uiTransform={{ display: showPanel ? 'flex' : 'none', width: '100%', height: 'auto', flexDirection: 'column', alignItems: 'center' }}>
        <Label value="ELON ROADSTER RACE" fontSize={22 * k} color={ACCENT} />
        <Label
          value={
            hud.spectator
              ? 'SPECTATING'
              : hud.joining
                ? `DOORS OPEN · ${Math.max(0, Math.ceil(hud.phaseMs / 1000))}`
                : hud.mode === 'multiplayer'
                  ? 'ANYONE CAN START'
                  : 'SET UP THE RACE'
          }
          fontSize={12 * k}
          color={Color4.Gray()}
        />
        <UiEntity uiTransform={{ width: 1, height: 10 * k }} />

        <Row label={`TRACK · NOW ${trackById(hud.track).name}`} scale={k}>
          {TRACK_IDS.map((id) => {
            const count = hud.votes[id] ?? 0
            return (
              <Chip
                key={id}
                label={count > 0 ? `${trackById(id).name} ${count}` : trackById(id).name}
                scale={k}
                wide
                active={hud.myVote === id}
                onClick={() => menu.vote(id)}
              />
            )
          })}
        </Row>

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
              onClick={() => {
                menu.setSpectator(false)
                hud.menuMinimised = false
              }}
            />
          ) : (
            // Wrapped rather than a fragment: the scene's JSX factory builds entities, and
            // an entity is what a row of chips has to be.
            <UiEntity uiTransform={{ width: 'auto', flexDirection: 'row' }}>
              <Chip
                label={hud.joining ? `WAIT ${Math.max(0, Math.ceil(hud.phaseMs / 1000))}s` : 'START RACE'}
                scale={k}
                wide
                active={inLobby && !hud.joining}
                accent={Color4.create(0.3, 0.9, 0.4, 1)}
                onClick={() => menu.start()}
              />
              <Chip
                label="SPECTATE"
                scale={k}
                wide
                onClick={() => {
                  menu.setSpectator(true)
                  hud.menuMinimised = true
                }}
              />
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
      <Label value={trackById(hud.track).name} fontSize={13} color={Color4.Gray()} />
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
  const extent = activeTrack().extent
  const plate = MINIMAPS[hud.track]
  // The label sits to the right of the marker, except near the right edge, where it would
  // run off the plate and be clipped.
  const nextLeft = next ? (next.x / extent) * MAP_SIZE : 0
  const nextTop = next ? ((extent - next.z) / extent) * MAP_SIZE : 0
  const labelOnLeft = nextLeft > MAP_SIZE * 0.62
  return (
    <UiEntity
      uiTransform={{ width: MAP_SIZE, height: MAP_SIZE, margin: { right: 8 } }}
      uiBackground={
        plate !== undefined ? { texture: { src: plate }, textureMode: 'stretch' } : { color: PANEL }
      }
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
                left: (blip.x / extent) * MAP_SIZE - size / 2,
                top: ((extent - blip.z) / extent) * MAP_SIZE - size / 2
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

/**
 * A lamp for the rear boost, in a box of its own beside the speed panel.
 *
 * Three states rather than two, because two could not explain what the player was
 * seeing: lit means the server has the boost engaged, amber means this client is asking
 * for it and the car is not doing it — an empty battery, or the double tap still latched
 * with the throttle held — and dark means nothing is being asked for. The middle state is
 * the one that answers "why does it look like the boost is stuck on".
 *
 * Outside the speed panel, and a fixed width: inside it, the lamp shifted left and right
 * as the speed went from two digits to three, which is movement that means nothing.
 */
function BoostLed() {
  const on = (hud.flags & CarFlag.Boosting) !== 0
  const asking = hud.boostRequested
  const colour = on
    ? Color4.create(1, 0.85, 0.2, 1)
    : asking
      ? Color4.create(0.75, 0.45, 0.05, 1)
      : Color4.create(1, 1, 1, 0.14)
  return (
    <UiEntity
      uiTransform={{
        width: 62,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 6,
        margin: { left: 8 }
      }}
      uiBackground={{ color: PANEL }}
    >
      <UiEntity uiTransform={{ width: 18, height: 18 }} uiBackground={{ color: colour }} />
      {/* nowrap for the same reason the chips have it: given the chance the renderer
          breaks this one word across two lines, as "BOOS" and "T", and the lamp grows. */}
      <Label
        value="BOOST"
        fontSize={11}
        color={on || asking ? Color4.White() : Color4.Gray()}
        textWrap="nowrap"
      />
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
        value={`${Math.round(hud.speedKmh)} km/h`}
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

/**
 * How much to scale the control legend by.
 *
 * Tied to the menu's scale but gentler: the legend is a block of small text along the
 * bottom edge, and growing it as fast as the panel would turn it into a headline.
 */
function hintScale(): number {
  return 1 + (menuMetrics().k - 1) * 0.6
}

/**
 * A box of a size that never changes, for the connection and the netgraph.
 *
 * Every line in here is live: the ping, the frame rate, the snapshot spacing. Drawn as
 * bare labels the column was as wide as whatever it said this frame, so three digits of
 * fps dropping to two moved the text, and a line that only appears while something is
 * being measured moved everything above it. Small movements, constantly, in the corner of
 * your eye while you are driving — which reads as a HUD that will not sit still.
 *
 * So: fixed width, fixed height, stacked from the bottom. The numbers change inside a box
 * that does not, and the warning line is the one the width is chosen for, since it is by
 * some way the longest thing the box can be asked to say.
 */
const STATUS_WIDTH = 272
const STATUS_HEIGHT = 78

function StatusLine() {
  return (
    <UiEntity
      uiTransform={{
        width: STATUS_WIDTH,
        height: STATUS_HEIGHT,
        flexDirection: 'column',
        justifyContent: 'flex-end',
        alignItems: 'flex-end',
        padding: 8
      }}
      uiBackground={{ color: PANEL }}
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
    </UiEntity>
  )
}

/**
 * The keyboard, drawn.
 *
 * It replaces two lines of grey text that sat in the bottom-right corner among the ping
 * and the frame counter, where a legend reads as diagnostics and goes unread. A key is
 * something you press, so it is drawn as a key — a filled cap with the action beside it —
 * and the block is pinned to the right edge, directly above the connection box, where it
 * is out of the way of the circuit but still on the screen rather than in a menu.
 *
 * Two rows of four rather than one row of eight, and the break is written here rather than
 * left to `flexWrap`: eight in a line would reach across the middle of the screen, and a
 * wrap the renderer decides is a wrap that can come out as a squeezed cap instead — the
 * same way a chip label once came out as "MULT" and "I".
 *
 * Nothing here is drawn for a touch explorer; `MobileControls` owns that screen.
 */
function ControlsBar() {
  if (isMobile()) return null
  const k = hintScale()
  const cap = (keys: string, action: string) => (
    <UiEntity
      key={action}
      uiTransform={{
        width: 'auto',
        height: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        margin: { left: 3 * k, right: 3 * k, top: 2 * k, bottom: 2 * k }
      }}
    >
      <UiEntity
        uiTransform={{
          width: 'auto',
          height: 'auto',
          padding: { left: 6 * k, right: 6 * k, top: 2 * k, bottom: 2 * k }
        }}
        uiBackground={{ color: Color4.create(1, 1, 1, 0.18) }}
      >
        <Label value={keys} fontSize={15 * k} color={Color4.White()} textAlign="middle-center" textWrap="nowrap" />
      </UiEntity>
      <Label
        value={action}
        fontSize={13 * k}
        color={Color4.Gray()}
        textAlign="middle-center"
        textWrap="nowrap"
        uiTransform={{ margin: { left: 3 * k } }}
      />
    </UiEntity>
  )
  const row = (caps: ReactEcs.JSX.Element[], key: string) => (
    <UiEntity
      key={key}
      uiTransform={{ width: 'auto', height: 'auto', flexDirection: 'row', justifyContent: 'center' }}
    >
      {caps}
    </UiEntity>
  )
  return (
    <UiEntity
      uiTransform={{
        width: 'auto',
        height: 'auto',
        flexDirection: 'column',
        alignItems: 'center',
        padding: 4 * k,
        margin: { bottom: 6 }
      }}
      uiBackground={{ color: BAR }}
    >
      {row([cap('W', 'THROTTLE'), cap('S', 'BRAKE'), cap('A D', 'STEER'), cap('W W', 'BOOST')], 'drive')}
      {row([cap('SHIFT', 'HANDBRAKE'), cap('SPACE', 'THRUSTERS'), cap('E', 'ROLL'), cap('F', 'RESPAWN')], 'air')}
    </UiEntity>
  )
}

/**
 * Driving controls for a touch explorer.
 *
 * Two jobs, and they are different. The throttle is a button of ours: there is no key to
 * hold, so it feeds `touch.throttle`, and because that goes through the same path as the
 * keyboard the double-tap-for-boost works with a thumb exactly as it does with W — which
 * is why the button says so.
 *
 * The other three are *labels*. The mobile explorer already draws its own round buttons
 * for jump and the two action keys; what it does not know is what they do in this scene,
 * so these sit over them and say. Their positions are percentages of the screen because
 * that is where those buttons are, and if the explorer ever moves them, these two numbers
 * are what needs changing.
 */
function MobileControls() {
  if (!isMobile()) return null
  const k = menuMetrics().k
  const cap = (label: string, bottom: `${number}%`, right: `${number}%`) => (
    <UiEntity
      key={label}
      uiTransform={{
        positionType: 'absolute',
        position: { bottom, right },
        width: 'auto',
        height: 'auto',
        padding: { left: 6 * k, right: 6 * k, top: 2 * k, bottom: 2 * k }
      }}
      uiBackground={{ color: Color4.create(0, 0, 0, 0.55) }}
    >
      <Label value={label} fontSize={12 * k} color={ACCENT} textAlign="middle-center" />
    </UiEntity>
  )
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', height: '100%' }} uiBackground={{ color: Color4.create(0, 0, 0, 0) }}>
      {cap('THRUSTERS', '22%', '6%')}
      {cap('ROLL', '34%', '20%')}
      {cap('RESPAWN', '34%', '6%')}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { bottom: '6%', right: '6%' },
          width: 150 * k,
          height: 76 * k,
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center'
        }}
        uiBackground={{ color: Color4.create(0.1, 0.85, 1, 0.35) }}
        onMouseDown={() => {
          touch.throttle = true
        }}
        onMouseUp={() => {
          touch.throttle = false
        }}
      >
        <Label value="ACCELERATE" fontSize={16 * k} color={Color4.White()} textAlign="middle-center" />
        <Label value="double touch for boost" fontSize={10 * k} color={Color4.White()} textAlign="middle-center" />
      </UiEntity>
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

      <MobileControls />
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
        <UiEntity uiTransform={{ width: 'auto', flexDirection: 'row', alignItems: 'flex-end' }}>
          <SpeedPanel />
          <BoostLed />
        </UiEntity>
        {/* The right-hand column: the keys above, the connection box below, both pinned to
            the edge of the screen. */}
        <UiEntity
          uiTransform={{
            flexGrow: 1,
            flexBasis: 0,
            flexDirection: 'column',
            alignItems: 'flex-end',
            margin: { left: 10 }
          }}
        >
          <ControlsBar />
          <StatusLine />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

export function setupUi(): void {
  ReactEcsRenderer.setUiRenderer(Hud, { virtualWidth: VIRTUAL_WIDTH, virtualHeight: VIRTUAL_HEIGHT })
}
