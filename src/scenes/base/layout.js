// #509 Stage 1: the hand-authored central-base map — a small, FIXED hex layout (not
// procedurally generated; see data/worldgen.js for the arena's own generator), walkable
// end-to-end in a few seconds. Deliberately minimal for this first pass: one flat disc of
// open ground with two functional hexes — CUSTOMIZATION_HEX opens GarageScene, SCANNER_HEX is
// a placeholder that quick-deploys straight to ArenaScene until #510 (Stage 2) gives it a real
// mission-select surface. A third (repair/restock) hex is deliberately deferred past this stage.
import { range, axialKey } from '../../data/hexgrid.js';

export const BASE_RADIUS = 5;
export const CUSTOMIZATION_HEX = { q: -3, r: 0 };
export const SCANNER_HEX = { q: 3, r: 0 };

// hexKey → the action BaseScene dispatches when the player's OWN hex changes onto it.
export const BASE_TRIGGERS = new Map([
  [axialKey(CUSTOMIZATION_HEX.q, CUSTOMIZATION_HEX.r), 'customization'],
  [axialKey(SCANNER_HEX.q, SCANNER_HEX.r), 'scanner'],
]);

// A flat disc of `baseYard` — the same paved compound-floor terrain the arena's own enemy
// bases use (data/terrain.js), so this reads as an actual built facility (concrete apron, #288)
// rather than an open field. No biome, no hazards, no walls.
export function buildBaseTerrain() {
  const terrain = new Map();
  for (const { q, r } of range({ q: 0, r: 0 }, BASE_RADIUS)) terrain.set(axialKey(q, r), 'baseYard');
  return terrain;
}
