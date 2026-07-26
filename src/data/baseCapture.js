// #518: pure helpers for wiring a persisted claimed-base record (data/outposts.js) back into a
// freshly generated `bases` list at deploy time. Terrain regenerates from a new random seed every
// deploy — a base's absolute pixel position differs every sortie — but `base.id` ("base0",
// "base1", … data/worldgen.js `placeBases`) is the base's stable INDEX along the corridor, so a
// claim is matched by (biomeId, baseId) rather than by coord. The scene (scenes/arena/world.js
// `_buildWorld`) calls these right after `generateTerrain` returns, before spawning any dormant
// units off `bases`.
import { axialKey } from './hexgrid.js';

// Every base index currently claimed for this biome, as a Set of `base.id` strings.
export function capturedBaseIdsFor(outposts, biomeId) {
  const set = new Set();
  for (const o of outposts ?? []) {
    if (o.biomeId === biomeId && o.baseId != null) set.add(o.baseId);
  }
  return set;
}

// Marks every base in `bases` whose id is in `capturedIds` as `captured: true` and strips its
// enemy content — no docks (no dormant garrison to spawn), no destructible objective hex (the
// base is already held, nothing left to punch through). Mutates the base records in place
// (mirrors worldgen.js's own re-validation passes over this same list) and returns every hex key
// that held a dock or the objective, so the caller can swap that terrain to `playerStructure`
// (data/terrain.js) and drop it from `buildingHp` before anything else reads the fresh map.
//
// A base NOT in `capturedIds` is left completely untouched (`captured` explicitly set false, not
// omitted, so a caller can rely on the field always being present rather than checking for
// `undefined`).
export function applyCapturedBases(bases, capturedIds) {
  const swappedHexKeys = [];
  for (const base of bases ?? []) {
    if (!capturedIds.has(base.id)) { base.captured = false; continue; }
    base.captured = true;
    for (const d of base.docks ?? []) swappedHexKeys.push(axialKey(d.q, d.r));
    if (base.objectiveHex) swappedHexKeys.push(axialKey(base.objectiveHex.q, base.objectiveHex.r));
    base.docks = [];
    base.objectiveHex = null;
  }
  return swappedHexKeys;
}

// #516: a captured base's own alert tower doesn't belong to it anymore either — drop it from the
// list `scenes/arena/bases.js`'s `_initAlertTowers`/`_updateAlertTowers`/`_spawnTowerPatrols` all
// read (`this.alertTowerHexes`), so a base the player already holds never spools a countdown,
// sirens, or spawns a hostile patrol guarding it. `_wakeBase` itself is already a harmless no-op
// against a captured base (`applyCapturedBases` above already emptied its docks, so there's
// nothing left to wake), but leaving the tower live would still show its escalating-ring FX/siren
// and spawn a hostile patrol on ground that reads as the player's own — this closes that gap
// rather than relying on the wake no-op alone. Pure filter, mirrors `applyCapturedBases`'
// signature/shape (takes the already-computed `capturedIds` Set, never re-derives it) so
// `scenes/arena/world.js` `_buildWorld` can call both from the same spot. A tower with no
// `baseId` at all (shouldn't happen — `placeGapTowers` always stamps one — but defensive) is
// never filtered out by this alone.
export function filterCapturedAlertTowers(alertTowers, capturedIds) {
  if (!capturedIds || !capturedIds.size) return alertTowers ?? [];
  return (alertTowers ?? []).filter((t) => t.baseId == null || !capturedIds.has(t.baseId));
}
