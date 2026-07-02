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
//   deep              — the impassable "lake": a blob of terrain you can't drive onto.
//   cover             — scattered walk-through cover clusters (forest analog: passable, slow,
//                       blocks LOS).
//   outpost           — the destructible hard-cover building for this biome.
// Generation knobs:
//   coverClusters     — multiplier on how many cover clusters to seed (1 = grassland default).
//   outposts          — how many destructible outpost clusters to seed.
//   hasChannel        — draw the winding channel strip.
//   hasDeep           — grow the impassable deep blob.
// This module is Phaser-free and unit-tested; textures live in art/hexArt.js.

export const BIOMES = {
  grassland: {
    id: 'grassland',
    name: 'Grassland',
    groundA: 'grass', groundB: 'grassB',
    channel: 'river',
    deep: 'deepWater',
    cover: 'forest',
    outpost: 'building',
    coverClusters: 1, outposts: 4, hasChannel: true, hasDeep: true,
  },

  desert: {
    id: 'desert',
    name: 'Desert / Badlands',
    groundA: 'sand', groundB: 'sandB',
    channel: 'dryRiver',   // a cracked dry riverbed instead of flowing water
    deep: 'mesa',          // impassable rock buttes stand in for the lake
    cover: 'scrub',        // sparse brush cover
    outpost: 'adobe',
    coverClusters: 0.7, outposts: 4, hasChannel: true, hasDeep: true,
  },

  arctic: {
    id: 'arctic',
    name: 'Snow / Arctic',
    groundA: 'snow', groundB: 'snowB',
    channel: 'slush',      // half-frozen melt channel
    deep: 'ice',           // a solid frozen lake — the impassable analog
    cover: 'drift',        // snowdrifts / frozen pines
    outpost: 'iceRuin',
    coverClusters: 1, outposts: 3, hasChannel: true, hasDeep: true,
  },

  urban: {
    id: 'urban',
    name: 'Urban Ruins',
    groundA: 'pavement', groundB: 'pavementB',
    channel: 'road',       // a fast paved lane instead of a river
    deep: 'collapsed',     // a heap of collapsed towers you can't cross
    cover: 'wreck',        // burned-out wreckage / low walls
    outpost: 'tower',
    coverClusters: 1.6, outposts: 8, hasChannel: true, hasDeep: true, // dense destructible cover
  },

  volcanic: {
    id: 'volcanic',
    name: 'Volcanic Wasteland',
    groundA: 'ash', groundB: 'ashB',
    channel: 'crust',      // a cooling lava-crust flow
    deep: 'lava',          // molten lava — an impassable hazard
    cover: 'fumarole',     // ash dunes / smoke plumes
    outpost: 'obsidian',
    coverClusters: 0.9, outposts: 4, hasChannel: true, hasDeep: true,
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
