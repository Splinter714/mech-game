// Hex terrain types: the data-driven palette of what a battlefield tile can be. Each entry
// pairs a procedural art texture (built in art/hexArt.js) with gameplay properties:
//   passable   — can the mech drive onto it
//   blocksLOS  — does it stop shots / break line-of-sight (cover)
// Adding a terrain type is one entry here + a matching texture. (Future: an external,
// possibly AI-generated, tileset can register more here.) See issue #41.

export const TERRAIN = {
  grass:    { id: 'grass',    tex: 'hex_grass',    passable: true,  blocksLOS: false },
  grassB:   { id: 'grassB',   tex: 'hex_grassB',   passable: true,  blocksLOS: false },
  water:    { id: 'water',    tex: 'hex_water',    passable: false, blocksLOS: false }, // shoot OVER a river
  forest:   { id: 'forest',   tex: 'hex_forest',   passable: false, blocksLOS: true  }, // dense trees = cover
  building: { id: 'building', tex: 'hex_building', passable: false, blocksLOS: true  }, // outpost = hard cover
};

export function getTerrain(id) {
  return TERRAIN[id] ?? TERRAIN.grass;
}
