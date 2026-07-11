// Arena world mixin — terrain generation + the world queries everything else reads
// (terrain lookup, wall/LOS test, passability, ray-to-wall distance). Methods use `this`
// (the ArenaScene); composed onto the scene prototype via Object.assign.
import { ART_SCALE } from '../../art/index.js';
import { hexToPixel, pixelToHex, axialKey } from '../../data/hexgrid.js';
import {
  getTerrain, terrainSpeedFactor, isPassable, buildingHp, damageBuilding, rubbleFor,
  shotBlockedAt, flameCoverDamage,
} from '../../data/terrain.js';
import { getBiome, DEFAULT_BIOME } from '../../data/biomes.js';
import {
  generateTerrain, organicBoundary, growRegion, mulberry32,
  INITIAL_BASE_RADIUS, INITIAL_VARIATION, SECTORS, MAX_WORLD_RADIUS,
} from '../../data/worldgen.js';
import { Audio } from '../../audio/index.js';
import { DUMMY_HEX, crushDamage, groundEnemyRadius, circleContains, DEPTH } from './shared.js';

// #41: how fast a mech crushes an outpost it's stomping (HP/sec at full drive-in speed). A
// building has 60 HP, so ~1.5–2s of leaning at speed flattens it. Owner: tunable.
const STOMP_DPS = 45;


export const WorldMixin = {
  // Generate a natural battlefield (#41): a grass area with a winding SHALLOW river, a distinct
  // DEEP-water lake, walk-through forest clusters, and a few DESTRUCTIBLE industrial outposts to
  // roam through. Terrain is kept in `this.terrain` (hexKey → terrain id); collision, line-of-
  // sight, and the per-terrain speed penalty all read the data-table props. Building HP is
  // seeded into `this.buildingHp` (hexKey → hp) and the per-hex tile images are kept in
  // `this.tileImages` so a destroyed outpost can swap its texture to rubble in place.
  //
  // #81 (organic growth rewrite): the playable area is no longer a fixed-size hex disc — it's
  // an IRREGULAR, organically-shaped region (`organicBoundary`, data/worldgen.js), and it
  // actually GROWS each stage advance rather than being reshuffled within a constant footprint.
  // `this.worldRadius` is now just the generous, finite BOUNDING cap (`MAX_WORLD_RADIUS`) a
  // run's cumulative growth can never exceed — not the shape of the map itself.
  //
  // Two modes, chosen by whether `opts.growthCenter` is supplied:
  //  - No `growthCenter` (the first-ever build, `ArenaScene.create()`): a SMALL organic region
  //    around world origin (`INITIAL_BASE_RADIUS`/`INITIAL_VARIATION`) — the whole thing is
  //    fresh, so `reveal`/`previous` are unused.
  //  - `opts.growthCenter` + `opts.previous` (every stage advance, run.js `_startNextStage`):
  //    ADD a fresh organic lobe centred there on top of whatever `opts.previous` already
  //    explored (`growRegion`) — everywhere already explored is preserved byte-identical
  //    (reused from the original directional-partial-regen pass), only the new lobe is freshly
  //    stamped. The resulting `reveal` predicate is stashed on `this._revealRegion` so run.js
  //    can scope the new stage's objective to the freshly-added territory.
  //
  // The seed is a random draw by default (a NEW layout every call) rather than a hardcoded
  // constant; pass an explicit `seed` to reproduce a layout (tests do this — the same seed also
  // deterministically drives this build's organic-shape RNG, independent of `generateTerrain`'s
  // own internal seed-derived RNG for terrain features). `safeCenter` (default world origin) is
  // the hex the spawn-safe zone clears around — stage advance passes the PLAYER'S continuing
  // hex so the fresh terrain never strands the mech in a lake/wall (the player's px/py
  // themselves are never touched — no teleport).
  _buildWorld(seed = Math.floor(Math.random() * 0x100000000), safeCenter = { q: 0, r: 0 }, opts = {}) {
    this.worldRadius = MAX_WORLD_RADIUS;
    // The biome to build (set on the scene before create(), e.g. per deploy/stage #64). The role
    // → terrain-id mapping comes entirely from the biome data, so this generator never branches on
    // which biome it is; swapping biomes just swaps the ids it stamps. #81: the biome stays fixed
    // for the whole run (still chosen once per deploy) — only the feature ARRANGEMENT varies.
    const B = getBiome(this.biomeId ?? DEFAULT_BIOME);
    this.biome = B;

    const shapeRng = mulberry32(seed);
    let included, reveal;
    if (opts.growthCenter) {
      // #81 follow-up (playtest 2026-07-10 point 2): forward the growth angle + the player's
      // pixel position (run.js `_growNextStageTerrain`) so the new lobe reads as a directional
      // cone rather than a 360° blob — see `growRegion`'s `angle`/`arcFrom` params.
      ({ included, reveal } = growRegion({
        previous: opts.previous ?? null, center: opts.growthCenter, rng: shapeRng,
        angle: opts.growthAngle ?? null, arcFrom: opts.arcFrom ?? null,
      }));
    } else {
      included = organicBoundary({ q: 0, r: 0 }, shapeRng, {
        baseRadius: INITIAL_BASE_RADIUS, variation: INITIAL_VARIATION, sectors: SECTORS,
      });
      reveal = null;
    }
    this._revealRegion = reveal;   // exposed for run.js (objective placement) + tests/smoke

    const dummyKey = axialKey(DUMMY_HEX.q, DUMMY_HEX.r);
    const { terrain, buildingHp: builtBuildingHp, coverHp } = generateTerrain({
      seed, worldRadius: this.worldRadius, biome: B, safeCenter, extraClear: [dummyKey],
      reveal, previous: opts.previous ?? null, included,
    });

    const prevTerrain = opts.previous?.terrain ?? null;
    const prevTileImages = this.tileImages ?? null;

    this.terrain = terrain;
    this.buildingHp = builtBuildingHp;   // hexKey → remaining HP for destructible OUTPOST (solid) hexes
    // #72: destructible SOFT cover (forest/scrub/drift…) keeps its HP in a separate map so the
    // mission/run objective logic — which reads `buildingHp` as "the standing outposts" — never
    // designates a tree as an assault target. `_damageBuildingAt` chips/flattens both alike.
    this.coverHp = coverHp;      // hexKey → remaining HP for destructible soft-cover hexes
    this.tileImages = new Map();   // hexKey → the tile Image, so a hex can be re-textured in place
    for (const [k, id] of this.terrain) {
      // #81 follow-up: a partial (directional) regen leaves most hexes byte-identical to the
      // previous pass — reuse that hex's existing tile Image untouched instead of destroying
      // and recreating it, so nothing near/behind the player visibly redraws. Only hexes whose
      // terrain id actually changed (i.e. inside the reveal region, or ANY hex on a full-disc
      // regen where there's no `previous` to compare against) get a fresh Image.
      if (prevTerrain && prevTileImages && prevTerrain.get(k) === id && prevTileImages.has(k)) {
        this.tileImages.set(k, prevTileImages.get(k));
        continue;
      }
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      // #81 follow-up (playtest 2026-07-10 point 1): explicit DEPTH.TERRAIN on every tile, not
      // just the very first world build — a growth-pass tile added long after `this.playerView`
      // (DEPTH.UNITS) must sort the same way the initial-build tiles do, not rely on add-order.
      const img = this.add.image(x, y, getTerrain(id).tex).setScale(1 / ART_SCALE).setDepth(DEPTH.TERRAIN);
      this.tileImages.set(k, img);
    }
    // Destroy every PREVIOUS tile Image that wasn't carried over above (the same leak #71 fixed
    // for enemy views) — everything that changed, plus (on a first-ever full-disc build) all of
    // them, since `this.tileImages` above only re-collects survivors.
    if (prevTileImages) {
      for (const [k, img] of prevTileImages) if (this.tileImages.get(k) !== img) img.destroy();
    }
  },

  // Terrain id at a world point (undefined = outside the arena disc).
  _terrainAt(x, y) {
    const h = pixelToHex(x, y);
    return this.terrain.get(axialKey(h.q, h.r));
  },

  // The hex key under a world point — the identity used for own-hex transparency (#72).
  _hexKeyAt(x, y) {
    const h = pixelToHex(x, y);
    return axialKey(h.q, h.r);
  },

  // Does a world point block line-of-sight (cover / projectile blocker)? Forest + buildings do;
  // open grass, river, and deep water do not (you can shoot over water and rubble).
  // #72: `transparent` (optional Set of hex keys) lists hexes that are see-through for THIS
  // ray — the shooter's muzzle hex and the target's own hex — so soft cover never protects its
  // own occupant. Solid cover blocks regardless (the pure rule lives in terrain.js).
  _isWall(x, y, transparent = null) {
    const k = this._hexKeyAt(x, y);
    return shotBlockedAt(this.terrain.get(k), k, transparent);
  },

  // The own-hex transparency Set for a shot/LOS ray between two points (#72): each endpoint's
  // hex is see-through (soft cover only — `shotBlockedAt` keeps solid cover blocking).
  _losTransparency(x0, y0, x1, y1) {
    return new Set([this._hexKeyAt(x0, y0), this._hexKeyAt(x1, y1)]);
  },

  // Is a world point impassable for the mech — non-passable terrain, or off the arena disc?
  _blocked(x, y) {
    return !isPassable(this._terrainAt(x, y));
  },

  // #92: does a living GROUND enemy unit's collision circle cover world point (x, y)? Flying
  // kinds (helicopter/drone) narratively fly over ground obstacles, so they're excluded — only
  // mechs, tanks, turrets, and (#104) infantry can physically block the player. Returns the
  // blocking enemy (so the caller can special-case a crushable one — see `CRUSHABLE_BEHAVIORS`
  // — for instant-kill damage), or null if nothing there blocks.
  _blockedByGroundEnemy(x, y) {
    for (const e of this.enemies) {
      if (e.flying) continue;
      if (e.mech.isDestroyed()) continue;
      if (circleContains(x, y, e.x, e.y, groundEnemyRadius(e))) return e;
    }
    return null;
  },

  // #92 (corrected per playtest 2026-07-10): the player driving into a TANK is an INSTANT kill
  // on contact, not a multi-second grind — the original gradual-DPS crush (mirroring the outpost
  // stomp below) read as "blocked/stuck" rather than "destroying the tank." #104 (playtest:
  // infantry, the weakest unit in the game, "should be stompable" too) extends the exact same
  // instant-kill treatment to infantry — `CRUSHABLE_BEHAVIORS` below is the scope, checked by the
  // caller (`_drive` in locomotion.js). One call dealing damage >= the enemy's entire remaining
  // hp pool, so it dies THIS frame. Still goes through combat.js `_damageEnemyAt`, so the kill
  // runs the normal death path unchanged (explosion FX, corpse teardown, powerup/salvage drop) —
  // only the amount/pacing changed, not the destruction machinery. Other ground enemies (mechs,
  // turrets) just BLOCK via `_blockedByGroundEnemy` above — no crush/instakill — per the
  // explicit scope.
  _crushGroundEnemyAt(e) {
    if (e.mech.isDestroyed()) return;
    const dmg = (e.mech.hp ?? e.mech.maxHp) + 1;   // comfortably >= remaining hp: dies in one hit
    this._damageEnemyAt(e, e.x, e.y, dmg, 0xffffff);
  },

  // Max-speed multiplier for the terrain under a world point — river/forest/rubble slow the mech;
  // grass is normal. Off-map / unknown ⇒ 1 (passability is handled separately by _blocked).
  _speedFactorAt(x, y) {
    return terrainSpeedFactor(this._terrainAt(x, y));
  },

  // Deal `amount` damage to the destructible terrain at a world point (weapon fire or a stomp) —
  // a solid outpost (buildingHp) or, #72, a soft-cover hex (coverHp). No-op elsewhere. Flame
  // damage (`opts.flame`) is multiplied against soft cover (terrain.js flameCoverDamage) so
  // incendiaries clear woods fast. On destruction the hex flattens to its biome rubble: terrain
  // + collision + LOS all update, the tile is re-textured, and a debris FX plays (a lighter one
  // for soft cover). Returns true iff this hit destroyed the hex (so callers can react).
  _damageBuildingAt(x, y, amount, opts = {}) {
    const h = pixelToHex(x, y);
    const k = axialKey(h.q, h.r);
    const store = this.buildingHp.has(k) ? this.buildingHp : (this.coverHp.has(k) ? this.coverHp : null);
    if (!store) return false;
    const soft = store === this.coverHp;
    if (soft && opts.flame) amount = flameCoverDamage(amount);
    const { hp, destroyed } = damageBuilding(store.get(k), amount);
    if (!destroyed) { store.set(k, hp); return false; }
    // Collapse to rubble: swap the terrain data (movement + LOS now read the biome's rubble) and
    // texture. `rubbleFor` maps this outpost to its biome-appropriate debris (data-driven).
    store.delete(k);
    const rub = rubbleFor(this.terrain.get(k));
    this.terrain.set(k, rub);
    const img = this.tileImages.get(k);
    if (img) img.setTexture(getTerrain(rub).tex);
    const { x: cx, y: cy } = hexToPixel(h.q, h.r);
    this._outpostCollapseFx(cx, cy, soft);
    return true;
  },

  // #41: the mech STOMPING a building it's pressed against. Applies a per-frame bite of crush
  // damage (a fixed per-second rate scaled by how fast the mech is driving into it) so leaning
  // on an outpost flattens it in a beat or two rather than instantly. No-op off buildings.
  _stompBuildingAt(x, y, dt) {
    const speedFrac = Math.min(1, this.speed / Math.max(1, this.mech.movement.maxSpeed));
    const dmg = crushDamage(STOMP_DPS, dt, speedFrac);
    if (dmg > 0) this._damageBuildingAt(x, y, dmg);
  },

  // Debris + fireball when an outpost is flattened (#41): a bright flash, an expanding shock ring,
  // and a scatter of dust/rubble chunks flung outward, plus a heavy explosion cue. #72: soft cover
  // (a forest hex burning/chewed down) plays a lighter version — quieter cue, smaller flash/ring.
  _outpostCollapseFx(x, y, soft = false) {
    Audio.explosion(soft ? 0.45 : 1.0);
    // #99: explicit DEPTH.IMPACT_FX — same tier as combat.js's impact/death bursts, which this
    // is (a collapse explosion); previously unset, only reading "on top" by add-order accident.
    const flash = this.add.circle(x, y, 6, 0xffe6a0, soft ? 0.6 : 0.9).setDepth(DEPTH.IMPACT_FX);
    this.tweens.add({ targets: flash, scale: soft ? 2.5 : 4, alpha: 0, duration: 220, onComplete: () => flash.destroy() });
    const ring = this.add.circle(x, y, 8).setStrokeStyle(3, 0xff9a3c, soft ? 0.5 : 0.8).setDepth(DEPTH.IMPACT_FX);
    this.tweens.add({ targets: ring, scale: soft ? 3 : 5, alpha: 0, duration: 420, ease: 'Quad.easeOut', onComplete: () => ring.destroy() });
    for (let i = 0; i < (soft ? 7 : 12); i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 18 + Math.random() * 34;
      const chunk = this.add.rectangle(x, y, 3 + Math.random() * 4, 3 + Math.random() * 4, 0x64615a).setDepth(DEPTH.IMPACT_FX);
      this.tweens.add({
        targets: chunk, x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist,
        angle: Math.random() * 360, alpha: 0, duration: 360 + Math.random() * 260,
        ease: 'Quad.easeOut', onComplete: () => chunk.destroy(),
      });
    }
  },

  // Distance from a muzzle along an angle to the first wall, or Infinity if clear within
  // `maxT`. Used so beams/shots are blocked by cover. #72: pass a `transparent` hex-key Set
  // (usually `_losTransparency(shooter, target)`) so each endpoint's own soft-cover hex
  // doesn't block the ray.
  _wallDistance(x0, y0, angle, maxT, transparent = null) {
    const cx = Math.cos(angle), cy = Math.sin(angle);
    for (let t = 8; t < maxT; t += 8) {
      if (this._isWall(x0 + cx * t, y0 + cy * t, transparent)) return t;
    }
    return Infinity;
  },

  // #64: seed ONE fresh destructible outpost hex, converting a nearby passable ground tile back
  // into `biome.outpost` terrain with full HP and re-texturing it in place. Every outpost a
  // biome starts with is eventually destroyed permanently (collapses to rubble, no repair — see
  // `_damageBuildingAt`), so a run whose stage count exceeds a biome's outpost count needs a way
  // to keep producing assault objectives; the run mixin calls this as a fallback once
  // `buildingHp` runs dry. Picks a random ground hex within a modest ring of `nearQ,nearR`
  // (clear of the permanent spawn-safe zone) so it doesn't land on top of the player or another
  // outpost. #81 follow-up: an optional `reveal` predicate (`(q, r) => boolean`) restricts the
  // candidate hex to the freshly-opened reveal region, so a stage-advance fallback objective
  // still lands somewhere the player has to walk into the new area to reach — when `reveal` is
  // given, the search ring is capped to roughly the size of one growth lobe (not the much
  // larger `worldRadius` bounding cap #81's organic growth introduced), so tries actually land
  // near the lobe instead of mostly missing it. Returns the new outpost's hex key, or null if no
  // eligible ground hex was found.
  _spawnOutpostAt(nearQ = 0, nearR = 0, reveal = null) {
    const B = this.biome;
    const ringCap = reveal ? 24 : (this.worldRadius - 6);
    for (let tries = 0; tries < 40; tries++) {
      const ring = 4 + Math.floor(Math.random() * ringCap);
      const ang = Math.random() * Math.PI * 2;
      const q = Math.round(nearQ + ring * Math.cos(ang));
      const r = Math.round(nearR + ring * Math.sin(ang) * (2 / Math.sqrt(3)) - (ring * Math.cos(ang)) / 2);
      if (reveal && !reveal(q, r)) continue;
      const k = axialKey(q, r);
      const t = this.terrain.get(k);
      if (t !== B.groundA && t !== B.groundB) continue;
      this.terrain.set(k, B.outpost);
      this.buildingHp.set(k, buildingHp(B.outpost));
      const img = this.tileImages.get(k);
      if (img) img.setTexture(getTerrain(B.outpost).tex);
      return k;
    }
    return null;
  },
};
