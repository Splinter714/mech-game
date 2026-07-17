// Biome registry (#67): the data-driven set of battlefields the world generator can build.
// Each biome reuses the SAME terrain ROLES as the original grassland — it just remaps each
// role to biome-specific terrain ids (from terrain.js) and tunes a few generation knobs. The
// world mixin (`scenes/arena/world.js`) reads a biome purely through these role fields, so
// adding a biome is ONE entry here (+ its terrain ids + textures), never an if/else in the
// generator.
//
// Roles (mirror the grassland's terrain mix):
//   groundA / groundB — the checkered open floor (open, fast).
//   channel           — the winding "river" strip: passable but usually slowing (or a fast
//                       road in the city). Non-LOS-blocking.
//   deep              — the impassable "lake" terrain id. #110: RESERVED EXCLUSIVELY for the
//                       world's outer boundary ring (see data/worldgen.js `boundaryRingKeys` +
//                       scenes/arena/world.js `_buildWorld`) — never spawned as an in-map
//                       feature anymore. Every biome still declares one (impassable, so it
//                       reads as "the edge of the world"), it just isn't stamped mid-map.
//   hazard            — #110: the LESSER in-map hazard that replaces `deep` as an actual
//                       mid-map feature. Passable (just slow/dangerous), unlike `deep`. `null`
//                       means this biome doesn't need one (grassland: its `channel`, a shallow
//                       river, already covers the "watch your footing" role — see `hasHazard`).
//   cover             — scattered walk-through cover clusters (forest analog: passable, slow,
//                       blocks LOS).
//   outpost           — the destructible hard-cover building for this biome.
// Generation knobs:
//   coverClusters     — multiplier on how many cover clusters to seed (1 = grassland default).
//   outposts          — how many destructible outpost clusters to seed.
//   hasChannel        — draw the winding channel strip.
//   hasHazard         — #110 (was `hasDeep`): grow an in-map blob of `hazard` (not `deep` — see
//                       above). false for grassland, since its channel already serves the role.
// This module is Phaser-free and unit-tested; textures live in art/hexArt.js.

export const BIOMES = {
  grassland: {
    id: 'grassland',
    name: 'Grassland',
    groundA: 'grass', groundB: 'grassB',
    channel: 'river',       // already the "shallow water" analog — no separate in-map hazard needed
    deep: 'deepWater',      // #110: boundary-only now (was also an in-map lake blob)
    hazard: null,
    cover: 'forest',
    outpost: 'building',
    coverClusters: 1, outposts: 4, hasChannel: true, hasHazard: false,
  },

  desert: {
    id: 'desert',
    name: 'Desert / Badlands',
    groundA: 'sand', groundB: 'sandB',
    channel: 'dryRiver',   // a cracked dry riverbed instead of flowing water
    deep: 'mesa',          // #110: boundary-only — impassable rock buttes mark the world's edge
    hazard: 'quicksand',   // #110: the in-map lesser hazard — passable but heavily slowing
    cover: 'scrub',        // sparse brush cover
    outpost: 'adobe',
    coverClusters: 0.7, outposts: 4, hasChannel: true, hasHazard: true,
  },

  arctic: {
    id: 'arctic',
    name: 'Snow / Arctic',
    groundA: 'snow', groundB: 'snowB',
    channel: 'slush',      // half-frozen melt channel
    deep: 'ice',           // #110: boundary-only — a solid frozen lake marks the world's edge
    hazard: 'brokenIce',   // #110: the in-map lesser hazard — thin/cracked ice, passable but slow
    cover: 'drift',        // snowdrifts / frozen pines
    outpost: 'iceRuin',
    coverClusters: 1, outposts: 3, hasChannel: true, hasHazard: true,
  },

  urban: {
    id: 'urban',
    name: 'Urban Ruins',
    groundA: 'pavement', groundB: 'pavementB',
    channel: 'road',       // a fast paved lane instead of a river
    deep: 'collapsed',     // #110: boundary-only — a collapsed-tower heap marks the world's edge
    hazard: 'debris',      // #110: the in-map lesser hazard — a rubble-strewn street, slow but passable
    cover: 'wreck',        // burned-out wreckage / low walls
    outpost: 'tower',
    coverClusters: 1.6, outposts: 8, hasChannel: true, hasHazard: true, // dense destructible cover
  },

  volcanic: {
    id: 'volcanic',
    name: 'Volcanic Wasteland',
    groundA: 'ash', groundB: 'ashB',
    channel: 'crust',      // a cooling lava-crust flow
    // #110: molten lava reads fine as EITHER an occasional in-map pool or the world boundary
    // (Jackson: "lava could work for lava map") — but for consistency with every other biome
    // (whose severe hazard is boundary-only) `deep`/lava is reserved for the boundary ring, and
    // volcanic gets its own lesser in-map hazard (`cinderField`) like the rest. Judgment call:
    // keeping ONE rule ("deep is always boundary-only, hazard is always the in-map one") is
    // simpler to reason about and test than special-casing volcanic to double up lava's role.
    deep: 'lava',          // boundary-only
    hazard: 'cinderField', // #110: the in-map lesser hazard — hot ash/embers, passable but slow
    cover: 'fumarole',     // ash dunes / smoke plumes
    outpost: 'obsidian',
    coverClusters: 0.9, outposts: 4, hasChannel: true, hasHazard: true,
  },
};

// Ordered id list — stable order for a per-deploy / per-stage pick.
export const BIOME_IDS = Object.keys(BIOMES);

// The default biome the arena builds when none is chosen.
export const DEFAULT_BIOME = 'grassland';

// Resolve a biome by id, falling back to the default. Keeps callers branch-free.
export function getBiome(id) {
  return BIOMES[id] ?? BIOMES[DEFAULT_BIOME];
}

// #217: per-deploy biome selection. The FIRST deploy of a session is uniformly random across
// every biome (no fixed grassland) — call with an empty `history`. Every deploy after that
// de-emphasizes recently-seen biomes (a repeat map back-to-back reads as repetitive) without
// ever making one truly impossible to redraw, via a weighted random draw.
//
// `history` is a short rolling log of the last few biome ids actually picked, OLDEST FIRST
// (caller just appends and keeps the last RECENCY_WINDOW entries — see GarageScene.deploy()).
// Only the last RECENCY_WINDOW entries matter; anything picked longer ago than that is back to
// full weight. `rng` is injectable (defaults to Math.random) so the weighting curve itself is
// unit-testable without depending on real randomness.
//
// Weighting curve: a biome's weight ramps linearly from MIN_WEIGHT (just picked last deploy)
// up to 1 (not seen in RECENCY_WINDOW+ deploys). MIN_WEIGHT is > 0 so a just-seen biome is
// heavily de-emphasized, never excluded — "less likely, never impossible," per the design ask.
export const RECENCY_WINDOW = 4;
const MIN_WEIGHT = 0.15;

export function pickNextBiome(history = [], rng = Math.random) {
  if (!history.length) {
    // First deploy of the session (or any time the caller has no history yet): plain uniform
    // pick, no fixed starting biome.
    return BIOME_IDS[Math.floor(rng() * BIOME_IDS.length)];
  }
  const recent = history.slice(-RECENCY_WINDOW);   // oldest-first; only the tail matters
  const weights = BIOME_IDS.map((id) => {
    // Index from the END of the recent window: 0 = picked last deploy, RECENCY_WINDOW-1 =
    // picked as long ago as this window still tracks. Not found at all -> full weight.
    const idxFromEnd = [...recent].reverse().indexOf(id);
    if (idxFromEnd === -1 || idxFromEnd >= RECENCY_WINDOW) return 1;
    const t = idxFromEnd / RECENCY_WINDOW;
    return MIN_WEIGHT + (1 - MIN_WEIGHT) * t;
  });
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < BIOME_IDS.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return BIOME_IDS[i];
  }
  return BIOME_IDS[BIOME_IDS.length - 1];   // float-rounding fallback
}
