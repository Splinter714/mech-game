// Arena world mixin — terrain generation + the world queries everything else reads
// (terrain lookup, wall/LOS test, passability, ray-to-wall distance). Methods use `this`
// (the ArenaScene); composed onto the scene prototype via Object.assign.
import { ART_SCALE } from '../../art/index.js';
import { hexToPixel, pixelToHex, range, axialKey, neighbors } from '../../data/hexgrid.js';
import { getTerrain } from '../../data/terrain.js';
import { DUMMY_HEX } from './shared.js';

export const WorldMixin = {
  // Generate a large natural battlefield (#41): a big grass disc with a winding river,
  // scattered forest clusters, and a few industrial outposts to roam through. Terrain is
  // kept in `this.terrain` (hexKey → terrain id); collision + line-of-sight read its
  // passable/blocksLOS props. Seeded so the layout is deterministic.
  _buildWorld() {
    this.worldRadius = 20;
    const R = this.worldRadius;
    const rng = mulberry32(0x5eed);
    const all = range({ q: 0, r: 0 }, R);
    const T = new Map();
    const isGrass = (k) => { const t = T.get(k); return t === 'grass' || t === 'grassB'; };

    // Base: a checkered grass field.
    for (const h of all) T.set(axialKey(h.q, h.r), (h.q + h.r) % 2 ? 'grassB' : 'grass');

    // River: a winding water course sweeping across the map (impassable, but shoot over it).
    for (let q = -R + 2; q <= R - 2; q++) {
      const r = Math.round(7 * Math.sin(q * 0.26) + 3 * Math.sin(q * 0.11));
      for (const dr of [0, 1]) { const k = axialKey(q, r + dr); if (T.has(k)) T.set(k, 'water'); }
    }

    // Forest clusters scattered across the field (seed + organic neighbour growth) — cover.
    for (let i = 0; i < Math.round(R * 2.2); i++) {
      const c = all[Math.floor(rng() * all.length)];
      const k0 = axialKey(c.q, c.r);
      if (!isGrass(k0)) continue;
      T.set(k0, 'forest');
      for (const n of neighbors(c.q, c.r)) {
        const k = axialKey(n.q, n.r);
        if (isGrass(k) && rng() < 0.6) T.set(k, 'forest');
      }
    }

    // A few industrial outposts (building clusters) — hard cover.
    for (let i = 0; i < 4; i++) {
      const c = all[Math.floor(rng() * all.length)];
      for (const h of [c, ...neighbors(c.q, c.r).filter(() => rng() < 0.55)]) {
        const k = axialKey(h.q, h.r); if (T.has(k)) T.set(k, 'building');
      }
    }

    // Clear the centre (spawns + line of fire) back to open grass.
    for (const h of range({ q: 0, r: 0 }, 3)) T.set(axialKey(h.q, h.r), (h.q + h.r) % 2 ? 'grassB' : 'grass');
    T.set('0,0', 'grass');
    T.set(axialKey(DUMMY_HEX.q, DUMMY_HEX.r), 'grass');

    this.terrain = T;
    for (const [k, id] of T) {
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      this.add.image(x, y, getTerrain(id).tex).setScale(1 / ART_SCALE);
    }
  },

  // Terrain id at a world point (undefined = outside the arena disc).
  _terrainAt(x, y) {
    const h = pixelToHex(x, y);
    return this.terrain.get(axialKey(h.q, h.r));
  },

  // Does a world point block line-of-sight (cover / projectile blocker)? Forest + buildings
  // do; open grass + water do not (you can shoot over a river).
  _isWall(x, y) {
    const t = this._terrainAt(x, y);
    return !!t && getTerrain(t).blocksLOS;
  },

  // Is a world point impassable for the mech — non-passable terrain, or off the arena disc?
  _blocked(x, y) {
    const t = this._terrainAt(x, y);
    return !t || !getTerrain(t).passable;
  },

  // Distance from a muzzle along an angle to the first wall, or Infinity if clear within
  // `maxT`. Used so beams/shots are blocked by cover.
  _wallDistance(x0, y0, angle, maxT) {
    const cx = Math.cos(angle), cy = Math.sin(angle);
    for (let t = 8; t < maxT; t += 8) {
      if (this._isWall(x0 + cx * t, y0 + cy * t)) return t;
    }
    return Infinity;
  },
};

// Small seeded PRNG (mulberry32) so the generated map is deterministic.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
