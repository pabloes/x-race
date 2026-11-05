*Work in progress · grown from `gdd-template.md`*
*Revised 2026-11-05 against the repo on branch `dev` and Pablo's decisions: IP declaration, contact, `xrace.dcl.eth` as the only World, the round ladder (V0 demo race, V1 ranked with wearables and experimental ball mode), V0 weeks, V1 hook numbers, story and test phone.*

# ELON RACE

**Decentraland Creator Success Program**

| | |
|---|---|
| Public experience title | ELON RACE — IP & [Content Policy](https://decentraland.org/content/) status: owner declaration: ELON is a person's first name, not a trademark, so we expect no conflict; we use a model car inspired by the Tesla Roadster, but Tesla is not mentioned in the game |
| Deployment target | World `xrace.dcl.eth` |
| Studio / team name | ZEROxWORK.com |
| Date | 2026-11-05 |
| Contact (Discord + email) | discord: pablo_est · estornut@gmail.com |

---

## 0. TL;DR

| | |
|---|---|
| **Visual GDD** | [gdd.pdf](gdd.pdf): 14-page visual deck of Season 01 (editor, modular catalog, ranked, tournaments, wearables); its art is concept, not gameplay screenshots |
| **Player promise** | You are a roadster pilot. You race circuits the community builds, while thrusters and jumps send you upside down. |
| **Primary player** | For players who already enjoy arcade time-trial racers, arriving alone or with friends, looking for three-minute races they can improve every day. |
| **Current status** | Playable core loop in a World: two circuits (City, Skyline) chosen by lobby vote, solo races with up to 4 bots, one shared multiplayer room for up to 8, keyboard and phone controls, records per circuit on a server stats page. Ghost-mode netcode (each client simulates its own car, the server validates the race, cars never collide) is integrated and being checked in a test build before the public World gets it. Playable link: [xrace.dcl.eth](https://decentraland.org/jump/?realm=xrace.dcl.eth). |
| **Requested round** | V0 |
| **Live at end of the round** | The demo race: a player can race City or Skyline solo against bots or live in the shared room, on desktop or phone, and see their clean, server-validated best times per circuit. |

---

## 1. Player Promise

**One-line promise.**

You are a roadster pilot. You race circuits the community builds, while thrusters and jumps send you upside down.

**One familiar comparison.**

An arcade time-trial racer, like Trackmania, but your car has thrusters and some straights are driven upside down.

**Why this game.**

We want a racing game the community both plays and builds: one player races the track another built, groups run tournaments, and everyone tries to beat their own time. That shared time and interaction is what we believe brings players back. The hype around the new Tesla Roadster, which inspired the car, can also draw curious players in.

---

## 2. First Minutes & How to Play

| Time | Player experience |
|---|---|
| **0–5 seconds after control** | You spawn by the grandstands while the camera flies over the circuit. A card offers SOLO or MULTI, bots, a circuit vote and a big START button. |
| **5–10 seconds** | You press START. A 10-second countdown moves the camera behind your roadster on the grid. On GO you hold throttle and launch. |
| **10–60 seconds** | The HUD counts checkpoints (CP 1/12) and points to the next one. On the main straight a ramp throws you over two pillars; a charge pad fills your battery. Other drivers' cars and names share the grid as ghosts. |
| **1–3 minutes** | You double-tap to boost, take the east ramp and drive upside down under a 32 m slab, then land on your wheels. Your first lap time appears. |
| **3–10 minutes** | After three laps the podium shows your position and time. Back in the lobby you vote the other circuit, add bots, or join the shared race. |
| **Natural stopping point** | The podium shows your best lap. Clean runs enter a per-circuit records book on the server's stats page, not yet in the world. From V1, the ranked board (Section 4) shows tomorrow's tracks here. |

**Player-facing How to Play.**

- Hold throttle, steer, hit every checkpoint
- Best time over three laps wins
- Live rivals share the grid as ghosts

---

## 3. Core Loop

| # | Step (verb) | What the player does (Player input → what they see or hear → what changes) | Why do it again? |
|---|---|----------------------------------------------------------------------------|---|
| 1 | Drive the line | Throttle, steer, brake or handbrake → the car drifts through the corner, tyres squeal → the next checkpoint counts | A cleaner line is a faster lap. |
| 2 | Charge | Cross a charge pad → the battery bar fills | Charge is what makes the next jump or boost possible. |
| 3 | Spend | Double-tap for boost or hold thrusters → speed, or a vertical lift that stretches or saves a jump | When and where to spend is the main decision of a lap. |
| 4 | Take the leap | Hit a ramp → fly, barrel roll (E), or drive the inverted ceiling → applause on a clean landing | The most memorable seconds of every lap. |
| 5 — optional | Beat the time | Cross the line → lap and race time, podium position; a clean run enters the circuit's records | A known number to beat next race. |

| | |
|---|---|
| **One complete loop takes** | One lap is about one minute and ends at the line with a lap time; a race is three laps (about three minutes) ending on the podium. Earlier payoffs: every checkpoint, the jump in the first 20 seconds, the ceiling run. |
| **Decision, challenge, or expression** | Where to brake, whether to spend charge on boost or keep it to save a jump, when to use thrusters to cut over a gap, and how much air control to risk for a roll. |
| **Shortest satisfying visit / typical session** | 3 / 15 minutes. One solo race against bots is about three minutes. |
| **Why repetition 10 remains appealing** | The track is known, so the challenge moves to tenths: better lines, earlier boosts, thruster shortcuts. Two circuits rotate by vote, and other live drivers or bots change every race. `TBD:` playtest whether this holds in V0, before the V1 daily target exists. |

**Pillars.**

1. Build: players make the tracks other players race.
2. Play together: racing is a reason to meet strangers and bring friends, on the same grid or on each other's tracks.
3. Progress: you climb day by day, and a higher rank earns better rewards.

---

## 4. Why Players Come Back

Both hooks arrive with V1, ranked with wearables (Section 9). In V0 the return reason is beating your own clean time per circuit.

### 4.1 The next-day (D1) sentence

> "A player who enjoyed their first session returns the next day (D1) because Hook 1, the daily energy for ranked races, refills at 00:00 UTC, and climbing the ranking unlocks more and more exclusive wearables, which they know from the podium board showing their rank and the energy left."

### 4.2 The progression chain

> **Repeatable action → persistent reward → new capability, status, or social role → new decision or challenge**

| Moment | What persists or has been built? | What becomes possible next? | How can another player tell? |
|---|---|---|---|
| **End of first session** | Best lap per circuit and first ranked points (1–4 per daily track) | Improve today's times for the difference in points; tomorrow's tracks are visible | Your name and time on the daily board |
| **End of first week** | A higher rank, and the Club Circuit wearable each rank grants (20 ranks, from 5 to 315 points, gaps growing) | Choose which daily tracks to grind for points; wear the reward | The wearable on your avatar in the lobby and grid |
| **Week 3+ — what takes more than two weeks?** | 315 points for the final wearable (12 a day at most, 42-day season) | First validated unlock at 315 wins the one Unique Winner Cap | The Winner Cap, one copy in the season |

You arrive after the 00:00 UTC reset with six energy and three new daily tracks on the lobby board. You wear the cap and shades you unlocked this week, and the driver you raced live yesterday is on the grid in the same shades. You spend two energy on today's hardest track and gain one point by cutting a tenth off your best. Rank 7 is 4 points away, so you join the shared race for the extra energy.

Rank thresholds, one wearable each: Legendary at 5, 10, 16, 23, 31, 40, 50, 61, 73 and 86 points; Exotic at 101, 117, 134, 152 and 171; Mythic at 192, 214, 237 and 261; the Unique Winner Cap at 315. A first session can reach the first two.

Currency or tradable rewards: wearables are earned only with server-validated ranked points and are supply-capped (Legendary 100, Exotic 50, Mythic 10, Unique 1 per design); the game never sells them, but a player can sell one they earned to another player. Main abuse risk: alternate accounts or bots farming points to resell wearables. Anti-farming: ranked counts only races with no validation infraction, and only wallets race ranked and earn wearables; guests race friendly races. Energy is a daily allowance for ranked races, not a currency: it is never sold, and finishing a live race in the shared room with at least one other human earns 1 extra, up to 3 a day.

### 4.3 Two return hooks

| Selected hook | Exact trigger or timing | What the player anticipates | Reminder channel + no-reminder fallback |
|---|---|---|---|
| **1.** Daily goals: daily energy for V1 ranked races | Each player gets 6 energy per day, refilled at 00:00 UTC; 1 energy = 1 ranked race on the three daily tracks; friendly races are unlimited and free; best result on each track earns 1–4 points, improving earns only the difference | Today's races, a higher rank and the rarer wearables it unlocks | A post with today's tracks in the ELON RACE Decentraland Community; fallback: the lobby board shows today's tracks and points left |
| **2.** Season track: Club Circuit S01, the V1 wearables | 42-day season; cumulative ranked points, no demotion; 20 wearables | The next wearable and the 315-point Winner Cap race | A Decentraland Event listing at season start and end; fallback: points-to-next-wearable on the podium |

---

## 5. Social by Design

| | |
|---|---|
| **The repeatable social loop** | Player A climbs the ranking and earns a supply-capped wearable → Player B sees it on A's avatar in the lobby and on the grid, and races ranked to earn one too, or buys one from a player who sells it → both climb against each other on the same board → the rarer wearables show who climbed highest, a reason to race again. The game never sells wearables for money; the effort they cost is what gives them value. |
| **The disappearance test** | The live shared race breaks: no grid to share, nobody to pass. Solo races with bots and the records per circuit remain; recorded benchmarks and the daily boards come with V1. |
| **From strangers to a group** | There is one shared multiplayer room, so every arrival who picks MULTI is in the same lobby, sees the others' names and votes, and joins the same grid. No voice or text is needed. |
| **Recognition & continuity** | Names show in the lobby list, the race standings and, for clean runs, the records per circuit. From V1, what persists is above all each player's rank, and every rank reached grants a wearable; the tracks the community builds, and the records and race times on them, persist too. A returning player sees who passed them and whose record to beat next. |
| **Quiet hours & player counts** | With nobody else online, a solo player races bots in V0, and from V1 races ranked until there are people for a live race: ranked races are against recorded runs of other players or bots of different difficulty (bots with different pace exist today; recorded runs come with V1), so there is always someone to beat. Rank depends mainly on the track and the completion time: a lower time is a higher rank. Social play becomes viable at 2 players; the ideal group is 4 in these first versions; the target player count is 8 (the grid size). Tested count: 4 headless network clients (`npm run bot`) over a simulated 200 ms link, not human players. When a player is not racing, the main menu shows the live race and lets them join it from there (planned). |
| **Drop-in / drop-out** | A late arrival watches the running race as a spectator and joins the next grid. If a driver leaves, the race continues; a race ends 20 seconds after the winner finishes, or at 6 minutes at most. Cars are ghosts to each other, so nobody can block or ram another driver. |
| **Visible play (the bystander test)** | You see a roadster fly off a ramp, roll, and drive along the underside of a slab. |
| **Shareable play (the memorable moment)** | Your car upside down under the ceiling slab at full speed, with another driver right behind you. |
| **Bring-a-friend** | When you organize a race or tournament, you want your friends in it: every participant who completes it earns you tournament-organizer points toward an organizer wearable. This comes with tournaments, after V1; the same model worked in our earlier game GolfCraft on SDK6. |

---

## 6. Mobile-First

**Every core-loop verb on touch.**

| Core-loop verb | How it works with touch controls |
|---|---|
| Drive the line | Explorer's jump button is the throttle; our LEFT and RIGHT hold buttons steer; our BRAKE button brakes |
| Charge | Automatic: drive over the pad |
| Spend | Double-tap the jump button to boost; our LIFT button holds thrusters |
| Take the leap | Explorer's E button rolls in the air; F respawns at the last checkpoint |
| Beat the time | Phone lobby with full-width finger-sized rows; START is one tap |

**UI plan.**

The phone gets its own lobby and race card: full-width rows, large type, and a narrow race column at the top right that keeps clear of the explorer's joystick and buttons.

**Performance.**

Target: 60fps on recommended desktop hardware and 30fps on an iPhone SE (2022) in the mobile client, at 8 players; a target, not yet a result. Measured so far: one physics step of the player's own car costs 1 ms in the scene runtime on desktop (about 6 % of a core at 60 Hz); the server spends about 0.2 ms per bot per tick and only validates human cars. Client fps is not profiled yet, and the step cost on a phone is not measured.

**Desktop-only dependencies.**

None blocking. Checked against the Desktop vs Mobile Feature Gap tracker (updated 2026-10-13): the game uses WebSocket and standard input actions, no Draco-compressed models and no tween sequences. The one listed gap we touch is nine-slice UI backgrounds (#2060), used by our lobby and HUD panels: their borders may stretch on a phone, which stays readable, and plain panels are the fallback.

---

## 7. World, Look & Story

**Story / world.**

Roadsters with cold-gas thrusters race through a low-poly city built for stunts. Every season the Club Circuit dresses its best pilots, so your rank is something you wear.

**Visual direction.**

Low-poly retro: flat colours, white roadster in eight liveries, red-and-white kerbs and barriers, and two scenery kits generated by Blender scripts, City for the city circuit and Neon for Skyline. Signature shot: the car upside down under the ceiling slab, thrusters glowing. `TBD:` small-screen readability check of checkpoints and the next-checkpoint arrow.

---

## 8. Audience & Comparables

**Primary player + arrival context.**

> For players who already enjoy arcade time-trial racers, arriving alone or with friends, looking for three-minute races they can improve every day.

**How the first group arrives.**

The first players come from four places: curiosity around Elon Musk's new Tesla Roadster, Decentraland players looking for a racing game, GolfCraft's players through the shared menu once GolfCraft is migrated to SDK7, and our own social networks. A weekly race listed as a Decentraland Event, every Friday at 20:00 UTC, puts them on the grid at the same time to fill a live race of 4.

**Deliberately not for.**

Sim-racing fans looking for realistic handling.

### Comparables

| | Comparable A — Decentraland: GolfCraft (our own earlier game) | Comparable B — outside Decentraland: Trackmania (played years ago; recent gameplay videos) |
|---|---|---|
| What we observed works | In our view the most complete Decentraland game, with the best retention and gameplay: multiplayer, tournaments, ranked play and seasons all in one game. | Short time-trial runs with instant restart, ghost cars instead of crashes, community-built tracks, and a daily track campaign with medals. |
| What does not fit our audience or context—and why | Golf is turn-based and calm; ELON RACE is raced at the same time, in real time. | It needs a PC with keyboard or pad, its editor is complex, and it aims at expert players. |
| What we will do differently | The same proven mechanics (ranked, tournaments, wearables), now for racing; built for mobile from the start; and the two games linked through the menu so players move from one to the other. | Mobile from the start, thrusters and upside-down sections, and ranked with supply-capped wearables instead of medals. |

---

## 9. 4 Week Plan (v1 scope)

**Rounds.**

| Round | What the player plays | Return hook it adds |
|---|---|---|
| **V0** (requested) | The demo race: City and Skyline by vote, solo with up to 4 bots or the shared room of 8, phone controls, ghost-mode netcode, clean records per circuit | None yet: your own best time per circuit |
| **V1** | Ranked: three daily tracks against recorded runs and bots, 1–4 points each, and the Club Circuit S01 wearables earned by rank; plus an experimental ball mode, Rocket League style with a magnet on the roadster's nose | Daily ranked energy and the season wearables (Section 4) |
| **V2** | The track editor back with its designed UX: build, test and publish tracks; community tournaments with organizer points | Tracks other players built; scheduled tournaments |
| **V3** | Season 02, and ball mode out of experimental if V1 players take to it | A fresh season |

The four weeks below cover V0.

| Week | What is playable / done |
|---|---|
| 1 — Prototype definition | Current build in a test build: City and Skyline with lobby vote, solo with bots, shared race, phone controls, ghost-mode netcode checked in the explorer |
| 2 — Core interaction + first-group test | Release of the demo race in `xrace.dcl.eth`; first group test at 4+ players there |
| 3 — Core systems refinement | Driving feel, live: steering that tightens with speed, Trackmania-style drift on a brake tap, chassis roll |
| 4 — Playable release, including testing and deployment | Phone playtest over mobile data (race feel, validation infractions, physics step cost) and the fixes it asks for, in the public World |

**What keeps the experience changing after launch.**

- Without building a new level, variation comes from the circuit vote (City or Skyline), bots of several paces and live opponents; from V1, the daily ranked track rotation.
- If an update is skipped, the vote and live opponents still create variation.
- Progression creates no power gap: equal cars; from V1, a new player can score daily points within one race.
- One player behaviour that would change what we build next: if almost everyone races SOLO and never enters the shared room, we bring forward ranked against recorded runs and the live-race prompt in the menu.

**Not building in v1.**

1. Ranked, daily energy and the Club Circuit S01 wearables: V1, the first to come back.
2. The track editor as a player tool: a prototype exists in the world (modular catalog v2, flat pieces) but stays off until its UX is designed. To publish a track, its builder must first complete a lap on it, and then a bot checks that it can finish it. V2.
3. Community races and tournaments, with organizer points and the organizer wearable: V2.
4. Ball mode: experimental in V1, with a design document before any code.
5. New 3D track pieces (vertical arcs, tubes, loops): V2, in the editor's catalog after driving tests.

Standing non-goal: never cars that are faster for paying or for rewards, because skill must decide. (S01 deck)

**Top risk + fallback.**

Top risk: the ghost-mode netcode on phone networks. A client that stalls skips its clock forward and loses that time, and on a bad link an honest run can trip a validation envelope and fall out of the records; the cost of the physics step on a phone is also unmeasured. Fallback: in week 4, measure race feel, infraction counts and step cost on the iPhone SE over mobile data, and widen the envelopes before touching the model.
