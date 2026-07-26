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
