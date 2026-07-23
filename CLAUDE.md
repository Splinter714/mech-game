# Mech Game — orientation

A top-down, real-time mech action game with deep customization. Build a mech from
parts (each with its own armor + structure), mount weapons into slots, then drive it
in a hex arena with tank-style controls. Built to mirror the sibling "horse game"
project's architecture: plain JS + Phaser 3 + Vite, **all art generated procedurally in
code** (zero asset files), data-driven entities, and a strong test discipline because
the owner verifies by playing/tests, not by reading code.

## Run it

```
npm run dev      # dev server (http://localhost:5173) — used by the Claude preview
npm test         # Vitest unit tests for the pure data layer (fast, no browser)
npm run smoke    # Playwright headless test of the real running game
npm run build    # production bundle
```

`npm run smoke` needs a one-time `npx playwright install chromium`, and a dev server
running (it auto-detects the port, or set `SMOKE_URL`). The Claude preview is wired via
`.claude/launch.json` (`mech-game-dev`).

## Architecture

- **`src/main.js`** — Phaser config + HiDPI/DPR sizing. Scenes: Boot → Garage ↔ Arena
  (+ Hud overlay during Arena, + the dev-only AudioScene — the AUDIO tab: music tuner +
  the whole SFX-authoring surface, #470).
- **`src/data/`** — pure logic, no Phaser, fully unit-tested:
  - `Mech.js` — the generic model: per-location armor/structure, `applyDamage`, the
    kill rule, mounting, per-weapon ammo (self-regenerating magazines), weapon queries.
    Configured entirely by data. No heat (removed); ammo is the only firing constraint.
  - `anatomy.js` — the 8 body locations + the kill rule (`mechDestroyed`): head OR
    cockpit OR centerTorso destroyed, OR both legs. The **four skill slots** are the
    mountable upper-body locations (`MOUNT_LOCATIONS`) — the two arms and the two side
    torsos; head dropped out with #31, centerTorso with #188. Legs aren't mount points.
  - `chassis/` — weight classes (light/medium/heavy). `index.js` expands a short
    config (`light.js` etc.) into per-location stats + movement tuning. **Add a chassis
    = a new config + one registry entry.**
  - `categories.js` + `weapons.js` — the two-axis weapon model: a Category (economy)
    plus a composable `delivery` profile (hitscan/projectile, velocity, straight/arcing,
    guidance, single/spread/stream). Each weapon has its own `ammoMax`/`ammoRegen`
    magazine (`ammoMax: null` = unlimited, for melee). **Add a weapon = one entry in
    `WEAPONS`.** A non-player owner can mount a *tuned variant* of a base weapon without
    forking the entry: `resolveWeapon(baseId, override)` shallow-merges a partial override
    (nested `delivery` merged field-by-field, base never mutated) — enemy kinds opt in via
    `weaponOverride` in `enemyKinds.js` (e.g. the drone's weakened Repeater). Enemy-vehicle
    fire cadence always derives from the resolved weapon's own timing (`_fireInterval` —
    no per-kind fire timer; tune cadence via `weaponOverride` `cycleTime`/`fireRate`), with
    optional kind-level trigger discipline (`burstShots`/`burstRestMs`). A kind that needs
    MORE than one gun declares a map of weapon **slots** instead (`weapons: { nose: {...},
    flank: {...} }`, `kindWeapons.js`) — each slot carrying its own weapon/override/range/
    trigger discipline, with cadence and burst counters tracked per slot; the behaviour names
    the live slot and scene code stays free of weapon-id literals. An EMPLACED kind can also
    opt into a real magazine with `ammoLimited: true` (`kindAmmo.js`) — per-slot ammo on the
    same MAGAZINE + RELOAD model as the player's gun (#402): drains one round per trigger pull,
    and once EMPTY locks out for `RELOAD_SECONDS` then snaps back to FULL (no `ammoRegen` trickle),
    so a player can SUPPRESS a wall turret by baiting it into emptying its magazine.
    Deliberately scoped to `turret`/`wallTurret`; mobile kinds stay pure cadence. Fine-grained
    delivery feel (spread stagger, speed-jitter band, homing turn radius, weak-seek
    strength/radius, burst stagger) is per-weapon tunable via optional `delivery` fields
    that default to the shared constants in `delivery.js`.
  - `items.js` (unified lookup — since #188 removed `equipment.js` and its centre-torso
    abilities, every mountable item is a weapon, so this is a thin wrapper over `WEAPONS`),
    `loadout.js` (the build model: **four skill slots, one item per location**,
    melee only in arms; no tonnage, no multi-slot capacity).
  - `players.js` — the PLAYERS COLLECTION (#347, phase 1 of local co-op). The arena holds
    `scene.players` — currently exactly ONE entry — instead of a player singleton. Pure
    queries here (`nearestPlayer`, `allPlayersDead`, `playersCentroid`); the scene-side
    seams live in `scenes/arena/players.js` as standalone `fn(scene, …)` helpers (not mixin
    methods, so the arena's hand-built test doubles work unchanged). Arena code asks a
    QUESTION — `targetPlayerFor` (which player is this enemy fighting? NEAREST),
    `listenerOf`, `fogOriginOf`, `cameraFocusOf`, `livePlayersOf` — rather than reading a
    global. `scene.px`/`py`/`mech`/`playerView`/`_playerDead` still work: they're delegating
    accessors onto `players[0]` (bottom of `ArenaScene.js`), aliasing the same storage.
    **#348 (phase 2) made it real co-op**: up to `MAX_PLAYERS` (2), a second player joins
    mid-sortie with START on gamepad 2 (`scenes/arena/coop.js`), each player owns its own
    `Controls`/fire cooldowns/sprint/dash/converge pick/reticle, enemies target the nearest
    player, friendly fire is ON, and each player has an identifying colour (`PLAYER_COLORS` —
    a ground ring, plus a rim-accent on the procedural mech theme for players after the first).
    The camera frames the live players' centroid and `data/leash.js` HARD-STOPS anyone leaving
    that frame (no zoom-out, no rubber-band — owner's explicit choice). `data/respawn.js` is
    the 20s respawn clock gated on the survivors being out of combat ~1.5s.
    **#349 (phase 3) added the Garage flow**: `data/coopGarage.js` is the pure sequential
    build state machine — P1 builds, presses the (relabelled) Deploy button as "P1 READY",
    the garage rebinds its one editing surface to player 2's slot, P2 builds, deploy. There
    are exactly TWO persistent build slots (`PLAYER_MECH_KEYS` = `mech1`/`mech2`, both with
    complete defaults in `rosters.js`) and deliberately no roster/slot-picker UI. The
    mid-sortie START join stays as late drop-in and now drives its own `mech2` build.
  - `hexgrid.js` — the shared hex primitives every hex-aware module builds on (others
    that reason about hexes: `hexRoute.js`, `hexEdges.js`, `hexLabels.js`, `wallEdges.js`,
    `worldgen.js`, `arena/world.js`). Axial coords; pure
    `neighbors/distance/hexToPixel/pixelToHex/range/ring`. The mech moves with free
    physics on top, so collision/LOS are not hex algorithms.
  - `save.js` + `rosters.js` — localStorage garage (the `makeRoster` factory mirrors
    the horse game). `events.js` — event-name constants.
- **`src/art/`** — procedural textures via `gen()` + `scaledGraphics()` (super-sampled
  for HiDPI). `mechArt.js` draws a mech as a **hull** (legs, walk frames) + **turret**
  (torso/arms/head/weapons) from the live Mech, so destroyed parts become stumps and
  weapons vanish. `hexArt.js`, `iconArt.js`. `index.js` is the build registry.
- **`src/input/Controls.js`** — input abstraction: keyboard+mouse and a gamepad both
  feed one per-frame *intent* (throttle/turn, aim, and a held flag per skill slot). Each
  of the four slots is bound to a fixed button (`SKILL_BINDS`): RA→RT/RMB, LA→LT/LMB,
  RT→RB/E, LT→LB/Q. L3/Space is the always-available Dash (#261, `DASH_BIND` — separate from
  `SKILL_BINDS`, it isn't a mountable location); R3/F is unbound since #322. Left stick/WASD
  drives, right stick/mouse aims. **#348: one `Controls` per PLAYER** — `padIndex` picks the
  physical pad and `keyboard` says whether that player also owns the keyboard+mouse (player 1
  only; every later player is gamepad-only). **#346 added touch as a THIRD source into that same intent**:
  floating on-screen sticks (left half drives, right half aims with the pad's hold-last-angle
  semantics). The stick math is pure and unit-tested in `touchSticks.js` (tuning dials live in
  its `TOUCH_STICK` object, including a `floating` flag); `TouchStickHud.js` only draws them.
  Touch reports no fire and no dash — weapon triggers are deliberately out of #346's scope.
- **`src/scenes/`** — `GarageScene` (mech lab: a four-slot paper-doll; click a catalog
  item then a body section to mount it, each slot shows its fire bind, live mech preview,
  deploy) and `ArenaScene` (hex world; tank locomotion with weight inertia; turret slews
  within `turretArc` and pushes the chassis when you aim past it; stompy stepped gait;
  **per-slot firing** — each weapon fires on its own button, gated by ammo; per-part
  damage on a target dummy). `HudScene` is the arena overlay (weapons/ammo + health).

## Conventions

- Plain JS, ESM. No TypeScript. Match the surrounding style.
- Adding content is **data, not code**: a chassis, a weapon, an equipment item, or a
  saved-build slot should each be a single new entry in its registry/table.
- Tests are the safety net. Put pure logic in `src/data/*` and unit-test it; reserve the
  smoke test for "does the real game boot, render, drive, and apply damage."

## Status (Milestone 1)

Foundation + a thin vertical slice of both the garage and the arena. Enemy AI + real combat
and world collision have since shipped. Still deferred: full garage UX, full heat/ammo
simulation, more chassis/assault class, squad control. See `~/.claude/plans/` for the plan.

## Durable working context (checked-in memory)

Cross-machine session memory lives in `.claude/memory/` so it travels with a clone (this repo
is worked from multiple machines). On session start, read `.claude/memory/MEMORY.md` — its
index points to the project's locked design decisions, the ship/deploy flow, the fast-lane
tuning rule (skip the full test gate for pure data/feel tweaks; verify in play), and the
sibling horse-game reference. Treat these as point-in-time notes: verify file/line claims
against current code before asserting them.

Jackson's cross-project working style (verify-by-playing, the green/yellow/red/blocked +
ready-for-playtest kanban, "never write 'Jackson decided X'", dispatch-to-agents, the deploy
ritual, durable-vs-per-instance approval) lives in the **user-level** `~/.claude/CLAUDE.md`,
which is deliberately NOT committed here (it's cross-project and personal, and this repo is
public). Copy it onto each machine you work from.
