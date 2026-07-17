// Arena world mixin — terrain generation + the world queries everything else reads
// (terrain lookup, wall/LOS test, passability, ray-to-wall distance). Methods use `this`
// (the ArenaScene); composed onto the scene prototype via Object.assign.
import { ART_SCALE } from '../../art/index.js';
import { hexToPixel, pixelToHex, axialKey, hexesWithinPixelRadius, hexesAlongSegment } from '../../data/hexgrid.js';
import {
  getTerrain, terrainSpeedFactor, isPassable, buildingHp, damageBuilding, rubbleFor,
  shotBlockedAt, flameCoverDamage, blocksLOS, isSoftCover, isMissionObjective,
} from '../../data/terrain.js';
import { getBiome, DEFAULT_BIOME } from '../../data/biomes.js';
import { terrainFillColor, isBoundaryTerrainId } from '../../art/hexArt.js';
import {
  generateTerrain, generateSpine, corridorHexSet, boundaryRingKeys, mulberry32,
  safeZoneKeys, CORRIDOR_LENGTH_PX, HEX_STEP_PX, MAX_WORLD_RADIUS,
} from '../../data/worldgen.js';
import { Audio } from '../../audio/index.js';
import {
  DUMMY_HEX, crushDamage, groundEnemyRadius, circleContains, DEPTH,
  CRUSHABLE_BEHAVIORS, crushTriggerRadius,
} from './shared.js';

// #41: how fast a mech crushes an outpost it's stomping (HP/sec at full drive-in speed). A
// building has 60 HP, so ~1.5–2s of leaning at speed flattens it. Owner: tunable.
const STOMP_DPS = 45;

// #155: tile-visibility culling. Phaser does no camera-frustum culling of its own, and the
// whole run's terrain is pre-built as ~20k live Image GameObjects (#111) — rendering all of
// them every frame, regardless of camera position, measured as ~10x the entire rest of the
// frame cost (#148 audit: 30.2ms→3.4ms/frame just from hiding far tiles). `CULL_MARGIN_PX` is
// how far beyond the camera's current view rect a tile is still kept visible (padding so
// nothing visibly pops in/out right at the screen edge — the audit's own 1200px test value).
// `CULL_RECHECK_PX` is how far the camera's centre has to move before we bother re-deriving
// the visible set at all — with a margin this generous, a camera nudge well under the margin
// can't have changed which tiles should show, so most frames skip the recompute entirely.
const CULL_MARGIN_PX = 1200;
const CULL_RECHECK_PX = 300;

// #167: per-enemy LOS/firing-lane raycasts (`_wallDistanceLos` below) were the top game-logic
// CPU cost once #155/#161 fixed the render + swarm-texture costs (#148/#164 profiles measured
// 1.5–2.4ms/frame, 94–118 calls/frame with a swarm). Line-of-sight rarely flips frame-to-frame,
// so each enemy recomputes its LOS to the player only every ~LOS_REFRESH_MS instead of every
// frame (`_cachedLosToPlayer`), staggered by a random per-enemy phase so a whole swarm's
// recomputes spread across frames rather than spiking on one tick. Between refreshes the last
// result is reused, so an enemy's LOS knowledge can be up to one window stale. The audit's
// recommended window was 100–150ms (~6–9 frames): short enough that a firing enemy never
// visibly shoots through cover that just closed, nor holds fire for a noticeable beat after a
// lane opens (a shot cadence is itself ≥120ms), yet long enough to cut the recompute rate ~8x.
export const LOS_REFRESH_MS = 120;


export const WorldMixin = {
  // Generate a natural battlefield (#41): a grass area with a winding SHALLOW river, walk-through
  // forest clusters, a few DESTRUCTIBLE industrial outposts to roam through, and (#110) a biome-
  // appropriate LESSER hazard blob. Terrain is kept in `this.terrain` (hexKey → terrain id);
  // collision, line-of-sight, and the per-terrain speed penalty all read the data-table props.
  // Building HP is seeded into `this.buildingHp` (hexKey → hp) and the per-hex tile images are
  // kept in `this.tileImages` so a destroyed outpost can swap its texture to rubble in place.
  //
  // #111: the WHOLE run's terrain is built ONCE here, at deploy time (`ArenaScene.create()`) —
  // there is no more per-stage incremental growth. #169: the playable area is a single, long,
  // non-self-intersecting SNAKING CORRIDOR — a winding spine (`generateSpine`) with every hex
  // within CORRIDOR_HALF_WIDTH_PX of it carved out as the floor (`corridorHexSet`, data/
  // worldgen.js). Width is narrow (so the boundary shows on the sides, #158's principle) and
  // decoupled from the long length, so the far end is not visible from spawn and a run traverses
  // the whole corridor. `this.worldRadius` (`MAX_WORLD_RADIUS`) is a loose finite bounding cap.
  //
  // #110: a biome-appropriate IMPASSABLE boundary ring (`boundaryRingKeys`) is stamped just
  // outside the built area's own organic edge, using the biome's `deep` terrain id (lake / mesa
  // / ice / collapsed heap / lava) — this is the ONLY place `deep` is ever stamped now; it never
  // appears as an in-map feature (see worldgen.js `hasHazard`/`hazard`). Flying enemies (drone/
  // helicopter) still ignore it, same as every other terrain — see `_updateVehicle` in
  // enemies.js, which only gates ground units on `_blocked`.
  //
  // The seed is a random draw by default (a NEW layout every call) rather than a hardcoded
  // constant; pass an explicit `seed` to reproduce a layout (tests do this — the same seed also
  // deterministically drives this build's organic-shape RNG, independent of `generateTerrain`'s
  // own internal seed-derived RNG for terrain features).
  _buildWorld(seed = Math.floor(Math.random() * 0x100000000)) {
    this.worldRadius = MAX_WORLD_RADIUS;
    // The biome to build (set on the scene before create(), e.g. per deploy #64). The role →
    // terrain-id mapping comes entirely from the biome data, so this generator never branches on
    // which biome it is; swapping biomes just swaps the ids it stamps. The biome stays fixed for
    // the whole run (chosen once per deploy) — only the feature ARRANGEMENT varies per seed.
    const B = getBiome(this.biomeId ?? DEFAULT_BIOME);
    this.biome = B;

    // #126: paint the camera background to match this biome's `deep` boundary terrain instead
    // of the fixed void-black set in ArenaScene.create() — the deepened boundary ring (see
    // worldgen.js BOUNDARY_RING_WIDTH) is sized to outrun any realistic camera view distance, but
    // this is the unconditional backstop: any viewport wider than that (or a browser zoomed far
    // out) still sees "more deep terrain colour" at the horizon, never raw black.
    const deepFill = terrainFillColor(B.deep);
    if (deepFill != null) this.cameras.main.setBackgroundColor(deepFill);

    const shapeRng = mulberry32(seed);
    // #169: a long, single, non-self-intersecting SNAKING corridor. Draw the main-axis heading from
    // the SAME per-seed shape rng (still deterministic for a given seed, but a different orientation
    // each deploy), generate the winding spine anchored at world origin (the spawn END), and carve
    // the playable area as every hex within CORRIDOR_HALF_WIDTH_PX of the spine. The radius-3 spawn
    // safe zone is force-included so the boundary ring (#110) can never encroach it, and the
    // boundary BFS is seeded directly from the corridor set — no bounding-disc scan.
    const startAngle = shapeRng() * Math.PI * 2;
    const spine = generateSpine(shapeRng, { startAngle });
    this._spine = spine;   // exposed for objective-along-spine placement (mission.js/run.js)
    // #116: publish the spine centreline (plain {x,y} world points) for the HUD corner minimap,
    // which draws the whole corridor's silhouette by unioning discs along it. Set once here (the
    // corridor is built once per run, #111) — HudScene reads it as a stable snapshot each frame.
    this.registry.set('spineWorld', spine.points.map((p) => ({ x: p.x, y: p.y })));
    const includedKeys = corridorHexSet(spine.points, undefined, safeZoneKeys({ q: 0, r: 0 }, 3));
    const boundaryRing = boundaryRingKeys(null, { insideKeys: includedKeys });
    this._boundaryRing = boundaryRing;   // exposed for tests/smoke

    // Scale outpost count with corridor length so standing objectives exist the whole way down the
    // spine — a flat biome count would leave the far end (where late stages aim) without a target.
    const lengthHex = CORRIDOR_LENGTH_PX / HEX_STEP_PX;
    const outposts = Math.max(B.outposts, Math.round(lengthHex / 3));

    const dummyKey = axialKey(DUMMY_HEX.q, DUMMY_HEX.r);
    const { terrain, buildingHp, coverHp } = generateTerrain({
      seed, worldRadius: this.worldRadius, biome: B, extraClear: [dummyKey],
      includedKeys, boundaryRing, outposts,
    });

    this.terrain = terrain;
    this.buildingHp = buildingHp;   // hexKey → remaining HP for destructible OUTPOST (solid) hexes
    // #72: destructible SOFT cover (forest/scrub/drift…) keeps its HP in a separate map so the
    // mission/run objective logic — which reads `buildingHp` as "the standing outposts" — never
    // designates a tree as an assault target. `_damageBuildingAt` chips/flattens both alike.
    this.coverHp = coverHp;      // hexKey → remaining HP for destructible soft-cover hexes
    this.tileImages = new Map();   // hexKey → the tile Image, so a hex can be re-textured in place
    // #222 (4th playtest pass): three rounds of per-tile treatment (dropping the inset border,
    // overdrawing/bleeding the fill, scoping the #211 sunken-shadow ring to true coastline-only
    // tiles) all still read as "an obviously tiled hex grid" once seen in motion — because it
    // structurally IS one: ~30 hexes deep of individually-placed, individually-textured Image
    // objects, no matter how seamless each one's edges are made to look. Per Jackson's direction,
    // stop placing hex tiles for the boundary ring at all. `this.terrain` keeps every boundary
    // hex's id (so passability/`_blocked`, `blocksLOS`/LOS rays, `_terrainAt`, pathing — anything
    // that reads the data map — is completely unaffected); we simply never call `this.add.image`
    // for one. With no tile drawn there, the camera's own background colour shows through instead
    // — and that's already set a few lines up (`this.cameras.main.setBackgroundColor(deepFill)`)
    // to this exact biome's `deep` fill colour (blue-ish for water/ice, black-red for lava, etc.)
    // as the #126 far-view backstop. Reusing it as the ACTUAL boundary rendering (rather than a
    // backstop past the ring) turns the whole boundary into one continuous flat-coloured fill —
    // structurally seamless, since there is no longer a tile edge to seam — exactly matching how
    // impassable terrain looked before hex-terrain rendering existed for it, just biome-tinted
    // instead of flat black. Only the passable interior (never a boundary-only id) still gets
    // individual hex Image tiles, unchanged.
    for (const [k, id] of this.terrain) {
      if (isBoundaryTerrainId(getTerrain(id).tex)) continue;
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      const tex = getTerrain(id).tex;
      const img = this.add.image(x, y, tex).setScale(1 / ART_SCALE).setDepth(DEPTH.TERRAIN);
      this.tileImages.set(k, img);
    }
    // #155: culling state — see `_updateTileCulling` below. Every tile Image is actually
    // visible right now (Phaser default), so `_visibleTiles` starts as the FULL key set to
    // match that reality — starting it empty would mean the first real cull pass only ever
    // turns tiles ON (diffing against an empty "previously visible" set never turns any of
    // the ~20k default-visible tiles OFF). `_cullCenterX/Y` start null so the very first call
    // (whatever the camera's initial view is) always runs a full recompute regardless of the
    // move-threshold check.
    this._visibleTiles = new Set(this.terrain.keys());
    this._cullCenterX = null;
    this._cullCenterY = null;
  },

  // #155: hide every tile GameObject outside the camera's current view (+ margin), show every
  // tile inside it — toggling `.visible` on the SAME Image created in `_buildWorld`, never
  // destroying/recreating (recreation would cost far more than this saves). `view` is the exact
  // `cameraView` rect ArenaScene already computes/publishes every frame for the HUD — reused
  // as-is, not recomputed here. Purely a rendering change: gameplay (collision/LOS/passability/
  // combat) reads `this.terrain`/`this.buildingHp`/`this.coverHp` — plain data Maps — never the
  // Image objects this toggles, and an invisible Phaser GameObject is still fully queryable, so
  // nothing downstream can observe or be affected by a tile's visibility.
  //
  // Cheap by construction, not by scanning: rather than bounds-checking all ~20k tiles every
  // frame, this (a) skips the recompute entirely unless the camera's centre has moved more than
  // `CULL_RECHECK_PX` since the last recompute, and (b) even when it does recompute, only asks
  // `hexesWithinPixelRadius` (data/hexgrid.js) for the hexes near the new centre — a small ring,
  // not a scan — then diffs that against the previous visible set so only the tiles crossing the
  // boundary actually get a `setVisible` call.
  _updateTileCulling(view, margin = CULL_MARGIN_PX) {
    const cx = view.x + view.width / 2;
    const cy = view.y + view.height / 2;
    if (this._cullCenterX != null) {
      const moved = Math.hypot(cx - this._cullCenterX, cy - this._cullCenterY);
      if (moved < CULL_RECHECK_PX) return;
    }
    this._cullCenterX = cx;
    this._cullCenterY = cy;

    // A circle centred on the view, radius = half-diagonal of the margined view rect, fully
    // contains the margined rect itself — `hexesWithinPixelRadius` turns that into just the
    // nearby hex keys instead of walking the whole terrain map.
    const radius = Math.hypot(view.width / 2 + margin, view.height / 2 + margin);
    const nextVisible = new Set();
    for (const h of hexesWithinPixelRadius(cx, cy, radius)) {
      nextVisible.add(axialKey(h.q, h.r));
    }

    for (const k of nextVisible) {
      if (this._visibleTiles.has(k)) continue;
      const img = this.tileImages.get(k);
      if (img) img.setVisible(true);
    }
    for (const k of this._visibleTiles) {
      if (nextVisible.has(k)) continue;
      const img = this.tileImages.get(k);
      if (img) img.setVisible(false);
    }
    this._visibleTiles = nextVisible;
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

  // #168: like `_isWall`, but the see-through set is the UNION of a shared per-frame Set (all
  // living enemy hexes for a player round, or the player's own hex for an enemy round — built
  // once per frame and reused across every round of that owner) and this round's own tiny
  // `originHexes` array. Checked in place so no fresh combined Set is allocated per round per
  // frame. Behaviourally identical to `_isWall(x, y, new Set([...originHexes, ...shared]))`;
  // only the allocation is removed. `shotBlockedAt`'s exact rule is mirrored here via the same
  // terrain predicates it uses internally (blocksLOS / isSoftCover).
  _isWallForRound(x, y, sharedTransparent, originHexes) {
    const k = this._hexKeyAt(x, y);
    const id = this.terrain.get(k);
    if (!blocksLOS(id)) return false;
    const transparent =
      (sharedTransparent != null && sharedTransparent.has(k)) ||
      (originHexes != null && originHexes.includes(k));
    if (transparent && isSoftCover(id)) return false;
    return true;
  },

  // The own-hex transparency Set for a shot/LOS ray between two points (#72): each endpoint's
  // hex is see-through (soft cover only — `shotBlockedAt` keeps solid cover blocking). #167
  // inlined this two-key check into `_wallDistanceLos` (no per-call Set) for the hot per-enemy
  // LOS path, so production no longer calls this directly; it's retained as the canonical
  // reference the equivalence test pins `_wallDistanceLos` against (world.test.js).
  _losTransparency(x0, y0, x1, y1) {
    return new Set([this._hexKeyAt(x0, y0), this._hexKeyAt(x1, y1)]);
  },

  // Is a world point impassable for the mech — non-passable terrain, or off the arena disc?
  _blocked(x, y) {
    return !isPassable(this._terrainAt(x, y));
  },

  // #159: is any hex along the straight PIXEL path from (x0,y0) to (x1,y1) impassable? A
  // single-endpoint `_blocked(x1, y1)` check is only safe when a frame's movement stays
  // smaller than a hex — at the higher chassis speeds + INSTANT_VELOCITY's no-ramp-up snap, a
  // fast mech approaching a wall at a shallow/grazing angle can clip a hex's narrow
  // cross-section and land its endpoint sample on the far side without ever landing INSIDE
  // that hex, tunneling straight through (confirmed empirically — see hexgrid.js
  // `hexesAlongSegment`'s comment). This walks every hex the segment actually crosses via the
  // standard hex line-draw algorithm, so it catches a wall regardless of speed or angle — the
  // movement-resolution code (`_drive`) uses this instead of a raw endpoint `_blocked` call.
  _blockedAlongSegment(x0, y0, x1, y1) {
    for (const h of hexesAlongSegment(x0, y0, x1, y1)) {
      if (!isPassable(this.terrain.get(axialKey(h.q, h.r)))) return true;
    }
    return false;
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

  // #112: is a CRUSHABLE ground enemy (tank/infantry — see CRUSHABLE_BEHAVIORS) within the
  // (larger) crush-trigger radius of world point (x, y)? Deliberately separate from
  // `_blockedByGroundEnemy` above: that one still uses `groundEnemyRadius` alone (unchanged) so
  // general movement-blocking against a mech/turret stays exactly as tight as before — only the
  // crush trigger itself gets the player's extra reach (`crushTriggerRadius`, shared.js). Only
  // scans crushable behaviors, so a nearby mech/turret can never satisfy this check.
  _crushTargetAt(x, y) {
    for (const e of this.enemies) {
      if (e.flying) continue;
      if (!CRUSHABLE_BEHAVIORS.has(e.behavior)) continue;
      if (e.mech.isDestroyed()) continue;
      if (circleContains(x, y, e.x, e.y, crushTriggerRadius(e))) return e;
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

  // #250: world-space centres of every currently-STANDING destructible terrain hex within
  // `maxDist` of (x, y) — outposts (`buildingHp`) and soft cover (`coverHp`) alike. Both maps
  // delete a hex's key the instant `_damageBuildingAt` collapses it to rubble, so membership in
  // EITHER map already means "still standing" — no separate live/dead bookkeeping needed. Bounded
  // to a local ring scan (`hexesWithinPixelRadius`, same trick `_updateTileCulling` above uses)
  // rather than walking either full map, so cost stays independent of how much destructible
  // terrain the map has overall. Feeds the direct-fire convergence fallback (#250: destructible
  // terrain is a convergence target, but only below any live enemy — see shared.js
  // `pickConvergeTarget`, called from targeting.js `_updateLock`).
  _destructibleHexesNear(x, y, maxDist) {
    const pts = [];
    for (const h of hexesWithinPixelRadius(x, y, maxDist)) {
      const k = axialKey(h.q, h.r);
      if (this.buildingHp.has(k) || this.coverHp.has(k)) pts.push(hexToPixel(h.q, h.r));
    }
    return pts;
  },

  // #251: every standing hex key eligible to be picked as THE mission objective. `buildingHp`
  // holds every standing solid destructible (outposts AND atmospheric base-infrastructure
  // set-dressing like `helipad` alike — see world.js `buildingHp` comment above), but only
  // genuine outposts should ever become the assault target; `isMissionObjective` (data/terrain.js)
  // filters out anything marked `setDressing: true`. Shared by mission.js's initial pick and
  // run.js's stage-advance pick so both stay in sync with zero duplicated filtering logic.
  _objectiveHexKeys() {
    return [...this.buildingHp.keys()].filter((k) => isMissionObjective(this.terrain.get(k)));
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

  // #167: allocation-free equivalent of `_wallDistance(x0,y0,angle,maxT, _losTransparency(x0,y0,
  // x1,y1))` — the exact per-enemy LOS/firing-lane query, with own-hex soft-cover transparency
  // for the ray's TWO endpoints (#72). Returns the IDENTICAL value to that call (same 8px
  // stepping, same geometry, same returned `t`); ONLY the allocations are removed:
  //   • no `new Set` per call — the two transparent endpoint hexes are compared by q/r in place
  //     (like `_isWallForRound`), instead of `_losTransparency`'s per-call two-key Set;
  //   • no hex-key STRING built per 8px step — consecutive 8px samples almost always land in the
  //     SAME hex (an 8px step inside a 48px-radius hex rarely crosses a boundary), and a hex's
  //     wall-ness can't change between two samples that fall in it, so the terrain lookup (and
  //     its key string) is done ONLY when the hex actually changes: ~7 lookups for a 400px ray,
  //     not ~50, and ~7 key strings instead of ~50.
  // The (x1,y1) endpoint is passed explicitly (not re-derived from `angle`/`maxT`) so its
  // transparency hex is bit-identical to the old `_losTransparency(x0,y0,x1,y1)` endpoint, and
  // `cx`/`cy` reuse the same `Math.cos/sin(angle)` the old loop used — the sampled points are
  // therefore the same to the bit. Mirrors `shotBlockedAt`'s rule via the same `blocksLOS`/
  // `isSoftCover` predicates it uses internally (verified equal in world.test.js).
  _wallDistanceLos(x0, y0, angle, maxT, x1, y1) {
    const cx = Math.cos(angle), cy = Math.sin(angle);
    const oh = pixelToHex(x0, y0);          // shooter/muzzle endpoint hex (soft-cover-transparent)
    const eh = pixelToHex(x1, y1);          // target endpoint hex (soft-cover-transparent)
    let lastQ = null, lastR = null;
    for (let t = 8; t < maxT; t += 8) {
      const h = pixelToHex(x0 + cx * t, y0 + cy * t);
      if (h.q === lastQ && h.r === lastR) continue;   // same hex as last step ⇒ wall-ness unchanged
      lastQ = h.q; lastR = h.r;
      const id = this.terrain.get(axialKey(h.q, h.r));
      if (!blocksLOS(id)) continue;
      // #72: soft cover on either endpoint's OWN hex is see-through for this ray; solid cover and
      // any non-endpoint soft cover between the two blocks (exactly shotBlockedAt's rule).
      const transparent = (h.q === oh.q && h.r === oh.r) || (h.q === eh.q && h.r === eh.r);
      if (transparent && isSoftCover(id)) continue;
      return t;
    }
    return Infinity;
  },

  // #167: staggered + cached LOS boolean — "does enemy `e` have a clear firing lane / line of
  // sight to the player right now?" The underlying raycast (`_wallDistanceLos`) is recomputed
  // only once every ~LOS_REFRESH_MS of SIMULATION time; between refreshes the last result is
  // reused. See LOS_REFRESH_MS (top of file) for the staleness-vs-correctness reasoning. `x1,y1`
  // is the ray endpoint (the player) for #72 endpoint transparency. The cached value EQUALS the
  // un-cached `_wallDistanceLos(...) === Infinity` at the moment of each refresh — only the
  // recompute FREQUENCY changes.
  //
  // The cadence is driven by the per-frame `delta` (ms) every caller already has — a per-enemy
  // countdown (`_losCd`) — NOT wall-clock `this.time.now`. That makes it (a) simulation-time
  // correct: it matches the frame budget the audit described and behaves identically whether or
  // not the scene clock is advancing (a paused game, or a headless test that drives `_updateEnemy`
  // directly), and (b) trivially staggered: the countdown is seeded to a RANDOM point in the
  // window on first use, so a batch spawned on one frame refreshes on spread-out frames rather
  // than all at once, and the offset persists across refreshes.
  _cachedLosToPlayer(e, delta, x0, y0, angle, maxT, x1, y1) {
    if (e._losCd === undefined) {
      // Seed the countdown at a random point in the window (stagger) and assume NO clear lane
      // until the first refresh fires — an enemy holds fire / stays unaware rather than acting on
      // an unverified lane (errs toward not shooting; self-corrects within one window).
      e._losCd = Math.random() * LOS_REFRESH_MS;
      e._losClear = false;
    }
    e._losCd -= delta;
    if (e._losCd <= 0) {
      e._losCd += LOS_REFRESH_MS;                 // preserve sub-frame phase (keeps the stagger)
      if (e._losCd <= 0) e._losCd = LOS_REFRESH_MS;   // guard: a huge delta spike still recomputes once
      e._losClear = this._wallDistanceLos(x0, y0, angle, maxT, x1, y1) === Infinity;
    }
    return e._losClear;
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
