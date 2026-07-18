// #270: the pure, Phaser-free geometry behind the general terrain-id hex-label system —
// "which hexes (with their terrain id) currently fall within some pixel radius of a point,
// excluding a given set of hex keys" — factored out so it's unit-testable without a scene.
// The Phaser-side piece (scenes/arena/terrainLabels.js) wraps this each tick to create/destroy
// pooled Text objects for whatever this returns; it owns no Phaser objects itself.
import { hexesWithinPixelRadius, axialKey } from './hexgrid.js';

// `terrain` is the scene's hexKey → terrainId Map (world.js `this.terrain`). `excludeKeys`
// (optional Set) skips hex keys that already carry a different label — e.g. the bold-red
// dock/alertTower/turretEmplacement tags (bases.js `_spawnHexLabels`), so a base hex never gets
// double-labelled. A hex that's within radius but absent from `terrain` (nothing generated
// there) is silently skipped — there's no terrain id to show.
export function hexesForLabelsInRange(terrain, cx, cy, radius, excludeKeys = null) {
  const out = [];
  for (const h of hexesWithinPixelRadius(cx, cy, radius)) {
    const key = axialKey(h.q, h.r);
    if (excludeKeys && excludeKeys.has(key)) continue;
    const id = terrain.get(key);
    if (id === undefined) continue;
    out.push({ key, q: h.q, r: h.r, id });
  }
  return out;
}
