/**
 * HUD. Everything shown here comes from the server's snapshots and events; the UI holds
 * no game state of its own beyond the toast timers and which panels are open.
 *
 * The look is the approved mockup in docs/design/ui/mockup/: dark blue glass with a cyan
 * edge and chamfered corners. None of that exists in the renderer — no gradients, no CSS
 * borders, no clip paths — so every frame is a 9-slice PNG from tools/ui/make-ui.py, and
 * flexbox and flat colour do the rest. One accent for state (cyan), green only for the
 * main action, orange only for "you".
 *
 * Each phase owns the screen differently. The lobby is the logo, the setup card down the
 * left (leaving the parked car in view) and the circuit card at the top right. The race is
 * the same top-right card turned into lap, position, checkpoints and time, the standings
 * under it, and the speedometer at the bottom left. The lobby is drawn over the circuit
 * flyover, so its card is opaque glass: it has to read over sky, asphalt and neon alike.
 *
 * Panels are absolutely positioned against the screen edges, in virtual pixels. The
 * virtual screen is never smaller than VIRTUAL_WIDTH x VIRTUAL_HEIGHT in either direction
 * (the renderer fits it inside the canvas and the slack goes to the long side), so the
 * corners these panels are pinned to are always at least that far apart.
 */

import ReactEcs, { Label, ReactEcsRenderer, UiEntity, type UiBackgroundProps } from '@dcl/sdk/react-ecs'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { CHARGE, RACE } from '../../shared/constants'
import { CarFlag, formatTime, type RaceMode, type RacePhase, type Standing, type VoteCount } from '../../shared/protocol'
import { TRACK_IDS, trackById, type TrackId } from '../../shared/tracks'
import { activeTrack } from './active-track'
import { touch } from './input'
import { isMobile } from './platform'
import { getRealm } from '~system/Runtime'

/**
 * What the menu can ask the server to do. `index.ts` fills these in; the UI never
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

/**
 * The screen this HUD is written for.
 *
 * Every size and every font in this file is a pixel of it. `setupUi` hands it to the
 * renderer as the virtual screen, and from there one factor — the fit of this screen
 * inside the real canvas — scales the whole HUD, text included, so a panel takes the
 * same share of a phone, a laptop and a 4K monitor.
 *
 * 16:10 rather than 16:9 on purpose: the renderer rewrites a 16:9 virtual screen to its
 * own 1600x720 on a phone, and the layout below assumes these numbers are the ones
 * actually in force.
 */
const VIRTUAL_WIDTH = 1440
const VIRTUAL_HEIGHT = 900

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
  /** Lobby roster: who would drive if the race started now, and how many of them are ready. */
  pilots: number
  ready: number
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
  /** The setup card is folded away into its tab. */
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
  /** Time left on the controls legend opened from its "?" button mid-race. */
  controlsMs: number
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
  pilots: 0,
  ready: 0,
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
  menuAnim: 1,
  controlsMs: 0
}

// --- Palette ------------------------------------------------------------------------------

function rgb(hex: number, alpha = 1): Color4 {
  return Color4.create(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, alpha)
}

/** Text that is read. */
const INK = rgb(0xf2f7ff)
/** Captions over a value. Light on purpose: grey on dark glass is unreadable outdoors. */
const CAPTION = rgb(0x9fd9f0)
/** Secondary lines: descriptions, units. */
const MUTED = rgb(0xc7d6e6)
/** The one accent, for state. */
const ACCENT = rgb(0x3ad1ff)
/** You, and only you. */
const YOU = rgb(0xf59e0b)
const PINK = rgb(0xff4d6d)
const GOOD = rgb(0x4ade80)
const ON_GREEN = rgb(0x052a12)
const ON_ACCENT = rgb(0x06252b)
const WELL = rgb(0x040c18, 0.7)
const PILL = rgb(0x061224, 0.7)

// --- Frames -------------------------------------------------------------------------------

/**
 * A 9-slice background. `slice` is in texture pixels and the explorer draws the border at
 * that size, which is why the frames are drawn at the size they appear (see make-ui.py).
 * Built once, here: a background is a component write, and these never change.
 */
function nine(src: string, width: number, height: number, slice: number): UiBackgroundProps {
  return {
    texture: { src },
    textureMode: 'nine-slices',
    textureSlices: { top: slice / height, bottom: slice / height, left: slice / width, right: slice / width }
  }
}

function image(src: string): UiBackgroundProps {
  return { texture: { src }, textureMode: 'stretch' }
}

/** Transparent band round the glowing frames; their plain twins carry the same one. */
const FRAME_GLOW = 12
/** The same for the cards and buttons inside the setup card. */
const CARD_GLOW = 8

const BG_LOBBY = nine('images/ui/panel-frame.png', 128, 128, 40)
const BG_CARD = nine('images/ui/panel-frame-tr.png', 128, 128, 40)
const BG_SOFT = nine('images/ui/panel-soft.png', 64, 64, 24)
const BG_TAG = nine('images/ui/panel-tag.png', 64, 64, 16)
const BG_PLAIN = nine('images/ui/panel-plain.png', 32, 32, 11)
const BG_ON = nine('images/ui/card-on.png', 64, 64, 18)
const BG_OFF = nine('images/ui/card-off.png', 64, 64, 18)
const BG_GO = nine('images/ui/button-green.png', 64, 128, 18)
const BG_OUTLINE = nine('images/ui/button-outline.png', 64, 64, 18)
const BG_KEY = nine('images/ui/key-cap.png', 32, 32, 7)
/** Pointed ends that keep their shape however wide the text is: stretched sideways only. */
const BG_TOAST: UiBackgroundProps = {
  texture: { src: 'images/ui/toast-frame.png' },
  textureMode: 'nine-slices',
  textureSlices: { top: 0, bottom: 0, left: 20 / 256, right: 20 / 256 }
}
const BG_SEG_ON = image('images/ui/seg-on.png')
const BG_SEG_OFF = image('images/ui/seg-off.png')
const BG_CHARGE = image('images/ui/charge-fill.png')
const BG_DOT_ON = image('images/ui/dot-on.png')
const BG_DOT_OFF = image('images/ui/dot-off.png')
const BG_LOGO = image('images/ui/logo.png')

const ICON: Record<string, UiBackgroundProps> = {}
for (const name of ['flag', 'mode', 'robot', 'laps', 'person', 'people', 'play', 'eye', 'gas', 'bolt', 'question', 'left', 'right', 'up', 'pedal']) {
  ICON[name] = image(`images/ui/icon-${name}.png`)
}

/**
 * The lobby carousel's face for each circuit. Keyed by plain string so a circuit can be
 * described here before `TrackId` knows it; one without an entry still gets a card, just
 * without a picture.
 */
const TRACK_CARDS: Partial<Record<string, { thumb: string; blurb: string }>> = {
  city: {
    thumb: 'images/ui/thumb-city.png',
    blurb: 'Urban circuit · jump and inverted ceiling'
  },
  skyline: {
    thumb: 'images/ui/thumb-skyline.png',
    blurb: 'Rooftops with gaps · inverted tunnel'
  }
}

/**
 * The map plate of each circuit, rendered by `tools/make-minimap.py`. A circuit without
 * one gets a plain well: the dots are still right, there is just nothing under them.
 */
const MINIMAPS: Partial<Record<TrackId, string>> = {
  city: 'images/minimap.png',
  skyline: 'images/minimap-skyline.png'
}

// --- Layout -------------------------------------------------------------------------------

/** Distance from the screen edges to the panels' visible edges. */
const EDGE = 32
const LOGO_WIDTH = 400

const LOBBY_WIDTH = 480
/** Inside the setup card: the glow band, then the padding that lines the cards up. */
const LOBBY_INNER = LOBBY_WIDTH - 2 * 16
/**
 * The setup card's content height at scale 1, summed from the sections below. Only used to
 * tell whether it fits: when it does not, the card stops at the chat and scrolls.
 */
const LOBBY_CONTENT = 590
const LOBBY_PADDING = 34

const CARD_WIDTH = 472
/** Side of the lobby card's track map, in pixels. */
const MAP_SIZE = 220
const MAP_WELL_WIDTH = 282
/** The racing card and its map: with the standings under it, no more than 300 x 330. */
const RACE_CARD_WIDTH = 300
const RACE_MAP_SIZE = 150

const SPEED_WIDTH = 405
/** km/h at which the speed bar is full: a little over flat out on boost. */
const SPEED_BAR_FULL = 240
const SPEED_SEGMENTS = 12

/**
 * Keeping clear of the explorer's own HUD, which draws over the scene's UI.
 *
 * On desktop the explorer says where it is: `interactableArea` is the margin its rail,
 * scene panel, chat and minimap take from each edge of the canvas, in the canvas's own
 * pixels, so the fit scale alone turns it into ours (`screenLayout`). The panels sit inside
 * that area. On a phone the reported area ignores the touch controls, so it is not used
 * there.
 *
 * The floors below hold when the area comes back empty or short, in virtual pixels. 400
 * across clears the rail and the scene panel (356 explorer pixels) at any UI scale from 0.9
 * to 2, 150 down clears the panel's 120, and 82 up clears the chat field. LOCAL TOOLS sits
 * at the top right in preview only, and is not part of the reported area.
 */
const AREA_MARGIN = 16
const MIN_LEFT = 400
const MIN_TOP = 150
const MIN_BOTTOM = 82
const LOCAL_TOOLS = { width: 150, height: 160 }
/** Below this many explorer pixels across, the setup card takes the whole width and scrolls. */
const NARROW_WIDTH = 900

type Insets = { top: number; left: number; right: number; bottom: number }

type ScreenLayout = {
  /** The canvas in virtual pixels: never less than VIRTUAL_WIDTH x VIRTUAL_HEIGHT. */
  width: number
  height: number
  /** The explorer's HUD margins, in virtual pixels; zero where it reports none. */
  area: Insets
  narrow: boolean
}

/** Whether this is a preview, where the explorer adds LOCAL TOOLS at the top right. */
let preview = false

function screenLayout(): ScreenLayout {
  const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  const deviceWidth = canvas !== null && canvas.width > 0 ? canvas.width : VIRTUAL_WIDTH
  const deviceHeight = canvas !== null && canvas.height > 0 ? canvas.height : VIRTUAL_HEIGHT
  const ratio = canvas !== null && canvas.devicePixelRatio > 0 ? canvas.devicePixelRatio : 1
  const scale = Math.min(deviceWidth / VIRTUAL_WIDTH, deviceHeight / VIRTUAL_HEIGHT)
  const raw = !isMobile() && canvas !== null ? canvas.interactableArea : undefined
  return {
    width: deviceWidth / scale,
    height: deviceHeight / scale,
    area: {
      top: (raw?.top ?? 0) / scale,
      left: (raw?.left ?? 0) / scale,
      right: (raw?.right ?? 0) / scale,
      bottom: (raw?.bottom ?? 0) / scale
    },
    narrow: deviceWidth / ratio < NARROW_WIDTH
  }
}

/** This frame's layout; `Hud` measures it once before drawing anything. */
let screen: ScreenLayout = {
  width: VIRTUAL_WIDTH,
  height: VIRTUAL_HEIGHT,
  area: { top: 0, left: 0, right: 0, bottom: 0 },
  narrow: false
}

/** The edges of the free area, as distances from the screen edges, in virtual pixels. */
function insetLeft(): number {
  return Math.max(MIN_LEFT, screen.area.left + AREA_MARGIN)
}
function insetRight(): number {
  return Math.max(EDGE, screen.area.right + AREA_MARGIN)
}
function insetBottom(): number {
  return Math.max(MIN_BOTTOM, screen.area.bottom + AREA_MARGIN)
}
/** Top of the logo and the LEAVE tag, the topmost things on the left. */
function insetTop(): number {
  return Math.max(14, screen.area.top + 8)
}
/** Top edge of the right-hand column: under LOCAL TOOLS in preview. */
function rightColumnTop(): number {
  return Math.max(preview ? LOCAL_TOOLS.height + 12 : EDGE, screen.area.top + AREA_MARGIN)
}

/**
 * Where the logo goes, or null when there is no room for it: right of the floor, as wide as
 * the space up to the circuit card (or LOCAL TOOLS in preview) allows. Too squeezed to read,
 * it is left out rather than drawn as a smudge.
 */
function logoBox(): { left: number; top: number; width: number } | null {
  const left = insetLeft()
  const rightLimit = screen.narrow
    ? screen.width - insetRight() - (preview ? LOCAL_TOOLS.width : 0)
    : screen.width - insetRight() - CARD_WIDTH - 24
  const width = Math.min(LOGO_WIDTH, rightLimit - left)
  return width < 160 ? null : { left, top: insetTop(), width }
}

/**
 * The setup card's scale. 1 on any normal window; on a narrow one the card spans the
 * width and everything in it grows with it, or its text would be a few pixels high.
 * Set by `LobbyCard` before it draws its sections, which read it through `u`.
 */
let lobbyScale = 1
function u(n: number): number {
  return n * lobbyScale
}

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A name cut to what fits a row; the renderer will not ellipsise for us. */
function short(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}

function myCarId(): number {
  const mine = hud.blips.find((b) => b.mine)
  return mine !== undefined ? mine.id : -1
}

function inRace(): boolean {
  return hud.phase === 'countdown' || hud.phase === 'racing' || hud.phase === 'finished'
}

function Icon(props: { name: string; size: number; key?: string; margin?: number }) {
  return (
    <UiEntity
      uiTransform={{ width: props.size, height: props.size, flexShrink: 0, margin: { right: props.margin ?? 0 } }}
      uiBackground={ICON[props.name]}
    />
  )
}

/** A section heading in the setup card: icon, then the title. */
function Heading(props: { icon: string; title: string; size?: number; children?: unknown }) {
  const size = u(props.size ?? 20)
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: size + u(6),
        flexDirection: 'row',
        alignItems: 'center',
        padding: { left: CARD_GLOW, right: CARD_GLOW },
        margin: { bottom: u(6) }
      }}
    >
      <Icon name={props.icon} size={size} margin={u(10)} />
      <Label value={props.title} fontSize={size} color={INK} textAlign="middle-left" textWrap="nowrap" />
      {props.children}
    </UiEntity>
  )
}

// --- Lobby: logo and setup card -----------------------------------------------------------

/** The logo, in the box `logoBox` finds for it. */
function Logo() {
  if (hud.phase !== 'lobby' && !hud.spectator) return null
  const box = logoBox()
  if (box === null) return null
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: box.left, top: box.top },
        width: box.width,
        height: box.width / 4
      }}
      uiBackground={BG_LOGO}
    />
  )
}

/** The line under the setup card's title: what the room is waiting for. */
function lobbyStatus(): string {
  if (hud.spectator) return 'SPECTATING'
  if (hud.joining) return `DOORS OPEN · ${Math.max(0, Math.ceil(hud.phaseMs / 1000))}`
  if (hud.mode === 'multiplayer') return 'ANYONE CAN START'
  return 'SET UP THE RACE'
}

function voteLine(): string {
  if (TRACK_IDS.every((id) => (hud.votes[id] ?? 0) === 0)) return `NO VOTES · ${trackById(hud.track).name} STAYS`
  return `VOTES · ${TRACK_IDS.map((id) => `${trackById(id).name} ${hud.votes[id] ?? 0}`).join(' · ')} · tie: random draw`
}

/**
 * The circuit carousel, wired straight to the vote: the arrows and the picture each cast
 * it, because a carousel you can browse without voting is a second state the server
 * knows nothing about. It shows your vote, or the room's circuit until you cast one.
 */
function TrackCarousel() {
  const shown: TrackId = hud.myVote ?? hud.track
  const index = Math.max(0, TRACK_IDS.indexOf(shown))
  const count = TRACK_IDS.length
  const track = trackById(shown)
  const face = TRACK_CARDS[shown]
  const km = (track.lapLength / 1000).toFixed(1)
  const voted = hud.myVote === shown
  const arrow = (name: string, step: number) => (
    <UiEntity
      uiTransform={{ width: u(36), height: '100%', justifyContent: 'center', alignItems: 'center', flexShrink: 0 }}
      onMouseDown={() => menu.vote(TRACK_IDS[(index + step + count) % count])}
    >
      <Icon name={name} size={u(26)} />
    </UiEntity>
  )
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', padding: { left: CARD_GLOW, right: CARD_GLOW } }}>
      <UiEntity uiTransform={{ width: '100%', height: u(98), flexDirection: 'row', alignItems: 'center' }}>
        {arrow('left', -1)}
        <UiEntity
          uiTransform={{ flexGrow: 1, height: '100%', margin: { left: u(6), right: u(6) } }}
          uiBackground={face !== undefined ? image(face.thumb) : { color: WELL }}
          onMouseDown={() => menu.vote(shown)}
        >
          <Label
            value={track.name}
            fontSize={u(28)}
            color={INK}
            textAlign="bottom-left"
            textWrap="nowrap"
            uiTransform={{ positionType: 'absolute', position: { left: u(12), bottom: u(26) } }}
          />
          <Label
            value={face !== undefined ? `${face.blurb.replace(' · ', ` · ${km} km · `)}` : `${km} km`}
            fontSize={u(12)}
            color={MUTED}
            textAlign="bottom-left"
            textWrap="nowrap"
            uiTransform={{ positionType: 'absolute', position: { left: u(12), bottom: u(8) } }}
          />
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { right: u(10), top: u(8) },
              padding: { left: u(8), right: u(8), top: u(3), bottom: u(3) }
            }}
            uiBackground={{ color: voted ? ACCENT : rgb(0x040c18, 0.75) }}
          >
            <Label
              value={voted ? 'YOUR VOTE' : 'CLICK TO VOTE'}
              fontSize={u(11)}
              color={voted ? ON_ACCENT : CAPTION}
              textAlign="middle-center"
              textWrap="nowrap"
            />
          </UiEntity>
        </UiEntity>
        {arrow('right', 1)}
      </UiEntity>
      <UiEntity
        uiTransform={{
          width: '100%',
          height: u(20),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: { left: u(42), right: u(42) },
          margin: { top: u(6) }
        }}
      >
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
          {TRACK_IDS.map((id, i) => (
            <UiEntity
              key={id}
              uiTransform={{ width: u(9), height: u(9), margin: { right: u(8) } }}
              uiBackground={i === index ? BG_DOT_ON : BG_DOT_OFF}
            />
          ))}
        </UiEntity>
        <Label value={voteLine()} fontSize={u(12)} color={MUTED} textAlign="middle-right" textWrap="nowrap" />
      </UiEntity>
    </UiEntity>
  )
}

function ModeCard(props: { mode: RaceMode; icon: string; title: string; blurb: string }) {
  const on = hud.mode === props.mode
  return (
    <UiEntity
      uiTransform={{
        width: '50%',
        height: u(72) + 2 * CARD_GLOW,
        flexDirection: 'row',
        alignItems: 'center',
        padding: { left: CARD_GLOW + u(14), right: CARD_GLOW + u(8) }
      }}
      uiBackground={on ? BG_ON : BG_OFF}
      onMouseDown={() => menu.setMode(props.mode)}
    >
      <Icon name={props.icon} size={u(28)} margin={u(12)} />
      <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-start' }}>
        <Label value={props.title} fontSize={u(22)} color={INK} textAlign="middle-left" textWrap="nowrap" />
        <Label value={props.blurb} fontSize={u(12)} color={MUTED} textAlign="middle-left" textWrap="nowrap" />
      </UiEntity>
    </UiEntity>
  )
}

/** A square choice, as the laps. Same frames as the mode cards. */
function Choice(props: { key?: string; label: string; on: boolean; onClick: () => void }) {
  return (
    <UiEntity
      uiTransform={{ flexGrow: 1, flexBasis: 0, height: u(52) + 2 * CARD_GLOW, justifyContent: 'center', alignItems: 'center' }}
      uiBackground={props.on ? BG_ON : BG_OFF}
      onMouseDown={props.onClick}
    >
      <Label value={props.label} fontSize={u(24)} color={INK} textAlign="middle-center" textWrap="nowrap" />
    </UiEntity>
  )
}

function BotsStepper() {
  const step = (label: string, delta: number) => (
    <UiEntity
      uiTransform={{ width: u(50), height: '100%', justifyContent: 'center', alignItems: 'center', flexShrink: 0 }}
      uiBackground={{ color: rgb(0xffffff, 0.06) }}
      onMouseDown={() => menu.setBots(hud.bots + delta)}
    >
      <Label value={label} fontSize={u(24)} color={ACCENT} textAlign="middle-center" />
    </UiEntity>
  )
  return (
    <UiEntity
      uiTransform={{ width: '100%', height: u(52) + 2 * CARD_GLOW, flexDirection: 'row', padding: CARD_GLOW + 2 }}
      uiBackground={BG_OFF}
    >
      {step('−', -1)}
      <UiEntity uiTransform={{ flexGrow: 1, height: '100%', justifyContent: 'center', alignItems: 'center' }}>
        <Label value={String(hud.bots)} fontSize={u(26)} color={INK} textAlign="middle-center" />
      </UiEntity>
      {step('+', 1)}
    </UiEntity>
  )
}

/** The big button at the foot of the card, and the outlined one under it. */
function ActionButton(props: { primary: boolean; enabled?: boolean; icon?: string; label: string; onClick: () => void }) {
  const enabled = props.enabled !== false
  const height = u(props.primary ? 70 : 54) + 2 * CARD_GLOW
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        margin: { top: props.primary ? 0 : u(4) }
      }}
      uiBackground={!enabled ? BG_OFF : props.primary ? BG_GO : BG_OUTLINE}
      onMouseDown={enabled ? props.onClick : undefined}
    >
      {props.icon !== undefined && enabled ? <Icon name={props.icon} size={u(props.primary ? 24 : 22)} margin={u(14)} /> : null}
      <Label
        value={props.label}
        fontSize={u(props.primary ? 32 : 24)}
        color={props.primary && enabled ? ON_GREEN : INK}
        textAlign="middle-center"
        textWrap="nowrap"
      />
    </UiEntity>
  )
}

/**
 * The setup card, down the left so the parked Roadster stays in view.
 *
 * It mirrors the server's room settings rather than holding its own, so two players
 * looking at the same room see the same thing, and it is only drawn when there is a
 * decision to make: between races, or while spectating one. Spectating folds it into a
 * tab; it slides out to the left rather than vanishing, so it is obvious where it went.
 *
 * It keeps clear of the explorer's HUD: right of the rail, under the scene panel, and
 * above the chat field. When that leaves too little height it scrolls; on a narrow window
 * it spans the width and scales up with it (see `lobbyScale`).
 */
function LobbyCard() {
  const inLobby = hud.phase === 'lobby'
  if (!inLobby && !hud.spectator) return null

  // Spectating is a decision to watch, so the card stays out of the way until asked for,
  // however the player got there — the button, a disconnect, or the race starting without
  // them. The flag is the player's; this only makes sure it follows the role.
  if (hud.spectator && !hud.wasSpectator) hud.menuMinimised = true
  hud.wasSpectator = hud.spectator

  const visibleLeft = insetLeft()
  // Under the logo and the explorer's top margin; in preview on a narrow window the card
  // also runs under LOCAL TOOLS.
  const logo = logoBox()
  const top = Math.max(
    MIN_TOP,
    screen.area.top + AREA_MARGIN,
    logo !== null ? logo.top + logo.width / 4 + 12 : 0,
    screen.narrow && preview ? LOCAL_TOOLS.height + 12 : 0
  )
  const width = screen.narrow ? screen.width - visibleLeft - insetRight() : LOBBY_WIDTH
  lobbyScale = width / LOBBY_WIDTH
  const room = screen.height - insetBottom() - top
  const natural = u(LOBBY_CONTENT + LOBBY_PADDING)
  const scrolls = natural > room

  const t = hud.menuAnim
  const ease = t * t * (3 - 2 * t)
  const left = visibleLeft - FRAME_GLOW - (1 - ease) * (width + visibleLeft + 40)
  const showTab = ease < 0.5

  const sections = (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', flexShrink: 0 }}>
      <Heading icon="flag" title="RACE SETUP" size={24}>
        <UiEntity uiTransform={{ flexGrow: 1 }} />
        <Label value={lobbyStatus()} fontSize={u(12)} color={CAPTION} textAlign="middle-right" textWrap="nowrap" />
      </Heading>
      <UiEntity uiTransform={{ width: '100%', height: u(8) }} />
      <TrackCarousel />
      <UiEntity uiTransform={{ width: '100%', height: u(14) }} />

      <Heading icon="mode" title="GAME MODE" />
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row' }}>
        <ModeCard mode="solo" icon="person" title="SOLO" blurb="Against the clock and the bots" />
        <ModeCard mode="multiplayer" icon="people" title="MULTI" blurb="With other drivers" />
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', height: u(10) }} />

      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row' }}>
        <UiEntity uiTransform={{ width: u(LOBBY_INNER * 0.44), flexDirection: 'column' }}>
          <Heading icon="robot" title="BOTS" />
          <BotsStepper />
        </UiEntity>
        <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
          <Heading icon="laps" title="LAPS" />
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'row' }}>
            {[1, 3, 5].map((laps) => (
              <Choice key={String(laps)} label={String(laps)} on={hud.laps === laps} onClick={() => menu.setLaps(laps)} />
            ))}
          </UiEntity>
        </UiEntity>
      </UiEntity>

      <UiEntity uiTransform={{ width: '100%', height: u(18) }} />

      {hud.spectator ? (
        <ActionButton
          primary
          icon="play"
          label="DRIVE"
          onClick={() => {
            menu.setSpectator(false)
            hud.menuMinimised = false
          }}
        />
      ) : (
        <ActionButton
          primary
          icon="play"
          enabled={inLobby && !hud.joining}
          label={hud.joining ? `DOORS OPEN · ${Math.max(0, Math.ceil(hud.phaseMs / 1000))}` : 'START RACE'}
          onClick={() => menu.start()}
        />
      )}
      {hud.spectator ? (
        <ActionButton
          primary={false}
          label="HIDE MENU"
          onClick={() => {
            hud.menuMinimised = true
          }}
        />
      ) : (
        <ActionButton
          primary={false}
          icon="eye"
          label="SPECTATE"
          onClick={() => {
            menu.setSpectator(true)
            hud.menuMinimised = true
          }}
        />
      )}
    </UiEntity>
  )

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%' }}>
      {showTab ? (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: visibleLeft - 2, top: top - 2 },
            height: 44,
            flexDirection: 'row',
            alignItems: 'center',
            padding: { left: 16, right: 20 }
          }}
          uiBackground={BG_TAG}
          onMouseDown={() => {
            hud.menuMinimised = false
          }}
        >
          <Icon name="flag" size={20} margin={10} />
          <Label
            value={hud.spectator ? 'SPECTATING · MENU' : 'MENU'}
            fontSize={16}
            color={ACCENT}
            textAlign="middle-left"
            textWrap="nowrap"
          />
        </UiEntity>
      ) : null}
      {ease > 0.01 ? (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left, top: top - FRAME_GLOW },
            width: width + 2 * FRAME_GLOW,
            height: scrolls ? room + 2 * FRAME_GLOW : 'auto',
            flexDirection: 'column',
            padding: { left: FRAME_GLOW + 16, right: FRAME_GLOW + 16, top: FRAME_GLOW + u(18), bottom: FRAME_GLOW + u(16) }
          }}
          uiBackground={BG_LOBBY}
        >
          {scrolls ? (
            <UiEntity uiTransform={{ width: '100%', flexGrow: 1, flexDirection: 'column', overflow: 'scroll' }}>
              {sections}
            </UiEntity>
          ) : (
            sections
          )}
        </UiEntity>
      ) : null}
    </UiEntity>
  )
}

// --- Top-right card -----------------------------------------------------------------------

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
 * not all twelve. It is cyan, because orange on this map means your car.
 */
function Minimap(props: { size: number; well: number }) {
  const next = hud.nextCheckpoint
  const extent = activeTrack().extent
  const plate = MINIMAPS[hud.track]
  const size = props.size
  // The label sits to the right of the marker, except near the right edge, where it would
  // run off the plate and be clipped.
  const nextLeft = next ? (next.x / extent) * size : 0
  const nextTop = next ? ((extent - next.z) / extent) * size : 0
  const labelOnLeft = nextLeft > size * 0.62
  return (
    <UiEntity
      uiTransform={{ width: props.well, height: size, flexDirection: 'row', justifyContent: 'center' }}
      uiBackground={{ color: WELL }}
    >
      <Label
        value="N"
        fontSize={16}
        color={ACCENT}
        uiTransform={{ positionType: 'absolute', position: { left: 10, top: 6 } }}
      />
      <UiEntity
        uiTransform={{ width: size, height: size }}
        uiBackground={plate !== undefined ? image(plate) : undefined}
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
            uiBackground={{ color: ACCENT }}
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
              <Label value={next.label} fontSize={12} color={ACCENT} textAlign="middle-center" />
            </UiEntity>
          </UiEntity>
        ) : null}
        {hud.blips.map((blip) => {
          const dot = blip.mine ? 11 : 8
          return (
            <UiEntity
              key={blip.id}
              uiTransform={{
                positionType: 'absolute',
                position: {
                  left: (blip.x / extent) * size - dot / 2,
                  top: ((extent - blip.z) / extent) * size - dot / 2
                },
                width: dot,
                height: dot
              }}
              uiBackground={{ color: blip.mine ? YOU : MUTED }}
            />
          )
        })}
      </UiEntity>
    </UiEntity>
  )
}

/** A caption over a big value, with an optional smaller "/ total" after it. */
function Stat(props: { label: string; value: string; suffix?: string; color?: Color4 }) {
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { bottom: 8 } }}>
      <Label value={props.label} fontSize={12} color={CAPTION} textAlign="middle-left" textWrap="nowrap" />
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        <Label value={props.value} fontSize={32} color={props.color ?? INK} textAlign="bottom-left" textWrap="nowrap" />
        {props.suffix !== undefined ? (
          <Label
            value={props.suffix}
            fontSize={19}
            color={CAPTION}
            textAlign="bottom-left"
            textWrap="nowrap"
            uiTransform={{ margin: { left: 4, bottom: 3 } }}
          />
        ) : null}
      </UiEntity>
    </UiEntity>
  )
}

/**
 * The numbers beside the lobby map: the room — who is in, who is ready, how long the door
 * stays open — because a LAP 1/3 before anything has started is a number that means nothing.
 */
function LobbyStats() {
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <Stat label="DRIVERS" value={String(hud.pilots)} />
      <Stat label="READY" value={String(hud.ready)} suffix={`/${hud.pilots}`} />
      <Stat label="DOOR" value={hud.joining ? clock(hud.phaseMs) : '—'} color={hud.joining ? ACCENT : CAPTION} />
    </UiEntity>
  )
}

/** One figure of the race row: a small caption over the value. */
function RaceFigure(props: { label: string; value: string; grow: number; color?: Color4 }) {
  return (
    <UiEntity uiTransform={{ flexGrow: props.grow, flexBasis: 0, flexDirection: 'column', alignItems: 'flex-start' }}>
      <Label value={props.label} fontSize={10} color={CAPTION} textAlign="middle-left" textWrap="nowrap" />
      <Label value={props.value} fontSize={19} color={props.color ?? INK} textAlign="middle-left" textWrap="nowrap" />
    </UiEntity>
  )
}

/**
 * The racing card: the map and one row of figures, and nothing that has to be read twice.
 * Small on purpose — while driving it is glanced at, and every pixel of it is circuit you
 * are not seeing.
 */
function RaceCard() {
  return (
    <UiEntity
      uiTransform={{
        width: RACE_CARD_WIDTH + 2 * FRAME_GLOW,
        flexDirection: 'column',
        padding: { left: FRAME_GLOW + 14, right: FRAME_GLOW + 14, top: FRAME_GLOW + 12, bottom: FRAME_GLOW + 10 }
      }}
      uiBackground={BG_CARD}
    >
      <Minimap size={RACE_MAP_SIZE} well={RACE_CARD_WIDTH - 28} />
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', margin: { top: 8 } }}>
        <RaceFigure label="LAP" value={`${Math.min(hud.lap + 1, hud.laps)}/${hud.laps}`} grow={1} />
        <RaceFigure label="POS" value={`${hud.rank}/${Math.max(hud.drivers, 1)}`} grow={1} />
        <RaceFigure label="CP" value={`${hud.checkpoint}/${hud.checkpoints}`} grow={1.1} />
        <RaceFigure label="TIME" value={formatTime(hud.raceTimeMs)} grow={1.6} color={ACCENT} />
      </UiEntity>
    </UiEntity>
  )
}

/** One row of the standings; yours is the orange one. */
function StandingRow(props: { key?: string; s: Standing; mine: boolean; big: boolean }) {
  const s = props.s
  const size = props.big ? 19 : 13
  // No time gaps on the wire yet, so the race list says what it can: you, a finishing
  // time, or the lap the others are on.
  const right = props.mine && !props.big ? 'YOU' : s.finished ? formatTime(s.totalMs) : `L${s.lap + 1}`
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: size + (props.big ? 14 : 7),
        flexDirection: 'row',
        alignItems: 'center',
        padding: { left: props.big ? 10 : 8, right: 6 }
      }}
      uiBackground={props.mine ? { color: rgb(0xf59e0b, 0.18) } : undefined}
    >
      {props.mine ? (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: 3, height: '100%' }}
          uiBackground={{ color: YOU }}
        />
      ) : null}
      <Label
        value={String(s.rank)}
        fontSize={size}
        color={props.mine ? YOU : CAPTION}
        textAlign="middle-left"
        uiTransform={{ width: props.big ? 30 : 20 }}
      />
      <Label
        value={short(s.name, props.big ? 20 : 16)}
        fontSize={size}
        color={INK}
        textAlign="middle-left"
        textWrap="nowrap"
        uiTransform={{ flexGrow: 1 }}
      />
      {props.big ? (
        <Label value={`${s.score}`} fontSize={size - 3} color={CAPTION} textAlign="middle-right" uiTransform={{ width: 70 }} />
      ) : null}
      <Label
        value={right}
        fontSize={size}
        color={props.mine ? INK : MUTED}
        textAlign="middle-right"
        textWrap="nowrap"
        uiTransform={{ width: props.big ? 110 : 64 }}
      />
    </UiEntity>
  )
}

/** When the race is over the card is the results: bigger, and nothing else beside it. */
function Results() {
  const myId = myCarId()
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center', margin: { bottom: 10 } }}>
        <Label value="RESULTS" fontSize={24} color={INK} textAlign="middle-left" uiTransform={{ flexGrow: 1 }} />
        <Label value="PTS" fontSize={12} color={CAPTION} textAlign="middle-right" uiTransform={{ width: 70 }} />
        <Label value="TIME" fontSize={12} color={CAPTION} textAlign="middle-right" uiTransform={{ width: 118 }} />
      </UiEntity>
      {hud.standings.slice(0, 8).map((s) => (
        <StandingRow key={String(s.id)} s={s} mine={s.id === myId} big />
      ))}
    </UiEntity>
  )
}

function CircuitCard() {
  const finished = hud.phase === 'finished' && hud.standings.length > 0
  if (!finished && hud.phase !== 'lobby') return <RaceCard />
  return (
    <UiEntity
      uiTransform={{
        width: CARD_WIDTH + 2 * FRAME_GLOW,
        flexDirection: 'row',
        padding: { left: FRAME_GLOW + 20, right: FRAME_GLOW + 20, top: FRAME_GLOW + 16, bottom: FRAME_GLOW + 12 }
      }}
      uiBackground={BG_CARD}
    >
      {finished ? (
        <Results />
      ) : (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row' }}>
          <UiEntity uiTransform={{ width: MAP_WELL_WIDTH, flexDirection: 'column', flexShrink: 0 }}>
            <Label
              value={`${trackById(hud.track).name} CIRCUIT`}
              fontSize={24}
              color={INK}
              textAlign="middle-left"
              textWrap="nowrap"
              uiTransform={{ margin: { bottom: 8 } }}
            />
            <Minimap size={MAP_SIZE} well={MAP_WELL_WIDTH} />
          </UiEntity>
          <UiEntity
            uiTransform={{ width: 2, margin: { left: 14 }, flexShrink: 0 }}
            uiBackground={{ color: rgb(0x3ad1ff, 0.35) }}
          />
          <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column', padding: { left: 14, top: 2 } }}>
            <LobbyStats />
          </UiEntity>
        </UiEntity>
      )}
    </UiEntity>
  )
}

/**
 * Standings under the race card: three thin rows, no header. The three that matter while
 * driving are the car ahead, you and the car behind; the leader can wait for the results.
 */
function Standings() {
  if (!inRace() || hud.phase === 'finished' || hud.standings.length === 0) return null
  const myId = myCarId()
  const sorted = hud.standings.slice().sort((a, b) => a.rank - b.rank)
  const me = sorted.findIndex((s) => s.id === myId)
  const first = Math.max(0, Math.min(sorted.length - 3, me - 1))
  return (
    <UiEntity
      uiTransform={{
        width: RACE_CARD_WIDTH + 4,
        flexDirection: 'column',
        padding: { left: 6, right: 8, top: 6, bottom: 6 },
        margin: { right: FRAME_GLOW - 2, top: 2 }
      }}
      uiBackground={BG_SOFT}
    >
      {sorted.slice(first, first + 3).map((s) => (
        <StandingRow key={String(s.id)} s={s} mine={s.id === myId} big={false} />
      ))}
    </UiEntity>
  )
}

function RightColumn() {
  // A narrow lobby is the setup card's, all of it; the room figures can wait.
  if (screen.narrow && hud.phase === 'lobby' && !hud.menuMinimised) return null
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: insetRight() - FRAME_GLOW, top: rightColumnTop() - FRAME_GLOW },
        flexDirection: 'column',
        alignItems: 'flex-end'
      }}
    >
      <CircuitCard />
      <Standings />
    </UiEntity>
  )
}

/**
 * While a race is on, the only thing the setup card still owes a driver is a way out:
 * one small tag at the top left, so the middle of the screen belongs to the circuit.
 */
function LeaveTag() {
  if (hud.spectator || !inRace()) return null
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        // Inside the free area, beside the explorer's scene panel rather than under it.
        position: { left: insetLeft() - 2, top: insetTop() },
        height: 40,
        justifyContent: 'center',
        padding: { left: 16, right: 20 }
      }}
      uiBackground={BG_TAG}
      onMouseDown={() => menu.leaveRace()}
    >
      <Label value="LEAVE RACE" fontSize={14} color={INK} textAlign="middle-center" textWrap="nowrap" />
    </UiEntity>
  )
}

// --- Messages -----------------------------------------------------------------------------

/**
 * Trick, lap and respawn notices, centred at the top. A notice is written as
 * "WHAT  DETAIL" with a double space, and the detail is set in the accent.
 */
function Toast() {
  if (hud.toastMs <= 0 || hud.toast === '') return null
  const split = hud.toast.indexOf('  ')
  const head = split < 0 ? hud.toast : hud.toast.slice(0, split)
  const tail = split < 0 ? '' : hud.toast.slice(split + 2)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: 0, top: EDGE },
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'center'
      }}
    >
      <UiEntity
        uiTransform={{
          height: 56,
          minWidth: 220,
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center',
          padding: { left: 32, right: 32 }
        }}
        uiBackground={BG_TOAST}
      >
        <Label value={head} fontSize={24} color={INK} textAlign="middle-center" textWrap="nowrap" />
        {tail !== '' ? (
          <Label
            value={tail}
            fontSize={24}
            color={ACCENT}
            textAlign="middle-center"
            textWrap="nowrap"
            uiTransform={{ margin: { left: 12 } }}
          />
        ) : null}
      </UiEntity>
    </UiEntity>
  )
}

/** Countdown, GO, finish and podium lines, in the upper middle of the screen. */
function BigMessage() {
  if (hud.bigMessage === '') return null
  const digit = hud.bigMessage.length <= 3
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: 0, top: '28%' },
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'center'
      }}
    >
      <UiEntity
        uiTransform={{
          minWidth: digit ? 160 : 360,
          justifyContent: 'center',
          alignItems: 'center',
          padding: { left: FRAME_GLOW + 36, right: FRAME_GLOW + 36, top: FRAME_GLOW + 10, bottom: FRAME_GLOW + 14 }
        }}
        uiBackground={BG_CARD}
      >
        <Label value={hud.bigMessage} fontSize={digit ? 96 : 48} color={INK} textAlign="middle-center" textWrap="nowrap" />
      </UiEntity>
    </UiEntity>
  )
}

// --- Speedometer --------------------------------------------------------------------------

/**
 * A lamp for the rear boost, in a box of its own beside the speedometer.
 *
 * Three states rather than two, because two could not explain what the player was
 * seeing: lit means the server has the boost engaged, dim means this client is asking
 * for it and the car is not doing it — an empty battery, or the double tap still latched
 * with the throttle held — and dark means nothing is being asked for. The middle state is
 * the one that answers "why does it look like the boost is stuck on".
 *
 * Outside the speed panel, and a fixed size: inside it, the lamp shifted as the speed went
 * from two digits to three, which is movement that means nothing.
 */
function BoostLamp() {
  const on = (hud.flags & CarFlag.Boosting) !== 0
  const asking = hud.boostRequested
  return (
    <UiEntity
      uiTransform={{
        width: 104 + 2 * FRAME_GLOW,
        height: 81 + 2 * FRAME_GLOW,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: FRAME_GLOW
      }}
      uiBackground={BG_CARD}
    >
      <UiEntity
        uiTransform={{ width: 28, height: 28, justifyContent: 'center', alignItems: 'center', margin: { bottom: 6 } }}
        uiBackground={{ color: on ? ACCENT : asking ? rgb(0x3ad1ff, 0.4) : rgb(0xffffff, 0.14) }}
      >
        <Icon name="bolt" size={20} />
      </UiEntity>
      {/* nowrap: given the chance the renderer breaks this one word across two lines, as
          "BOOS" and "T", and the lamp grows. */}
      <Label value="BOOST" fontSize={12} color={on || asking ? INK : CAPTION} textWrap="nowrap" />
    </UiEntity>
  )
}

/** Speed, the speed bar, charge, and the state of the car's two forms of thrust. */
function Speedometer() {
  if (!inRace() || hud.spectator) return null
  const thrusting = (hud.flags & CarFlag.Thrusting) !== 0
  const inverted = (hud.flags & CarFlag.Inverted) !== 0
  const airborne = (hud.flags & CarFlag.Airborne) !== 0
  const lit = Math.round(Math.min(1, hud.speedKmh / SPEED_BAR_FULL) * SPEED_SEGMENTS)
  const charge = Math.max(0, Math.min(1, hud.charge))
  // Below the floor the boost will not fire: the bar says so by dropping the cyan end.
  const empty = hud.charge <= CHARGE.boostFloor
  const note = thrusting
    ? 'THRUSTERS'
    : inverted
      ? 'INVERTED · gravity flipped'
      : airborne
        ? 'SPACE thrusters · E barrel roll'
        : ''
  const segments: ReactEcs.JSX.Element[] = []
  for (let i = 0; i < SPEED_SEGMENTS; i++) {
    segments.push(
      <UiEntity
        key={String(i)}
        uiTransform={{ flexGrow: 1, flexBasis: 0, height: 9, margin: { right: i < SPEED_SEGMENTS - 1 ? 3 : 0 } }}
        uiBackground={i < lit ? BG_SEG_ON : BG_SEG_OFF}
      />
    )
  }
  // Down on the bottom edge. On desktop it starts right of the rail and keeps above
  // whatever the explorer reports at the bottom; on a phone it is centred in the gap
  // between the joystick and the explorer's button cluster.
  const g = gridScale()
  const position = isMobile()
    ? { left: 0, bottom: 8 - FRAME_GLOW }
    : { left: insetLeft() - FRAME_GLOW, bottom: Math.max(12, screen.area.bottom + 12) - FRAME_GLOW }
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position,
        width: isMobile() ? '100%' : 'auto',
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'flex-end',
        padding: isMobile() ? { left: 152 * g, right: (GRID_W - 498) * g } : undefined
      }}
    >
      <UiEntity
        uiTransform={{
          width: SPEED_WIDTH + 2 * FRAME_GLOW,
          flexDirection: 'column',
          padding: { left: FRAME_GLOW + 22, right: FRAME_GLOW + 22, top: FRAME_GLOW + 12, bottom: FRAME_GLOW + 16 }
        }}
        uiBackground={BG_CARD}
      >
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'flex-end', margin: { bottom: 8 } }}>
          <Label
            value={String(Math.round(hud.speedKmh))}
            fontSize={68}
            color={INK}
            textAlign="bottom-left"
            textWrap="nowrap"
          />
          <Label
            value="km/h"
            fontSize={18}
            color={MUTED}
            textAlign="bottom-left"
            textWrap="nowrap"
            uiTransform={{ margin: { left: 10, bottom: 10 } }}
          />
        </UiEntity>
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', margin: { bottom: 12 } }}>{segments}</UiEntity>
        <UiEntity uiTransform={{ width: '100%', height: 20, flexDirection: 'row', alignItems: 'center' }}>
          <Icon name="gas" size={20} margin={10} />
          <UiEntity uiTransform={{ flexGrow: 1, height: 9 }} uiBackground={{ color: rgb(0xffffff, 0.16) }}>
            <UiEntity
              uiTransform={{ width: `${charge * 100}%`, height: '100%' }}
              uiBackground={empty ? { color: PINK } : BG_CHARGE}
            />
          </UiEntity>
          <Label
            value={`CHARGE ${Math.round(charge * 100)}%`}
            fontSize={12}
            color={MUTED}
            textAlign="middle-right"
            textWrap="nowrap"
            uiTransform={{ width: 100 }}
          />
        </UiEntity>
        {note !== '' ? (
          <Label
            value={note}
            fontSize={13}
            color={thrusting ? ACCENT : inverted ? PINK : CAPTION}
            textAlign="middle-left"
            textWrap="nowrap"
            uiTransform={{ margin: { top: 6 } }}
          />
        ) : null}
      </UiEntity>
      <BoostLamp />
    </UiEntity>
  )
}

// --- Bottom right: controls and connection ------------------------------------------------

/**
 * The keyboard, drawn: each key a cap, its action under it.
 *
 * Shown when there is time to read it — the lobby and the countdown — and folded into a
 * "?" while racing, because by then it is the circuit you need to see. The "?" opens it
 * for a few seconds rather than toggling it, so it can never be left open by accident.
 *
 * Two rows of four, and the break is written here rather than left to `flexWrap`: a wrap
 * the renderer decides is a wrap that can come out as a squeezed cap instead.
 *
 * Nothing here is drawn for a touch explorer; `MobileControls` owns that screen.
 */
function ControlsLegend() {
  const cap = (key: string, id: string) => (
    <UiEntity
      key={id}
      uiTransform={{
        height: 32,
        minWidth: 34,
        justifyContent: 'center',
        alignItems: 'center',
        padding: { left: 8, right: 8 },
        margin: { left: 2, right: 2 }
      }}
      uiBackground={BG_KEY}
    >
      <Label value={key} fontSize={15} color={INK} textAlign="middle-center" textWrap="nowrap" />
    </UiEntity>
  )
  const item = (keys: string[], action: string) => (
    <UiEntity key={action} uiTransform={{ width: 96, flexDirection: 'column', alignItems: 'center' }}>
      <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'center', margin: { bottom: 4 } }}>
        {keys.map((k, i) => cap(k, `${k}${i}`))}
      </UiEntity>
      <Label value={action} fontSize={11} color={MUTED} textAlign="middle-center" textWrap="nowrap" />
    </UiEntity>
  )
  const row = (items: ReactEcs.JSX.Element[], key: string) => (
    <UiEntity
      key={key}
      uiTransform={{ flexDirection: 'row', padding: { left: 8, right: 8, top: 10, bottom: 10 }, margin: { bottom: 8 } }}
      uiBackground={BG_PLAIN}
    >
      {items}
    </UiEntity>
  )
  return (
    <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-end' }}>
      {row([item(['W'], 'THROTTLE'), item(['S'], 'BRAKE'), item(['A', 'D'], 'STEER'), item(['W', 'W'], 'BOOST')], 'drive')}
      {row([item(['SHIFT'], 'HANDBRAKE'), item(['SPACE'], 'THRUSTERS'), item(['E'], 'ROLL'), item(['F'], 'RESPAWN')], 'air')}
    </UiEntity>
  )
}

/**
 * The connection, small: a dot and one line. Fixed width and right-aligned, so a ping
 * going from two digits to three does not make the box twitch in the corner of your eye.
 * The longer diagnostics only appear when something is wrong.
 */
function ConnectionPill() {
  const bad = hud.trackMismatch || !hud.connected
  const slow = hud.extrapolationMs > 60 || (hud.fps > 0 && hud.fps < 30)
  const text = hud.trackMismatch
    ? 'SERVER RUNNING A DIFFERENT TRACK BUILD'
    : hud.connected
      ? `ONLINE · ${Math.round(hud.pingMs)} MS · ${Math.round(hud.fps)} FPS${hud.extrapolationMs > 60 ? ` · EXT ${Math.round(hud.extrapolationMs)} MS` : ''}`
      : hud.statusText.toUpperCase()
  return (
    <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-end' }}>
      {hud.spike !== '' ? (
        <Label value={hud.spike} fontSize={11} color={CAPTION} textAlign="middle-right" textWrap="nowrap" />
      ) : null}
      {/* The host is worth a line where you set a race up, or when the connection fails. */}
      {(hud.phase === 'lobby' || bad) && hud.serverHost !== '' ? (
        <Label value={hud.serverHost} fontSize={10} color={CAPTION} textAlign="middle-right" textWrap="nowrap" />
      ) : null}
      <UiEntity
        uiTransform={{
          width: 320,
          height: 26,
          flexDirection: 'row',
          justifyContent: 'flex-end',
          alignItems: 'center',
          padding: { left: 10, right: 10 }
        }}
        uiBackground={{ color: PILL }}
      >
        <UiEntity uiTransform={{ width: 8, height: 8, margin: { right: 8 } }} uiBackground={{ color: bad ? PINK : GOOD }} />
        <Label value={text} fontSize={11} color={bad || slow ? PINK : CAPTION} textAlign="middle-right" textWrap="nowrap" />
      </UiEntity>
    </UiEntity>
  )
}

const CONTROLS_PEEK_MS = 5000

function BottomRight() {
  const mobile = isMobile()
  const folded = hud.phase === 'racing' || hud.phase === 'finished'
  // A narrow lobby has the setup card across the screen, legend or not.
  const crowded = screen.narrow && hud.phase === 'lobby' && !hud.menuMinimised
  const showLegend = !mobile && !crowded && (!folded || hud.controlsMs > 0)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        // On a phone the bottom right is the throttle's; the pill moves up out of its way.
        // On a phone the right edge is the driving buttons'; the pill goes top left, beside
        // LEAVE RACE and clear of the explorer's avatar button.
        position: mobile
          ? { left: insetLeft(), top: insetTop() + 50 }
          : { right: insetRight(), bottom: Math.max(EDGE, screen.area.bottom + AREA_MARGIN) },
        flexDirection: 'column',
        alignItems: 'flex-end'
      }}
    >
      {showLegend ? <ControlsLegend /> : null}
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        <ConnectionPill />
        {folded && !mobile ? (
          <UiEntity
            uiTransform={{ width: 52, height: 52, justifyContent: 'center', alignItems: 'center', margin: { left: 10 } }}
            uiBackground={BG_TAG}
            onMouseDown={() => {
              hud.controlsMs = CONTROLS_PEEK_MS
            }}
          >
            <Icon name="question" size={26} />
          </UiEntity>
        ) : null}
      </UiEntity>
    </UiEntity>
  )
}

// --- Touch --------------------------------------------------------------------------------

/**
 * The phone grid: 667 x 375, an iPhone SE in points, as GolfCraft lays its touch HUD out.
 * The explorer's own buttons are measured on it, and the corners they take stay empty:
 * avatar and chat at the top left (x < 134, y < 52), the joystick at the bottom left
 * (x < 152, y > 252), and E, F, +, hand and jump at the bottom right (x > 498, y > 232).
 *
 * A box is anchored to the nearest edges rather than to a centred grid, because that is
 * how the explorer anchors its buttons: on a phone wider than 16:9 the cluster stays in
 * the corner, and so must the labels that sit beside it.
 */
const GRID_W = 667
const GRID_H = 375

function gridScale(): number {
  return Math.min(screen.width / GRID_W, screen.height / GRID_H)
}

function gridBox(x: number, y: number, w: number, h: number): { left: number; top: number; width: number; height: number } {
  const g = gridScale()
  return {
    left: x < GRID_W / 2 ? x * g : screen.width - (GRID_W - x) * g,
    top: y < GRID_H / 2 ? y * g : screen.height - (GRID_H - y) * g,
    width: w * g,
    height: h * g
  }
}

/**
 * A button that acts as a held key: down on touch, up on release or when the finger slides
 * off it, as GolfCraft's hold buttons do.
 */
function HoldButton(props: {
  key?: string
  box: [number, number, number, number]
  icon: string
  label: string
  held: boolean
  set: (on: boolean) => void
}) {
  const b = gridBox(...props.box)
  const g = gridScale()
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: b.left - CARD_GLOW, top: b.top - CARD_GLOW },
        width: b.width + 2 * CARD_GLOW,
        height: b.height + 2 * CARD_GLOW,
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center'
      }}
      uiBackground={props.held ? BG_ON : BG_OUTLINE}
      onMouseDown={() => props.set(true)}
      onMouseUp={() => props.set(false)}
      onMouseLeave={() => props.set(false)}
    >
      <Icon name={props.icon} size={20 * g} />
      <Label value={props.label} fontSize={9 * g} color={INK} textAlign="middle-center" textWrap="nowrap" />
    </UiEntity>
  )
}

/**
 * A caption beside one of the explorer's own buttons. Their icons are the explorer's and
 * cannot be changed, so what they do in this scene is said next to them, outside the circle.
 */
function NativeTag(props: { key?: string; box: [number, number, number, number]; icon?: string; label: string }) {
  const b = gridBox(...props.box)
  const g = gridScale()
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: b.left, top: b.top },
        width: b.width,
        height: b.height,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center'
      }}
      uiBackground={{ color: rgb(0x061224, 0.8) }}
    >
      {props.icon !== undefined ? <Icon name={props.icon} size={11 * g} margin={3 * g} /> : null}
      <Label value={props.label} fontSize={8 * g} color={INK} textAlign="middle-center" textWrap="nowrap" />
    </UiEntity>
  )
}

/**
 * Driving controls for a touch explorer, while racing.
 *
 * On the left, ours: steer left and right (both together brake, and reverse once stopped)
 * and LIFT for the thrusters above them, clear of the explorer's joystick, which does
 * nothing in a race because the avatar's movement is locked. On the right, the explorer's
 * own buttons do the driving (jump is the throttle, E rolls, F respawns; see `input.ts`)
 * and carry a caption each. BOOST is ours too, above that cluster: the explorer's hand
 * button is IA_POINTER, which every touch on a phone also fires, so it could not be told
 * apart from a thumb on the steering.
 *
 * Nothing here exists outside a race, so nothing here can catch a touch meant for the lobby.
 */
function MobileControls() {
  const shown = isMobile() && !hud.spectator && (hud.phase === 'countdown' || hud.phase === 'racing')
  if (!shown) {
    // A button that disappears under a finger never hears it lift.
    touch.left = touch.right = touch.lift = touch.boost = false
    return null
  }
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%' }}>
      <HoldButton box={[12, 116, 136, 42]} icon="up" label="LIFT" held={touch.lift} set={(on) => { touch.lift = on }} />
      <HoldButton box={[12, 166, 64, 80]} icon="left" label="LEFT" held={touch.left} set={(on) => { touch.left = on }} />
      <HoldButton box={[84, 166, 64, 80]} icon="right" label="RIGHT" held={touch.right} set={(on) => { touch.right = on }} />
      <HoldButton box={[600, 168, 58, 56]} icon="bolt" label="BOOST" held={touch.boost} set={(on) => { touch.boost = on }} />
      <NativeTag box={[528, 225, 64, 15]} label="RESPAWN" />
      <NativeTag box={[456, 285, 50, 16]} label="ROLL" />
      <NativeTag box={[548, 358, 80, 16]} icon="pedal" label="THROTTLE" />
    </UiEntity>
  )
}

function Hud() {
  screen = screenLayout()
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        width: '100%',
        height: '100%',
        // Only the controls should swallow clicks; the rest of the screen stays playable.
        pointerFilter: 'none'
      }}
    >
      <Logo />
      <RightColumn />
      <Speedometer />
      <BottomRight />
      <MobileControls />
      <LeaveTag />
      <LobbyCard />
      <BigMessage />
      <Toast />
    </UiEntity>
  )
}

export function setupUi(): void {
  ReactEcsRenderer.setUiRenderer(Hud, { virtualWidth: VIRTUAL_WIDTH, virtualHeight: VIRTUAL_HEIGHT })
  // Asked once: preview adds LOCAL TOOLS at the top right, and the right column moves under it.
  void getRealm({})
    .then(({ realmInfo }) => {
      preview = realmInfo?.isPreview === true
    })
    .catch(() => {})
  // The "?" legend's timer. The UI's own, so it lives here rather than in the game loop.
  // It also logs what the explorer reports about the canvas whenever that changes (a
  // resize, the chat opening), to check the layout against (see MIN_LEFT).
  let lastTrace = ''
  engine.addSystem((dt: number) => {
    const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
    if (canvas !== null && canvas.width > 0) {
      const area = canvas.interactableArea
      const trace =
        `${canvas.width}x${canvas.height} ratio ${canvas.devicePixelRatio} ` +
        `area t${area?.top ?? 0} l${area?.left ?? 0} r${area?.right ?? 0} b${area?.bottom ?? 0}`
      if (trace !== lastTrace) {
        lastTrace = trace
        const layout = screenLayout()
        console.log(
          `[roadster] ui canvas ${trace} -> virtual ${Math.round(layout.width)}x${Math.round(layout.height)}, ` +
            `scale ${(canvas.width / layout.width).toFixed(3)}, narrow ${layout.narrow}, ` +
            `card left ${Math.round(Math.max(MIN_LEFT, layout.area.left + AREA_MARGIN))}`
        )
      }
    }
    if (hud.controlsMs > 0) hud.controlsMs = Math.max(0, hud.controlsMs - dt * 1000)
  })
}
