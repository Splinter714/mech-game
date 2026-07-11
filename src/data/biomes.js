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
