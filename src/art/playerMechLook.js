// #404 (third pass) — THE ONE DEFINITION OF WHAT A PLAYER MECH LOOKS LIKE.
//
// The garage lab preview and the deployed arena mech are two surfaces showing the SAME machine,
// and until now each assembled its own `buildMechTextures` options inline. That parallelism
// caused #404 three times running: the accent applied to player 2 only, then the arena had it and
// the lab didn't, then the lab had the accent but still passed no `statusSpot` — which dropped
// `drawTurret` into its ENEMY branch and painted the reactor spine, the two flanking vents and
// the cockpit optic in reactor purple (`mechPrims.REACTOR`), purple the arena mech has never had.
//
// So the options are no longer written anywhere but here. Every place that bakes or re-skins a
// player mech — arena spawn/join (`arena/coop.js`), the damage/repair re-raster (`arena/combat.js`)
// and the garage preview (`GarageScene._previewArt`) — passes `playerMechArt()` into
// buildMechTextures/reskinMech instead of an options literal of its own. A new art input added here
// reaches all three at once, so the two surfaces cannot silently drift again.
//
// The DELIBERATE differences between the lab and the arena are the explicit parameters below —
// nothing else about the render is allowed to differ:
//   • `statusSpot` — the live powerup readout. The lab has no run in progress, so it passes the
//     EMPTY list: the dark "no powerup" core, exactly what a player looks like the instant they
//     deploy. It is NOT "pass nothing", which is the enemy look.
//   • `hullFrames` — how finely the baked walk cycle is sampled. The lab is a still pose that
//     only ever shows `_hull_0`, and `strideDir(0, n) === 0` for every n, so frame 0 is
//     pixel-identical at any count: the lab bakes the cheap 4 and shows the same legs the arena's
//     16-frame player does at rest. A texture-budget difference with no visual one.
import { PLAYER_HULL_FRAMES } from './mechArt.js';
import { playerAccent } from '../data/players.js';

// The art options for player `id`'s mech. `statusSpot` defaults to the empty list (no powerup),
// never to undefined — undefined is the enemy/reactor-purple branch of drawTurret.
//
// #487: `accent` is an OPTIONAL override for the rim tint. It exists because a player can now PICK
// their colour in the garage (data/mechColors.js) instead of taking the auto-assigned one — the
// pick is passed straight through here so the same rim-tint mechanism paints it. Omitted (the arena
// default) it falls back to the per-id auto-colour, so nothing that doesn't pass one changes. A
// caller resolves the value with `mechColorFor(build, id)` — which is exactly `playerAccent(id)`
// when the slot has no pick, keeping the no-pick path byte-identical.
export function playerMechArt(id = 0, { statusSpot = [], hullFrames = PLAYER_HULL_FRAMES, accent } = {}) {
  return {
    theme: 'player',
    accent: accent ?? playerAccent(id ?? 0),
    statusSpot: statusSpot ?? [],
    hullFrames,
  };
}
