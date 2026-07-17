// Hex terrain types: the data-driven palette of what a battlefield tile can be. Each entry
// pairs a procedural art texture (built in art/hexArt.js) with gameplay properties:
//   passable    — can the mech drive onto it
//   blocksLOS   — does it stop shots / break line-of-sight (cover)
//   speedFactor — max-speed multiplier for a mech standing on it (1 = normal; <1 = slow;
//                 only meaningful for passable terrain)
//   destructible — outposts have HP and turn into `rubble` when destroyed (weapon fire or a
//                 mech stomp). `hp` is the starting hit points seeded per building hex.
//   water        — #151: reads visually as actual water (or its frozen/melt equivalent) — NOT
//                 just "slow terrain in general" (forest/scrub/debris/dryRiver/quicksand/crust/
//                 cinderField are all slow but read as earth/ash/rock, not water). Passable water
//                 is meant to be waded by mechs/vehicles, but small ground units (see enemyKinds.js
//                 `avoidWater`) shouldn't voluntarily choose one as an idle-wander destination —
//                 see `isWaterTerrain` below. Marked per-entry rather than inferred from biome
//                 roles because a biome's `channel`/`hazard` role isn't reliably water (desert's
//                 channel is a DRY riverbed; urban's is a paved road; volcanic's is a lava crust).
//
// #72 soft cover: terrain that is BOTH passable and LOS-blocking (forest/scrub/drift/wreck/
// fumarole) is "soft cover" — a unit can stand inside it. Two special rules apply, both driven
// purely by the passable+blocksLOS combination (no extra flag to keep in sync):
//   1. Own-hex transparency: a soft-cover hex does NOT protect its own occupant — shots treat
//      the target's (and the shooter's muzzle's) own hex as see-through (`shotBlockedAt`).
//      Deeper soft-cover hexes between shooter and target still block. Solid cover always blocks.
//   2. Destructible + burnable: soft cover has HP (less than an outpost's 60) so gunfire chews
//      firing lanes through it, and FLAME damage (flamethrower gouts, napalm ground fire) is
//      multiplied by FLAME_COVER_MULT so incendiaries are the premier forest-clearing tool.
//      At 0 HP the hex flattens to its biome's cleared/rubble terrain (`rubbleId`), same
//      machinery as a collapsing outpost.
// Adding a terrain type is one entry here + a matching texture. (Future: an external,
// possibly AI-generated, tileset can register more here.) See issue #41.

export const TERRAIN = {
  grass:     { id: 'grass',     tex: 'hex_grass',     passable: true,  blocksLOS: false, speedFactor: 1 },
  grassB:    { id: 'grassB',    tex: 'hex_grassB',    passable: true,  blocksLOS: false, speedFactor: 1 },
  // Shallow winding river: drive through it, but it SLOWS the mech; shoot over it (no LOS block).
  river:     { id: 'river',     tex: 'hex_river',     passable: true,  blocksLOS: false, speedFactor: 0.5, water: true },
  // Deep water (lake/ocean): impassable; still shoot over it (no LOS block).
  deepWater: { id: 'deepWater', tex: 'hex_deepWater', passable: false, blocksLOS: false, water: true },
  // Forest: walk-through cover — passable but slowing, and it hides you (blocks LOS).
  // #227: its OWN rubble (charred plant debris) distinct from a destroyed building's masonry.
  forest:    { id: 'forest',    tex: 'hex_forest',    passable: true,  blocksLOS: true,  speedFactor: 0.6,  destructible: true, hp: 40, rubbleId: 'vegRubble' },
  // Outpost building: hard cover you can DESTROY (weapon fire or a stomp) → collapses to rubble.
  building:  { id: 'building',  tex: 'hex_building',  passable: false, blocksLOS: true,  destructible: true, hp: 60, rubbleId: 'rubble' },
  // Rubble: what a destroyed building leaves behind — broken masonry chunks, passable, no cover, mild slow.
  rubble:    { id: 'rubble',    tex: 'hex_rubble',    passable: true,  blocksLOS: false, speedFactor: 0.8 },
  // #227: what a destroyed forest hex leaves behind — charred plant debris, visually distinct
  // from the building's broken-masonry rubble even though both are passable/no-cover.
  vegRubble: { id: 'vegRubble', tex: 'hex_vegRubble', passable: true,  blocksLOS: false, speedFactor: 0.8 },
  // #251: helipad ground marking — static base-infrastructure set-dressing, stamped into the
  // map like any other feature (a couple per generated layout — see worldgen.js `HELIPAD_COUNT`)
  // at world-gen time, biome-independent. NOT tied to any enemy spawn: a helicopter kind's own
  // offscreen spawn logic is completely independent of where a helipad happens to sit. Fully
  // walkable/flyable — a subtle ground detail, not an obstacle or cover — so it never blocks
  // movement or LOS and never slows a mech crossing it, and it isn't destructible (no HP).
  helipad:   { id: 'helipad',   tex: 'hex_helipad',   passable: true,  blocksLOS: false, speedFactor: 1 },

  // ── Desert / badlands (#67) — warm sandy palette. Reuses the same ROLES as grassland. ──
  sand:      { id: 'sand',      tex: 'hex_sand',      passable: true,  blocksLOS: false, speedFactor: 1 },
  sandB:     { id: 'sandB',     tex: 'hex_sandB',     passable: true,  blocksLOS: false, speedFactor: 1 },
  // Dry riverbed: the "shallow river" analog — cracked bed, drive-through but slowing.
  dryRiver:  { id: 'dryRiver',  tex: 'hex_dryRiver',  passable: true,  blocksLOS: false, speedFactor: 0.7 },
  // Mesa: a natural rock butte — the impassable deep-water analog, boundary-only (#221: no LOS
  // block, matching deepWater/ice/lava — it never appears in-map so this only affects the
  // world-edge ring, and shooting over the boundary should behave like the other 3 biomes).
  mesa:      { id: 'mesa',      tex: 'hex_mesa',      passable: false, blocksLOS: false },
  // Scrub: sparse desert brush — walk-through cover (passable + slowing + blocks LOS), like forest.
  // #227: its own rubble (scattered dead scrub) distinct from adobe's rubble.
  scrub:     { id: 'scrub',     tex: 'hex_scrub',     passable: true,  blocksLOS: true,  speedFactor: 0.7,  destructible: true, hp: 30, rubbleId: 'scrubRubble' },
  // Adobe outpost: destructible hard cover, the desert building.
  adobe:     { id: 'adobe',     tex: 'hex_adobe',     passable: false, blocksLOS: true,  destructible: true, hp: 60, rubbleId: 'sandRubble' },
  sandRubble:{ id: 'sandRubble',tex: 'hex_sandRubble',passable: true,  blocksLOS: false, speedFactor: 0.8 },
  // #227: what a destroyed scrub hex leaves behind — scattered dead brush, distinct from adobe's rubble.
  scrubRubble:{ id: 'scrubRubble', tex: 'hex_scrubRubble', passable: true, blocksLOS: false, speedFactor: 0.8 },
  // #110: quicksand — the desert's LESSER in-map hazard, standing in for 'mesa' now that mesa
  // is reserved exclusively for the world boundary. Passable but heavily slowing; no LOS block
  // (you sink, you don't hide).
  quicksand: { id: 'quicksand', tex: 'hex_quicksand', passable: true,  blocksLOS: false, speedFactor: 0.35 },

  // ── Snow / arctic (#67) — cold white/blue palette. ──
  snow:      { id: 'snow',      tex: 'hex_snow',      passable: true,  blocksLOS: false, speedFactor: 0.85 },
  snowB:     { id: 'snowB',     tex: 'hex_snowB',     passable: true,  blocksLOS: false, speedFactor: 0.85 },
  // Slush: half-frozen melt — the shallow-water analog (passable, slowing, shoot over).
  slush:     { id: 'slush',     tex: 'hex_slush',     passable: true,  blocksLOS: false, speedFactor: 0.5, water: true },
  // Ice: solid frozen lake — the impassable deep-water analog (you can shoot over it).
  ice:       { id: 'ice',       tex: 'hex_ice',       passable: false, blocksLOS: false, water: true },
  // Snowdrift / frozen pines: walk-through cover (passable + slowing + LOS block).
  // #227: its own rubble (broken ice/snow drift chunks) distinct from iceRuin's rubble.
  drift:     { id: 'drift',     tex: 'hex_drift',     passable: true,  blocksLOS: true,  speedFactor: 0.6,  destructible: true, hp: 30, rubbleId: 'driftRubble' },
  // Frozen outpost: destructible hard cover.
  iceRuin:   { id: 'iceRuin',   tex: 'hex_iceRuin',   passable: false, blocksLOS: true,  destructible: true, hp: 60, rubbleId: 'snowRubble' },
  snowRubble:{ id: 'snowRubble',tex: 'hex_snowRubble',passable: true,  blocksLOS: false, speedFactor: 0.8 },
  // #227: what a destroyed snowdrift hex leaves behind — shattered ice/snow chunks, distinct
  // from iceRuin's rubble.
  driftRubble:{ id: 'driftRubble', tex: 'hex_driftRubble', passable: true, blocksLOS: false, speedFactor: 0.8 },
  // #110: broken ice — the arctic's LESSER in-map hazard, standing in for solid 'ice' now that
  // ice is reserved exclusively for the world boundary. Passable but slow (thin/cracked ice);
  // no LOS block. #151: still reads as water (cold water visible through the cracks).
  brokenIce: { id: 'brokenIce', tex: 'hex_brokenIce', passable: true,  blocksLOS: false, speedFactor: 0.4, water: true },

  // ── Urban ruins (#67) — grey industrial palette; dense destructible cover + roads. ──
  pavement:  { id: 'pavement',  tex: 'hex_pavement',  passable: true,  blocksLOS: false, speedFactor: 1 },
  pavementB: { id: 'pavementB', tex: 'hex_pavementB', passable: true,  blocksLOS: false, speedFactor: 1 },
  // Road: a fast lane — the "river channel" analog, but open (no slow); reads as a paved strip.
  road:      { id: 'road',      tex: 'hex_road',      passable: true,  blocksLOS: false, speedFactor: 1 },
  // Collapsed tower: an impassable heap (the deep-water/mesa analog for the city), boundary-only
  // (#221: no LOS block, matching deepWater/ice/lava — it never appears in-map).
  collapsed: { id: 'collapsed', tex: 'hex_collapsed', passable: false, blocksLOS: false },
  // Wreckage: burned-out vehicles / low wall — walk-through cover (passable + slow + LOS).
  // #227: its own rubble (burnt debris scraps) distinct from a tower's masonry rubble.
  wreck:     { id: 'wreck',     tex: 'hex_wreck',     passable: true,  blocksLOS: true,  speedFactor: 0.65, destructible: true, hp: 40, rubbleId: 'wreckRubble' },
  // Intact building: destructible hard cover (dense in this biome).
  tower:     { id: 'tower',     tex: 'hex_tower',     passable: false, blocksLOS: true,  destructible: true, hp: 60, rubbleId: 'cityRubble' },
  cityRubble:{ id: 'cityRubble',tex: 'hex_cityRubble',passable: true,  blocksLOS: false, speedFactor: 0.8 },
  // #227: what a destroyed wreck hex leaves behind — burnt debris scraps, distinct from a
  // collapsed tower's masonry rubble.
  wreckRubble:{ id: 'wreckRubble', tex: 'hex_wreckRubble', passable: true, blocksLOS: false, speedFactor: 0.8 },
  // #110: debris field — the urban biome's LESSER in-map hazard, standing in for 'collapsed'
  // now that a collapsed heap is reserved exclusively for the world boundary. Passable but
  // slow (a rubble-strewn street); no LOS block.
  debris:    { id: 'debris',    tex: 'hex_debris',    passable: true,  blocksLOS: false, speedFactor: 0.45 },

  // ── Volcanic wasteland (#67) — dark/ember palette; lava hazards + ash fields. ──
  ash:       { id: 'ash',       tex: 'hex_ash',       passable: true,  blocksLOS: false, speedFactor: 0.9 },
  ashB:      { id: 'ashB',      tex: 'hex_ashB',      passable: true,  blocksLOS: false, speedFactor: 0.9 },
  // Cooling lava crust: a hot crackled flow — passable but slowing (the shallow analog).
  crust:     { id: 'crust',     tex: 'hex_crust',     passable: true,  blocksLOS: false, speedFactor: 0.6 },
  // Molten lava: impassable hazard (the deep-water analog); you can shoot over it.
  lava:      { id: 'lava',      tex: 'hex_lava',      passable: false, blocksLOS: false },
  // Ash dunes / smoke plumes: walk-through cover (passable + slow + LOS block).
  // #227: its own rubble (loose ash/cinder scatter) distinct from an obsidian outpost's rubble.
  fumarole:  { id: 'fumarole',  tex: 'hex_fumarole',  passable: true,  blocksLOS: true,  speedFactor: 0.65, destructible: true, hp: 30, rubbleId: 'fumaroleRubble' },
  // Obsidian outpost: destructible hard cover.
  obsidian:  { id: 'obsidian',  tex: 'hex_obsidian',  passable: false, blocksLOS: true,  destructible: true, hp: 60, rubbleId: 'ashRubble' },
  ashRubble: { id: 'ashRubble', tex: 'hex_ashRubble', passable: true,  blocksLOS: false, speedFactor: 0.8 },
  // #227: what a destroyed fumarole hex leaves behind — loose ash/cinder scatter, distinct
  // from an obsidian outpost's broken-obsidian rubble.
  fumaroleRubble:{ id: 'fumaroleRubble', tex: 'hex_fumaroleRubble', passable: true, blocksLOS: false, speedFactor: 0.8 },
  // #110: cinder field — the volcanic biome's LESSER in-map hazard. Lava itself reads fine as
  // BOTH an occasional in-map pool AND the boundary (Jackson: "lava could work for lava map"),
  // but per-biome consistency (every other biome's severe hazard is boundary-only) this gives
  // volcanic its own lesser in-map danger too — a hot ash/cinder patch, passable but slow, no
  // LOS block — while 'lava' itself is reserved for the boundary ring only (see biomes.js).
  cinderField: { id: 'cinderField', tex: 'hex_cinderField', passable: true, blocksLOS: false, speedFactor: 0.4 },
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

// #151: does this terrain read visually as actual water (river/deep water/slush/ice/broken ice
// across the 5 biomes) — as opposed to merely slow terrain in general (forest, dryRiver,
// quicksand, debris, crust, cinderField, etc.)? Driven purely by the `water` flag above so this
// stays a single per-entry fact rather than an id list duplicated at every call site. Used to
// keep small ground units (infantry) from voluntarily choosing a water hex as an idle-wander
// destination, while still allowing them to be physically forced across passable water (a river
// is still `passable`, just not a picked as a *destination*).
export function isWaterTerrain(id) {
  const t = id && TERRAIN[id];
  return !!t && !!t.water;
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

// #72: soft cover — walk-through concealment (forest/scrub/drift/wreck/fumarole). Purely the
// passable+blocksLOS combination; there is no separate flag to keep in sync. Unknown ⇒ false.
export function isSoftCover(id) {
  const t = id && TERRAIN[id];
  return !!t && t.passable && t.blocksLOS;
}

// #72 own-hex transparency: does terrain `id` at hex `key` stop a shot, given a Set of hex
// keys treated as see-through for THIS shot (the shooter's muzzle hex + the target's own hex)?
// Soft cover doesn't protect its own occupant — a shot may enter/impact within an exempted
// soft-cover hex — but SOLID cover (buildings, adobe, towers) blocks regardless of exemption,
// and non-exempted soft-cover hexes between shooter and target still block ("deep woods"). The
// boundary-only impassable terrains (mesa/collapsed/deepWater/ice/lava) never block LOS at all
// (#221 — they're stamped only at the world's outer edge, never used as an in-map obstacle).
export function shotBlockedAt(id, key, transparent = null) {
  if (!blocksLOS(id)) return false;
  if (transparent && transparent.has(key) && isSoftCover(id)) return false;
  return true;
}

// #72 burnable cover: flame damage (flamethrower gouts, napalm rounds + ground fire) is
// multiplied against SOFT cover so incendiaries clear woods much faster than gunfire.
// Owner: tunable. Solid outposts take flame damage unmultiplied.
export const FLAME_COVER_MULT = 4;
export function flameCoverDamage(amount) {
  return amount * FLAME_COVER_MULT;
}

// Apply `amount` damage to a building hex's current `hp`. Pure: returns the remaining hp and
// whether the hit destroyed it (hp fell to 0 or below). The scene owns the hp Map + the terrain
// swap-to-rubble; this keeps the arithmetic testable.
export function damageBuilding(hp, amount) {
  const remaining = Math.max(0, hp - Math.max(0, amount));
  return { hp: remaining, destroyed: remaining <= 0 };
}
