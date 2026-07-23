// TRUE RELATIVE UNIT SIZE (#468) — the pure arithmetic behind the art gallery's ENEMIES scale
// toggle.
//
// The gallery normally fits every unit to its own cell, which is what makes an infantry trooper
// reviewable at all (at real size it's a speck next to a tank). The cost is that you cannot
// eyeball "is the drone too big next to the tank" from that screen. The toggle draws the whole
// tab at ONE scale instead, so the cells are directly comparable.
//
// Every unit texture in the game is baked onto the same DESIGN*ART_SCALE canvas at the same
// pixel density, and the arena displays it at `ARENA_MECH_SCALE * factor` — a mech flat at 1,
// a non-mech vehicle at its kind's `scale`. So texture-ink px × factor IS world size, and one
// shared base scale across a whole tab reproduces the arena's relative sizes exactly.
//
// Pure (no Phaser, no texture manager) so it's unit-tested directly.

// The fallback display multiplier for a kind with no `scale` of its own. Mirrors
// VEHICLE_SCALE_MULT in scenes/arena/enemies.js, which is where the arena resolves the same
// thing at spawn time — kept in sync by the enemyKinds data, not by cross-importing scene code.
export const VEHICLE_SCALE_MULT = 1.15;

// A MECH draws at the arena mech scale flat, so it is the unit of comparison: factor 1.
export const MECH_SCALE_FACTOR = 1;

// How big this non-mech kind draws, as a multiple of a mech.
export function vehicleScaleFactor(def) {
  return def?.scale ?? VEHICLE_SCALE_MULT;
}

// The one base scale that draws every entry at its true relative size while keeping the LARGEST
// of them inside a `box`-sided square. `entries` are `{ w, h, factor }` in texture px; a cell's
// own draw scale is `base * factor`. Returns 0 for an empty/degenerate set (nothing to draw).
export function trueScaleBase(entries, box) {
  let base = Infinity;
  for (const e of entries ?? []) {
    const w = e?.w * (e?.factor ?? 1), h = e?.h * (e?.factor ?? 1);
    if (!(w > 0) || !(h > 0)) continue;
    base = Math.min(base, box / w, box / h);
  }
  return Number.isFinite(base) ? base : 0;
}
