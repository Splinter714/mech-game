// Hex terrain types: the data-driven palette of what a battlefield tile can be. Each entry
// pairs a procedural art texture (built in art/hexArt.js) with gameplay properties:
//   passable    — can the mech drive onto it
//   blocksLOS   — does it stop shots / break line-of-sight (cover)
//   speedFactor — max-speed multiplier for a mech standing on it (1 = normal; <1 = slow;
//                 only meaningful for passable terrain)
//   destructible — outposts have HP and turn into `rubble` when destroyed (weapon fire or a
//                 mech stomp). `hp` is the starting hit points seeded per building hex.
// Adding a terrain type is one entry here + a matching texture. (Future: an external,
// possibly AI-generated, tileset can register more here.) See issue #41.

export const TERRAIN = {
  grass:     { id: 'grass',     tex: 'hex_grass',     passable: true,  blocksLOS: false, speedFactor: 1 },
  grassB:    { id: 'grassB',    tex: 'hex_grassB',    passable: true,  blocksLOS: false, speedFactor: 1 },
  // Shallow winding river: drive through it, but it SLOWS the mech; shoot over it (no LOS block).
  river:     { id: 'river',     tex: 'hex_river',     passable: true,  blocksLOS: false, speedFactor: 0.5 },
  // Deep water (lake/ocean): impassable; still shoot over it (no LOS block).
  deepWater: { id: 'deepWater', tex: 'hex_deepWater', passable: false, blocksLOS: false },
  // Forest: walk-through cover — passable but slowing, and it hides you (blocks LOS).
  forest:    { id: 'forest',    tex: 'hex_forest',    passable: true,  blocksLOS: true,  speedFactor: 0.6 },
  // Outpost building: hard cover you can DESTROY (weapon fire or a stomp) → collapses to rubble.
  building:  { id: 'building',  tex: 'hex_building',  passable: false, blocksLOS: true,  destructible: true, hp: 60, rubbleId: 'rubble' },
  // Rubble: what a destroyed building leaves behind — passable, no cover, mild slow (debris).
  rubble:    { id: 'rubble',    tex: 'hex_rubble',    passable: true,  blocksLOS: false, speedFactor: 0.8 },

  // ── Desert / badlands (#67) — warm sandy palette. Reuses the same ROLES as grassland. ──
  sand:      { id: 'sand',      tex: 'hex_sand',      passable: true,  blocksLOS: false, speedFactor: 1 },
  sandB:     { id: 'sandB',     tex: 'hex_sandB',     passable: true,  blocksLOS: false, speedFactor: 1 },
  // Dry riverbed: the "shallow river" analog — cracked bed, drive-through but slowing.
  dryRiver:  { id: 'dryRiver',  tex: 'hex_dryRiver',  passable: true,  blocksLOS: false, speedFactor: 0.7 },
  // Mesa: a natural rock butte — the impassable deep-water analog, but it ALSO blocks LOS (tall).
  mesa:      { id: 'mesa',      tex: 'hex_mesa',      passable: false, blocksLOS: true },
  // Scrub: sparse desert brush — walk-through cover (passable + slowing + blocks LOS), like forest.
  scrub:     { id: 'scrub',     tex: 'hex_scrub',     passable: true,  blocksLOS: true,  speedFactor: 0.7 },
  // Adobe outpost: destructible hard cover, the desert building.
  adobe:     { id: 'adobe',     tex: 'hex_adobe',     passable: false, blocksLOS: true,  destructible: true, hp: 60, rubbleId: 'sandRubble' },
  sandRubble:{ id: 'sandRubble',tex: 'hex_sandRubble',passable: true,  blocksLOS: false, speedFactor: 0.8 },

  // ── Snow / arctic (#67) — cold white/blue palette. ──
  snow:      { id: 'snow',      tex: 'hex_snow',      passable: true,  blocksLOS: false, speedFactor: 0.85 },
  snowB:     { id: 'snowB',     tex: 'hex_snowB',     passable: true,  blocksLOS: false, speedFactor: 0.85 },
  // Slush: half-frozen melt — the shallow-water analog (passable, slowing, shoot over).
  slush:     { id: 'slush',     tex: 'hex_slush',     passable: true,  blocksLOS: false, speedFactor: 0.5 },
  // Ice: solid frozen lake — the impassable deep-water analog (you can shoot over it).
  ice:       { id: 'ice',       tex: 'hex_ice',       passable: false, blocksLOS: false },
  // Snowdrift / frozen pines: walk-through cover (passable + slowing + LOS block).
  drift:     { id: 'drift',     tex: 'hex_drift',     passable: true,  blocksLOS: true,  speedFactor: 0.6 },
  // Frozen outpost: destructible hard cover.
  iceRuin:   { id: 'iceRuin',   tex: 'hex_iceRuin',   passable: false, blocksLOS: true,  destructible: true, hp: 60, rubbleId: 'snowRubble' },
  snowRubble:{ id: 'snowRubble',tex: 'hex_snowRubble',passable: true,  blocksLOS: false, speedFactor: 0.8 },

  // ── Urban ruins (#67) — grey industrial palette; dense destructible cover + roads. ──
  pavement:  { id: 'pavement',  tex: 'hex_pavement',  passable: true,  blocksLOS: false, speedFactor: 1 },
  pavementB: { id: 'pavementB', tex: 'hex_pavementB', passable: true,  blocksLOS: false, speedFactor: 1 },
  // Road: a fast lane — the "river channel" analog, but open (no slow); reads as a paved strip.
  road:      { id: 'road',      tex: 'hex_road',      passable: true,  blocksLOS: false, speedFactor: 1 },
  // Collapsed tower: an impassable+LOS-blocking heap (the deep-water/mesa analog for the city).
  collapsed: { id: 'collapsed', tex: 'hex_collapsed', passable: false, blocksLOS: true },
  // Wreckage: burned-out vehicles / low wall — walk-through cover (passable + slow + LOS).
  wreck:     { id: 'wreck',     tex: 'hex_wreck',     passable: true,  blocksLOS: true,  speedFactor: 0.65 },
  // Intact building: destructible hard cover (dense in this biome).
  tower:     { id: 'tower',     tex: 'hex_tower',     passable: false, blocksLOS: true,  destructible: true, hp: 60, rubbleId: 'cityRubble' },
  cityRubble:{ id: 'cityRubble',tex: 'hex_cityRubble',passable: true,  blocksLOS: false, speedFactor: 0.8 },

  // ── Volcanic wasteland (#67) — dark/ember palette; lava hazards + ash fields. ──
  ash:       { id: 'ash',       tex: 'hex_ash',       passable: true,  blocksLOS: false, speedFactor: 0.9 },
  ashB:      { id: 'ashB',      tex: 'hex_ashB',      passable: true,  blocksLOS: false, speedFactor: 0.9 },
  // Cooling lava crust: a hot crackled flow — passable but slowing (the shallow analog).
  crust:     { id: 'crust',     tex: 'hex_crust',     passable: true,  blocksLOS: false, speedFactor: 0.6 },
  // Molten lava: impassable hazard (the deep-water analog); you can shoot over it.
  lava:      { id: 'lava',      tex: 'hex_lava',      passable: false, blocksLOS: false },
  // Ash dunes / smoke plumes: walk-through cover (passable + slow + LOS block).
  fumarole:  { id: 'fumarole',  tex: 'hex_fumarole',  passable: true,  blocksLOS: true,  speedFactor: 0.65 },
  // Obsidian outpost: destructible hard cover.
  obsidian:  { id: 'obsidian',  tex: 'hex_obsidian',  passable: false, blocksLOS: true,  destructible: true, hp: 60, rubbleId: 'ashRubble' },
  ashRubble: { id: 'ashRubble', tex: 'hex_ashRubble', passable: true,  blocksLOS: false, speedFactor: 0.8 },
};

export function getTerrain(id) {
  return TERRAIN[id] ?? TERRAIN.grass;
}

// ── Pure property resolvers (read by collision, LOS, and the movement speed penalty) ──────
// `id` may be undefined (a point outside the arena disc); callers decide what that means.

// Max-speed multiplier of the terrain under a mech. Unknown / off-map ⇒ 1 (the caller handles
// impassability separately). Terrain with no speedFactor is normal (1).
export function terrainSpeedFactor(id) {
  if (!id) return 1;
  const t = TERRAIN[id];
  return t ? (t.speedFactor ?? 1) : 1;
}

// Can a mech stand on this terrain? Unknown / off-map ⇒ false (off the arena disc = blocked).
export function isPassable(id) {
  const t = id && TERRAIN[id];
  return !!t && t.passable;
}

// Does this terrain break line-of-sight (cover / projectile blocker)? Unknown ⇒ false.
export function blocksLOS(id) {
  const t = id && TERRAIN[id];
  return !!t && t.blocksLOS;
}

// Is this a destructible outpost (has HP, becomes rubble when destroyed)?
export function isDestructible(id) {
  const t = id && TERRAIN[id];
  return !!t && !!t.destructible;
}

// Starting hit points for a freshly-seeded destructible hex (0 for non-destructible terrain).
export function buildingHp(id) {
  const t = id && TERRAIN[id];
  return t && t.destructible ? (t.hp ?? 0) : 0;
}

// The default terrain id a destroyed building collapses into (grassland biome).
export const RUBBLE = 'rubble';

// The terrain id a given destructible collapses into — its biome-appropriate rubble
// (declared per destructible as `rubbleId`). Falls back to the default `RUBBLE`. Keeps the
// world mixin free of biome branches: it just asks "what does this outpost leave behind?".
export function rubbleFor(id) {
  const t = id && TERRAIN[id];
  return (t && t.rubbleId) || RUBBLE;
}

// Apply `amount` damage to a building hex's current `hp`. Pure: returns the remaining hp and
// whether the hit destroyed it (hp fell to 0 or below). The scene owns the hp Map + the terrain
// swap-to-rubble; this keeps the arithmetic testable.
export function damageBuilding(hp, amount) {
  const remaining = Math.max(0, hp - Math.max(0, amount));
  return { hp: remaining, destroyed: remaining <= 0 };
}
