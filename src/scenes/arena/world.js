// Arena world mixin — terrain generation + the world queries everything else reads
// (terrain lookup, wall/LOS test, passability, ray-to-wall distance). Methods use `this`
// (the ArenaScene); composed onto the scene prototype via Object.assign.
import { ART_SCALE } from '../../art/index.js';
import { hexToPixel, pixelToHex, range, axialKey, neighbors } from '../../data/hexgrid.js';
import {
  getTerrain, terrainSpeedFactor, isPassable, blocksLOS, buildingHp, damageBuilding, rubbleFor,
} from '../../data/terrain.js';
import { getBiome, DEFAULT_BIOME } from '../../data/biomes.js';
import { Audio } from '../../audio/index.js';
import { DUMMY_HEX } from './shared.js';

// #41: how fast a mech crushes an outpost it's stomping (HP/sec at full drive-in speed). A
// building has 60 HP, so ~1.5–2s of leaning at speed flattens it. Owner: tunable.
const STOMP_DPS = 45;

export const WorldMixin = {
  // Generate a large natural battlefield (#41): a big grass disc with a winding SHALLOW river,
  // a distinct DEEP-water lake, walk-through forest clusters, and a few DESTRUCTIBLE industrial
  // outposts to roam through. Terrain is kept in `this.terrain` (hexKey → terrain id); collision,
  // line-of-sight, and the per-terrain speed penalty all read the data-table props. Building HP is
  // seeded into `this.buildingHp` (hexKey → hp) and the per-hex tile images are kept in
  // `this.tileImages` so a destroyed outpost can swap its texture to rubble in place. Seeded so
  // the layout is deterministic.
  _buildWorld() {
    this.worldRadius = 20;
    const R = this.worldRadius;
    const rng = mulberry32(0x5eed);
    const all = range({ q: 0, r: 0 }, R);
    const T = new Map();
    // The biome to build (set on the scene before create(), e.g. per deploy/stage #64). The role
    // → terrain-id mapping comes entirely from the biome data, so this generator never branches on
    // which biome it is; swapping biomes just swaps the ids it stamps.
    const B = getBiome(this.biomeId ?? DEFAULT_BIOME);
    this.biome = B;
    const groundAt = (h) => ((h.q + h.r) % 2 ? B.groundB : B.groundA);
    const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };

    // Base: a checkered open floor (grass / sand / snow / pavement / ash by biome).
    for (const h of all) T.set(axialKey(h.q, h.r), groundAt(h));

    // Channel: a winding strip sweeping across the map — river / dry-bed / slush / road / lava-crust.
    // Passable, non-LOS-blocking; slowing (or a fast lane in the city) per the terrain's own props.
    if (B.hasChannel) {
      for (let q = -R + 2; q <= R - 2; q++) {
        const r = Math.round(7 * Math.sin(q * 0.26) + 3 * Math.sin(q * 0.11));
        for (const dr of [0, 1]) { const k = axialKey(q, r + dr); if (T.has(k)) T.set(k, B.channel); }
      }
    }

    // A DEEP impassable blob off to one side (lake / mesa / ice / collapsed heap / lava pool),
    // distinct from the channel. Grown as a blobby disc so its edge reads naturally; kept clear of
    // the centre spawn area.
    if (B.hasDeep) {
      const deep = all[Math.floor(rng() * all.length)];
      if (Math.hypot(hexToPixel(deep.q, deep.r).x, hexToPixel(deep.q, deep.r).y) > 6 * 48) {
        for (const h of range(deep, 3)) {
          const d = Math.max(Math.abs(h.q - deep.q), Math.abs(h.r - deep.r), Math.abs(h.q + h.r - deep.q - deep.r));
          const k = axialKey(h.q, h.r);
          if (T.has(k) && rng() < 1 - d * 0.28) T.set(k, B.deep);
        }
      }
    }

    // Cover clusters scattered across the field (seed + organic neighbour growth) — walk-through
    // cover (forest / scrub / snowdrift / wreckage / fumarole). Density scales per biome.
    for (let i = 0; i < Math.round(R * 2.2 * B.coverClusters); i++) {
      const c = all[Math.floor(rng() * all.length)];
      const k0 = axialKey(c.q, c.r);
      if (!isGround(k0)) continue;
      T.set(k0, B.cover);
      for (const n of neighbors(c.q, c.r)) {
        const k = axialKey(n.q, n.r);
        if (isGround(k) && rng() < 0.6) T.set(k, B.cover);
      }
    }

    // A few DESTRUCTIBLE outposts (building clusters) — hard cover. HP seeded below.
    for (let i = 0; i < B.outposts; i++) {
      const c = all[Math.floor(rng() * all.length)];
      for (const h of [c, ...neighbors(c.q, c.r).filter(() => rng() < 0.55)]) {
        const k = axialKey(h.q, h.r); if (T.has(k)) T.set(k, B.outpost);
      }
    }

    // Clear the centre (spawns + line of fire) back to open ground.
    for (const h of range({ q: 0, r: 0 }, 3)) T.set(axialKey(h.q, h.r), groundAt(h));
    T.set('0,0', B.groundA);
    T.set(axialKey(DUMMY_HEX.q, DUMMY_HEX.r), B.groundA);

    this.terrain = T;
    this.buildingHp = new Map();   // hexKey → remaining HP for destructible (building) hexes
    this.tileImages = new Map();   // hexKey → the tile Image, so a hex can be re-textured in place
    for (const [k, id] of T) {
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      const img = this.add.image(x, y, getTerrain(id).tex).setScale(1 / ART_SCALE);
      this.tileImages.set(k, img);
      const hp = buildingHp(id);
      if (hp > 0) this.buildingHp.set(k, hp);
    }
  },

  // Terrain id at a world point (undefined = outside the arena disc).
  _terrainAt(x, y) {
    const h = pixelToHex(x, y);
    return this.terrain.get(axialKey(h.q, h.r));
  },

  // Does a world point block line-of-sight (cover / projectile blocker)? Forest + buildings do;
  // open grass, river, and deep water do not (you can shoot over water and rubble).
  _isWall(x, y) {
    return blocksLOS(this._terrainAt(x, y));
  },

  // Is a world point impassable for the mech — non-passable terrain, or off the arena disc?
  _blocked(x, y) {
    return !isPassable(this._terrainAt(x, y));
  },

  // Max-speed multiplier for the terrain under a world point — river/forest/rubble slow the mech;
  // grass is normal. Off-map / unknown ⇒ 1 (passability is handled separately by _blocked).
  _speedFactorAt(x, y) {
    return terrainSpeedFactor(this._terrainAt(x, y));
  },

  // Deal `amount` damage to the destructible outpost at a world point (weapon fire or a stomp).
  // No-op on non-building hexes. On destruction the hex collapses to rubble: terrain + collision
  // + LOS all update, the tile is re-textured, and a debris/explosion FX plays. Returns true iff
  // this hit destroyed the building (so callers can react, e.g. a bigger boom).
  _damageBuildingAt(x, y, amount) {
    const h = pixelToHex(x, y);
    const k = axialKey(h.q, h.r);
    if (!this.buildingHp.has(k)) return false;
    const { hp, destroyed } = damageBuilding(this.buildingHp.get(k), amount);
    if (!destroyed) { this.buildingHp.set(k, hp); return false; }
    // Collapse to rubble: swap the terrain data (movement + LOS now read the biome's rubble) and
    // texture. `rubbleFor` maps this outpost to its biome-appropriate debris (data-driven).
    this.buildingHp.delete(k);
    const rub = rubbleFor(this.terrain.get(k));
    this.terrain.set(k, rub);
    const img = this.tileImages.get(k);
    if (img) img.setTexture(getTerrain(rub).tex);
    const { x: cx, y: cy } = hexToPixel(h.q, h.r);
    this._outpostCollapseFx(cx, cy);
    return true;
  },

  // #41: the mech STOMPING a building it's pressed against. Applies a per-frame bite of crush
  // damage (a fixed per-second rate scaled by how fast the mech is driving into it) so leaning
  // on an outpost flattens it in a beat or two rather than instantly. No-op off buildings.
  _stompBuildingAt(x, y, dt) {
    const speedFrac = Math.min(1, this.speed / Math.max(1, this.mech.movement.maxSpeed));
    const dmg = STOMP_DPS * dt * (0.35 + 0.65 * speedFrac);
    if (dmg > 0) this._damageBuildingAt(x, y, dmg);
  },

  // Debris + fireball when an outpost is flattened (#41): a bright flash, an expanding shock ring,
  // and a scatter of dust/rubble chunks flung outward, plus a heavy explosion cue.
  _outpostCollapseFx(x, y) {
    Audio.explosion(1.0);
    const flash = this.add.circle(x, y, 6, 0xffe6a0, 0.9);
    this.tweens.add({ targets: flash, scale: 4, alpha: 0, duration: 220, onComplete: () => flash.destroy() });
    const ring = this.add.circle(x, y, 8).setStrokeStyle(3, 0xff9a3c, 0.8);
    this.tweens.add({ targets: ring, scale: 5, alpha: 0, duration: 420, ease: 'Quad.easeOut', onComplete: () => ring.destroy() });
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 18 + Math.random() * 34;
      const chunk = this.add.rectangle(x, y, 3 + Math.random() * 4, 3 + Math.random() * 4, 0x64615a);
      this.tweens.add({
        targets: chunk, x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist,
        angle: Math.random() * 360, alpha: 0, duration: 360 + Math.random() * 260,
        ease: 'Quad.easeOut', onComplete: () => chunk.destroy(),
      });
    }
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
