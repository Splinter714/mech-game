// Carrier art (#328) — "Broodhauler". A DRONE CARRIER built on the battle tank's body: the
// literal same tracked hull (`drawTankHull`, imported from tank.js — shared, never forked), with
// the tank's rotating gun turret REPLACED by a bay door on the deck that the drones come out of.
//
// Playtest (2026-07-19), Jackson: "carrier honestly looks bad; let's design it more tank-like
// visually with treads on a rectangular body; actually re-use tank art exactly, but minus the
// tank turret; and maybe add something on top that looks like a bay door or something to let the
// drones out". The old four-legged Broodwalker art (art/vehicles/quadruped.js) is gone entirely.
//
// The unit is UNARMED (#328, Jackson: "unarmed — pure carrier"), so there is no gun, no muzzle
// and nothing to slew: the bay door is drawn into the unit's SECOND sprite (the one every vehicle
// view calls its "turret" — see scenes/arena/enemies.js `_makeVehicleView`) and
// `carrierBehavior` simply pins that sprite's angle to the hull's, so the door reads as bolted to
// the deck rather than tracking the player.
//
// The door ANIMATES: two frames are rasterised here, `<key>_turret_0` (shut) and
// `<key>_turret_1` (open — leaves retracted, lit bay throat exposed). The kind declares
// `turretFrames: 2` (data/enemyKinds.js) and `carrierBehavior` flips `e.turretFrame` to 1 for a
// beat each time a drone batch launches, exactly mirroring the `legFrames` hull-frame convention
// the old Broodwalker used for its walk cycle. No new machinery — same seam, other sprite.
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC, armorShell } from '../mechPrims.js';
import { VEHICLE as V, accentGlow, haloRound } from './palette.js';
import { drawTankHull } from './tank.js';

// How many bay-door frames this art builds: [0] shut, [1] open. Exported so enemyKinds.js's
// `turretFrames` field and this file share one source of truth rather than duplicating the
// number "2" (same pattern the old CARRIER_LEG_FRAMES used).
export const CARRIER_DOOR_FRAMES = 2;

// The launch bay: a raised armoured coaming on the hull deck with two sliding leaves that part
// down the centreline. Drawn pointing "up" (−y = forward), same convention as the hull, and
// sized to sit INSIDE the tank hull tub's own silhouette (half-width ~7-8 at the deck) so it
// reads as a hatch cut into the deck rather than a box balanced on top.
function drawBay(sg, accent, open, armored = false) {
  const A = accentGlow(accent);
  // Coaming (the raised rim around the opening) — halo/outline/body layering, same language as
  // every other vehicle mass in this folder.
  haloRound(sg, 0, 1, 15.6, 21.6, 4.4);      // #129 legibility halo
  roundC(sg, 0, 1, 14, 20, V.outline, 4);
  roundC(sg, 0, 1, 12, 18, V.bodyDk, 3.4);
  // The bay THROAT — a BLACK recess (Jackson #396: "shouldn't be purple inside, it should be
  // black"). Always drawn; when the door is shut the leaves below cover it completely.
  roundC(sg, 0, 1, 9.6, 15, 0x000000, 2.6);
  if (open) {
    // Interior stays black; only a faint grey hint of the rack the drones sit on so an open bay
    // still reads as "something is in there" — NO accent/purple glow.
    roundC(sg, 0, 1, 8.4, 13.6, 0x000000, 1);
    for (const y of [-3.4, 1, 5.4]) rectC(sg, 0, y, 7.4, 1.1, V.tread, 0.5);
  }
  // Two sliding leaves. Shut: they meet at the centreline. Open: each has slid outboard, leaving
  // the throat exposed between them. Same shapes either way — only the x offset moves — so the
  // two frames read as one door in two positions, not two different objects.
  const slide = open ? 5.6 : 0;
  const leafW = open ? 3.4 : 5;
  for (const side of [-1, 1]) {
    const x = side * (slide + leafW * 0.5 + 0.2);
    roundC(sg, x, 1, leafW + 1.2, 16.2, V.outline, 1.8);
    roundC(sg, x, 1, leafW, 15, V.body, 1.4);
    roundC(sg, x, -3, leafW * 0.72, 6, V.bodyHi, 1.2);
  }
  // Centreline seam / hazard chevrons on the coaming lip — the "this opens" tell that is legible
  // even in the shut frame at gameplay zoom.
  for (const y of [-8.6, 10.6]) rectC(sg, 0, y, 11, 1.4, accent, open ? 0.9 : 0.7);
  // Launch beacon on the port lip — steady when shut, hot when open.
  ellipseC(sg, -8.6, -6, 2.2, 2.2, V.outline);
  ellipseC(sg, -8.6, -6, 1.3, 1.3, open ? A.hot : A.core, open ? 1 : 0.7);
  // #300: shared plating overlay on the bay mass while the unit's armor pool holds — the very
  // same `armorShell` primitive the player mech, enemy mechs and the tank all draw.
  if (armored) armorShell(sg, 0, 1, 12, 18);
}

// `opts.armored` (#300) draws the shared armorShell plating over the hull tub + bay (on BOTH
// door frames, so the door keeps animating while plated).
export function drawCarrier(scene, key, def, opts = {}) {
  const accent = def.themeColor ?? V.rim;
  const armored = !!opts.armored;
  const D = DESIGN * ART_SCALE;
  // The hull is the tank's, unmodified — one shared function, no fork.
  gen(scene, `${key}_hull`, D, D, (g) => drawTankHull(scaledGraphics(g), accent, armored));
  for (let f = 0; f < CARRIER_DOOR_FRAMES; f++) {
    gen(scene, `${key}_turret_${f}`, D, D, (g) => drawBay(scaledGraphics(g), accent, f === 1, armored));
  }
}
