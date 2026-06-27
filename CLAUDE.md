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
  (+ Hud overlay during Arena).
- **`src/data/`** — pure logic, no Phaser, fully unit-tested:
  - `Mech.js` — the generic model: per-location armor/structure, `applyDamage`, the
    kill rule, mounting, heat/weapon queries. Configured entirely by data.
  - `anatomy.js` — the 8 body locations + the kill rule (`mechDestroyed`): head OR
    cockpit OR centerTorso destroyed, OR both legs.
  - `chassis/` — weight classes (light/medium/heavy). `index.js` expands a short
    config (`light.js` etc.) into per-location stats + movement tuning. **Add a chassis
    = a new config + one registry entry.**
  - `categories.js` + `weapons.js` — the two-axis weapon model: a Category (ammo/heat
    economy) plus a composable `delivery` profile (hitscan/projectile, velocity,
    straight/arcing, guidance, single/spread/stream). **Add a weapon = one entry in
    `WEAPONS`.**
  - `equipment.js`, `items.js` (unified lookup), `loadout.js` (slot/tonnage validation).
  - `hexgrid.js` — **the only file that knows hexes exist.** Axial coords; pure
    `neighbors/distance/hexToPixel/pixelToHex/range/ring`. The mech moves with free
    physics on top, so collision/LOS are not hex algorithms.
  - `save.js` + `rosters.js` — localStorage garage (the `makeRoster` factory mirrors
    the horse game). `events.js` — event-name constants.
- **`src/art/`** — procedural textures via `gen()` + `scaledGraphics()` (super-sampled
  for HiDPI). `mechArt.js` draws a mech as a **hull** (legs, walk frames) + **turret**
  (torso/arms/head/weapons) from the live Mech, so destroyed parts become stumps and
  weapons vanish. `hexArt.js`, `iconArt.js`. `index.js` is the build registry.
- **`src/scenes/`** — `GarageScene` (mech lab: click a part, mount from the catalog,
  validate, deploy) and `ArenaScene` (hex world; tank locomotion with weight inertia;
  turret slews within `turretArc` and pushes the chassis when you aim past it; stompy
  stepped gait; per-part damage on a target dummy). `HudScene` is the arena overlay.

## Conventions

- Plain JS, ESM. No TypeScript. Match the surrounding style.
- Adding content is **data, not code**: a chassis, a weapon, an equipment item, or a
  saved-build slot should each be a single new entry in its registry/table.
- Tests are the safety net. Put pure logic in `src/data/*` and unit-test it; reserve the
  smoke test for "does the real game boot, render, drive, and apply damage."

## Status (Milestone 1)

Foundation + a thin vertical slice of both the garage and the arena. Deferred: full
garage UX, enemy AI + real combat, full heat/ammo simulation, world collision, more
chassis/assault class, squad control. See `~/.claude/plans/` for the plan.
