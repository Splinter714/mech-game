// Arena world mixin — terrain generation + the world queries everything else reads
// (terrain lookup, wall/LOS test, passability, ray-to-wall distance). Methods use `this`
// (the ArenaScene); composed onto the scene prototype via Object.assign.
import { ART_SCALE } from '../../art/index.js';
import { hexToPixel, pixelToHex, axialKey, hexesWithinPixelRadius, hexesAlongSegment, neighbors, hexCorners, HEX_SIZE } from '../../data/hexgrid.js';
import {
  getTerrain, terrainSpeedFactor, isPassable, damageBuilding, rubbleFor,
  shotBlockedAt, flameCoverDamage, coverBlocksForRay, isSoftCover,
  clearedSoftCoverFor, SOFT_COVER_CLEAR_HP, SOFT_COVER_CATCH_DAMAGE,
} from '../../data/terrain.js';
import {
  makeWallEdgeSet, wallEdgeAt, wallEdgeCrossing, wallEdgeSeparating, nearestWallEdge, damageWallEdge, liveWallEdges,
  WALL_THICKNESS_PX, WALL_STOMP_FACTOR, isOutwardOfSpan,
} from '../../data/wallEdges.js';
import { drawWallEdges } from '../../art/wallArt.js';
import { getBiome, DEFAULT_BIOME } from '../../data/biomes.js';
import { terrainFillColor, isBoundaryTerrainId, isCoverCanopyId, canopyTexKey } from '../../art/hexArt.js';
import {
  generateTerrain, generateSpine, corridorHexSet, boundaryRingKeys, mulberry32,
  safeZoneKeys, MAX_WORLD_RADIUS, spineSpawnHex,
} from '../../data/worldgen.js';
import { Audio } from '../../audio/index.js';
import {
  DUMMY_HEX, crushDamage, groundEnemyRadius, circleContains, DEPTH,
  isSmallUnit, crushTriggerRadius, ENEMY_COLLIDE_RADIUS_MECH, GATE_PIP_HIT_RADIUS,
} from './shared.js';
import { listenerOf, livePlayersOf } from './players.js';

// #41: how fast a mech crushes an outpost it's stomping (HP/sec at full drive-in speed). Sized
// against ordinary walk-through cover (forest/wreck 40, scrub/drift/fumarole 30, all unchanged by
// #313), so ~1s of leaning at speed flattens a bush or a wreck. Base STRUCTURES are a different
// story after #313's retune — a sealed dock or objective at 200 takes several seconds of leaning,
// and a wall span takes the extra WALL_STOMP_FACTOR quarter-rate penalty on top. Note the nominal
// rate here is NOT what a structure actually experiences: `speedFrac` below collapses once the
// mech stalls against the thing it's pushing on, so real stomp times run far longer than
// hp/STOMP_DPS suggests (#313 measured 51s to ram a 200hp wall span vs 1.8s to shoot it). That
// gap is the intent — stomping stays for incidental scenery, shooting is how you take down a
// fortification. Owner: tunable.
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
// #321: chunk size for the #222 boundary outline. Sized against CULL_MARGIN_PX (1200): large
// enough that the whole world is only a few dozen Graphics objects rather than thousands of
// tiny ones (each carries its own draw call and state change, so over-chunking trades one cost
// for another), small enough that a chunk is a meaningful fraction of the margined view and
// culling actually discards most of the corridor.
const OUTLINE_CHUNK_PX = 1024;
// #321: the static Graphics layers cull on a TIGHTER margin than the tiles do. CULL_MARGIN_PX's
// 1200px exists to make the tiles' expensive full recompute rare; flipping `.visible` on a handful
// of Graphics is free by comparison, so the only real constraint is pop-in. Visibility is decided
// against the view rect as it stood at the last recompute, and a recompute happens whenever the
// camera centre moves CULL_RECHECK_PX (300), so any margin above 300 makes pop-in impossible —
// 400 keeps 100px of slack. Tighter culling is what actually pays here: at the 1200px margin three
// of the five wall rings stayed on screen at once.
const GFX_CULL_MARGIN_PX = 400;

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

// #222 (5th playtest pass): maps a neighbour-direction index (as returned by hexgrid.js's
// `neighbors(q, r)`, which iterates its internal DIRECTIONS array in a fixed order) to the
// `hexCorners()` edge index that geometrically faces that same neighbour — edge `e` is the
// segment from `corners[e]` to `corners[(e + 1) % 6]`. Derived analytically (not empirically)
// from the two independent angle conventions already in hexgrid.js: `hexToPixel`'s pointy-top
// axial formula gives each of the 6 DIRECTIONS entries a real-world bearing (0°, -60°, -120°,
// 180°, 120°, 60°, in DIRECTIONS order), and `hexCorners`' `60*i - 90` puts corner i at -90°,
// -30°, 30°, 90°, 150°, 210° — so edge i (the corners[i]..corners[i+1] midpoint) sits at
// bearing `60*i - 60`. Matching each direction's bearing to the edge with the same bearing
// gives this fixed table; neither hexgrid.js function exposes the mapping directly since edges
// are a rendering-only concept it otherwise has no reason to know about.
const NEIGHBOR_EDGE = [1, 0, 5, 4, 3, 2];

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
    // #311: published so later same-run setup passes that need randomness can derive their own
    // deterministic generator from the run's seed instead of reaching for bare `Math.random`
    // (bases.js `_spawnDormantUnits` rolls each dock's resupply cadence/phase off this).
    this._worldSeed = seed;
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
    // #269 (spawn rear-pad fix): the player now spawns at the spine's own starting sample
    // (u = -rearPad, `spineSpawnHex`) instead of world origin (u=0) — real corridor terrain
    // already gets carved all the way back to there, so this uses that already-generated
    // rear-pad stretch instead of leaving it sitting behind the player unused. `this._spawnHex`/
    // `this._spawnPoint` are exposed so `create()` (below `_buildWorld()` in the caller) can set
    // `this.px/this.py` to a real hex centre rather than a raw, possibly-off-grid spine sample.
    const spawnHex = spineSpawnHex(spine);
    this._spawnHex = spawnHex;
    this._spawnPoint = hexToPixel(spawnHex.q, spawnHex.r);
    const includedKeys = corridorHexSet(spine.points, undefined, safeZoneKeys(spawnHex, 3));
    const boundaryRing = boundaryRingKeys(null, { insideKeys: includedKeys });
    this._boundaryRing = boundaryRing;   // exposed for tests/smoke

    // #275 (redesign): the map gets exactly `BASE_COUNT` alert towers, one placed solo per GAP
    // between successive bases along the corridor's spine progression (`placeGapTowers`,
    // data/worldgen.js) — no "outpost" concept or biome-tuned count involved anymore.
    const dummyKey = axialKey(DUMMY_HEX.q, DUMMY_HEX.r);
    // #269: `safeCenter` now follows the moved spawn point (`spawnHex`) instead of the world-
    // origin default, so the guaranteed-clear radius-3 disc actually surrounds where the player
    // stands — not just wherever generically falls inside the corridor.
    const { terrain, buildingHp, coverHp, bases, alertTowers, wallEdges } = generateTerrain({
      seed, worldRadius: this.worldRadius, biome: B, extraClear: [dummyKey],
      includedKeys, boundaryRing, spine, safeCenter: spawnHex,
    });
    // #269 §3: the run's bases (dormant docks + turret emplacements), placed once here at
    // world-gen time. `this.bases` feeds `_spawnDormantUnits`/`_wakeBase` (scenes/arena/
    // bases.js). #275: alert towers are now placed one per gap between bases
    // (`placeGapTowers`, data/worldgen.js) — same `generateTerrain` result field,
    // `this.alertTowerHexes`, feeds `_initAlertTowers`/`_updateAlertTowers`/`_spawnTowerPatrols`
    // (same file) completely unchanged; only WHERE the positions in that list came from moved.
    this.bases = bases;
    this.alertTowerHexes = alertTowers;
    // #288 (rebuilt as edge geometry): each base's approach wall, as destructible spans living on
    // the BOUNDARIES between hexes rather than on hexes of their own — so the barrier eats none of
    // the play space it crosses. This is a completely separate layer from `this.terrain`: nothing
    // about passability, LOS, or tile art reads a "wall" terrain id anymore (there isn't one). The
    // world queries below (`_blocked`/`_blockedAlongSegment`/`_isWall*`/`_wallDistance*`) each
    // consult this set alongside the terrain map.
    this.wallEdges = makeWallEdgeSet(wallEdges ?? []);
    // #321: per-ring wall Graphics + their world bounds, populated by `_redrawWallEdges`.
    this._wallGfxByBase = new Map();
    this._wallGfxBounds = new Map();
    // #309: one sally-port cycle per gate span, all shut. Must run after the set exists and
    // before the first `_updateGates` tick.
    this._initGates?.();

    this.terrain = terrain;
    this.buildingHp = buildingHp;   // hexKey → remaining HP for destructible OUTPOST (solid) hexes
    // #72: destructible SOFT cover (forest/scrub/drift…) keeps its HP in a separate map so the
    // mission/run objective logic — which reads `buildingHp` as "the standing outposts" — never
    // designates a tree as an assault target. `_damageBuildingAt` chips/flattens both alike.
    this.coverHp = coverHp;      // hexKey → remaining HP for destructible soft-cover hexes
    // #405: soft cover is destructible again, but ONLY by the shots the foliage CATCHES — so its
    // clear-HP lives in its OWN map, entirely separate from `buildingHp`/`coverHp`. Those two feed
    // the targeting/lock/convergence pool (`_destructibleTargetsNear`/`_destructibleStandingAt`);
    // `softCoverHp` deliberately does NOT, which is what keeps clearing woods incidental — never a
    // thing the reticle or an enemy targets. Seeded below from every standing soft-cover hex.
    this.softCoverHp = new Map();  // hexKey → remaining clear-HP for a standing soft-cover hex (#405)
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
    // #289: cover terrain (forest/scrub/drift/wreck/fumarole) gets a SECOND Image — the tree/
    // foliage canopy overlay (hexArt.js's separate canopy texture pass), placed at the same hex
    // centre but at DEPTH.COVER_CANOPY (above ground units, below the player/large units) so a
    // small ground unit standing in cover renders between the two: visible under the canopy
    // instead of fully hidden beneath, or drawn flat on top of, one combined tile. Non-cover
    // hexes are completely unaffected — still exactly one Image, unchanged.
    this.canopyImages = new Map();   // hexKey → the canopy overlay Image, cover hexes only
    for (const [k, id] of this.terrain) {
      if (isBoundaryTerrainId(getTerrain(id).tex)) continue;
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      const tex = getTerrain(id).tex;
      const img = this.add.image(x, y, tex).setScale(1 / ART_SCALE).setDepth(DEPTH.TERRAIN);
      this.tileImages.set(k, img);
      // #405: every standing soft-cover hex gets clear-HP so caught shots can wear it down.
      if (isSoftCover(id)) this.softCoverHp.set(k, SOFT_COVER_CLEAR_HP);
      if (isCoverCanopyId(tex)) {
        const canopy = this.add.image(x, y, canopyTexKey(tex)).setScale(1 / ART_SCALE).setDepth(DEPTH.COVER_CANOPY);
        this.canopyImages.set(k, canopy);
      }
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

    // #222 (5th playtest pass): "that's looking decent, but can we make some kind of subtle
    // outline of the map portion?" — the flat per-biome fill above reads clean but now gives the
    // playable corridor's silhouette NO visible edge at all; it just fades into a solid colour.
    // Trace a subtle line along the actual boundary: for every PLAYABLE hex (never a boundary-
    // only id — same `isBoundaryTerrainId` skip the tile loop above uses), walk its 6 neighbours
    // via `neighbors` (hexgrid.js — the same neighbour-adjacency check the #222 3rd-pass sunken-
    // shadow ring used to find true coastline tiles, before the 4th pass replaced per-tile
    // shadow art with this flat camera-colour fill and dropped the `neighbors` import). Any
    // neighbour that's boundary-only terrain, OR isn't in `this.terrain` at all (the corridor's
    // own outer rim, past the generated map entirely), means THIS hex edge faces the fill — so
    // stroke only that one edge (`hexCorners` + `NEIGHBOR_EDGE` above pick the exact corner pair
    // facing that neighbour), never the hex's other edges, which face playable ground and need
    // no cue. One Graphics object, drawn once here since the layout is static after generation
    // (#111) — never redrawn per-frame, and purely visual: it reads `this.terrain` but writes
    // nothing back, so passability/LOS/pathing are completely unaffected.
    // #321 (frame rate): chunked into a coarse spatial grid rather than one world-spanning
    // Graphics, for the same reason as the wall rings below — Phaser re-tessellates a visible
    // Graphics object's whole command buffer every frame with no culling, and this outline
    // measured 3,787 commands covering the entire 5700px corridor. #237 flagged it as "not
    // covered by tile culling" but measured no cost back when the world was smaller; #308's
    // longer corridor is what made it matter.
    //
    // Arbitrary spatial chunking is safe HERE (but not for the wall) because every segment is
    // the same uniform stroke — one `lineStyle`, nothing but `lineBetween` — so there are no
    // overlapping fill passes whose interleaving a chunk seam could change. Chunks are keyed by
    // the hex's own centre, so a hex's six edges always land in one chunk together.
    this._outlineChunks = new Map();
    this._outlineBounds = new Map();
    const outlineFor = (x, y) => {
      const k = `${Math.floor(x / OUTLINE_CHUNK_PX)},${Math.floor(y / OUTLINE_CHUNK_PX)}`;
      let g = this._outlineChunks.get(k);
      if (!g) {
        g = this.add.graphics().setDepth(DEPTH.GROUND_FX);
        g.lineStyle(2, 0xf4f1e6, 0.14);
        this._outlineChunks.set(k, g);
        const [cxi, cyi] = k.split(',').map(Number);
        // Padded by a hex radius so a segment drawn near a chunk's edge can't be culled early.
        this._outlineBounds.set(k, {
          minX: cxi * OUTLINE_CHUNK_PX - HEX_SIZE, minY: cyi * OUTLINE_CHUNK_PX - HEX_SIZE,
          maxX: (cxi + 1) * OUTLINE_CHUNK_PX + HEX_SIZE, maxY: (cyi + 1) * OUTLINE_CHUNK_PX + HEX_SIZE,
        });
      }
      return g;
    };
    const corners = hexCorners();
    for (const [k, id] of this.terrain) {
      if (isBoundaryTerrainId(getTerrain(id).tex)) continue;
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      const outline = outlineFor(x, y);
      const nbrs = neighbors(q, r);
      for (let i = 0; i < 6; i++) {
        const n = nbrs[i];
        const nId = this.terrain.get(axialKey(n.q, n.r));
        const facesBoundary = nId === undefined || isBoundaryTerrainId(getTerrain(nId).tex);
        if (!facesBoundary) continue;
        const e = NEIGHBOR_EDGE[i];
        const c0 = corners[e];
        const c1 = corners[(e + 1) % 6];
        outline.lineBetween(x + c0.x, y + c0.y, x + c1.x, y + c1.y);
      }
    }

    // #288: the wall line itself — one Graphics object for the whole run, stroked as thickened
    // bands along the hex boundaries (art/wallArt.js). Drawn at COVER_CANOPY depth, the tier used
    // for tall standing scenery: small ground units read as being BEHIND the wall while the player
    // mech towers over it. Redrawn only when a span takes damage or falls (`_redrawWallEdges`),
    // never per frame — the layout is static after generation (#111).
    // #321 (frame rate): ONE Graphics per base WALL RING rather than one for the whole world.
    //
    // Phaser's WebGL Graphics pipeline re-walks and re-tessellates a Graphics object's ENTIRE
    // command buffer every frame it is visible — there is no retained geometry and no culling,
    // so a Graphics costs the same whether it is on screen or 5000px away. The single
    // world-spanning wall Graphics measured 16,835 commands, every one of them re-tessellated
    // 60x a second, for geometry that is static and almost entirely off-screen. That cost
    // scales with WORLD size, not with what the player can see, which is why #308's bigger
    // world (five bases, longer corridor) hurt without entity counts moving at all (#326).
    //
    // Splitting per ring makes the cost scale with what's actually near the camera: rings are
    // spatially disjoint (verified: five rings, zero bounding-box overlap), and every pass in
    // `drawWallEdges` is per-span and position-local — the junction pillars are drawn at both
    // endpoints of every span unconditionally, not derived from the span set — so a ring drawn
    // into its own Graphics is pixel-identical to the same ring drawn into a shared one. The
    // disjointness is what makes it safe: each chunk repeats the full pass sequence, so
    // chunks that OVERLAPPED could interleave their layers differently at the seam. Rings
    // don't touch, so they can't.
    this._wallGfxByBase = new Map();
    this._wallGfxBounds = new Map();
    this._redrawWallEdges();
  },

  // #288: repaint the wall line from its current per-span HP/destroyed state. Cheap (a few dozen
  // spans across the whole run) and only called on a hit or a collapse.
  // The `clear` check keeps this a no-op against the minimal `add.graphics()` stubs the headless
  // scene tests use (they only stand up the handful of Graphics methods their own subject needs) —
  // same tolerance the rest of the mixin already shows toward partially-stubbed scene objects.
  _redrawWallEdges() {
    if (!this.wallEdges || typeof this.add?.graphics !== 'function') return;
    // #321: group by ring and repaint each ring into its OWN Graphics (see `_buildWorld` for why).
    // Grouping is by `baseId`, the span field the generator already stamps on every edge; a span
    // without one (none today, but the field is optional in the data model) falls into a shared
    // 'loose' bucket rather than being dropped, so nothing can ever silently stop being drawn.
    const byBase = new Map();
    for (const e of this.wallEdges.edges.values()) {
      const k = String(e.baseId ?? 'loose');
      if (!byBase.has(k)) byBase.set(k, []);
      byBase.get(k).push(e);
    }
    for (const [k, edges] of byBase) {
      let g = this._wallGfxByBase.get(k);
      if (!g) {
        // #337 v3: DEPTH.WALLS (2.95), lifted from COVER_CANOPY (2.5) — above the now fully-opaque
        // fog overlay, which since v3 covers the ring of hexes these spans line. See DEPTH.WALLS.
        g = this.add.graphics().setDepth(DEPTH.WALLS);
        // The `clear` check keeps this a no-op against the minimal `add.graphics()` stubs the
        // headless scene tests use (they only stand up the handful of Graphics methods their own
        // subject needs) — same tolerance the rest of the mixin already shows toward
        // partially-stubbed scene objects.
        if (typeof g?.clear !== 'function') return;
        this._wallGfxByBase.set(k, g);
      }
      // #309: `time.now` is still threaded through for any time-varying span art. The gate's leaves
      // animate off their own `openFrac` rather than off the clock, so nothing here pulses any
      // more — the barrier field that used to went away with the playtest change (wallArt.js
      // `drawGate`).
      drawWallEdges(g, edges, WALL_THICKNESS_PX, this.time?.now ?? 0);
      // Bounds are recomputed on every repaint rather than cached at build time, because a span
      // collapsing changes which geometry the ring actually covers. Padded by the wall thickness
      // so the stroke's outer edge can never be culled a pixel early.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const e of edges) {
        minX = Math.min(minX, e.x0, e.x1); maxX = Math.max(maxX, e.x0, e.x1);
        minY = Math.min(minY, e.y0, e.y1); maxY = Math.max(maxY, e.y0, e.y1);
      }
      const pad = WALL_THICKNESS_PX;
      this._wallGfxBounds.set(k, { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad });
    }
    // Re-apply culling immediately: a ring repainted while off-screen must not pop back to
    // visible just because it was redrawn (a fresh Graphics defaults to visible).
    this._cullWallGfx();
  },

  // #321: show only the wall rings whose bounds intersect the margined camera view. An invisible
  // Phaser Graphics is skipped by the renderer entirely, so a culled ring costs nothing — which is
  // the whole point of splitting them up. Called from `_updateTileCulling` (already rate-limited by
  // `CULL_RECHECK_PX`, so this adds no new per-frame work) and after any repaint.
  _cullWallGfx(view = this._lastCullView, margin = GFX_CULL_MARGIN_PX) {
    if (!view || !this._wallGfxByBase) return;
    for (const [k, g] of this._wallGfxByBase) {
      const b = this._wallGfxBounds.get(k);
      if (!b || typeof g?.setVisible !== 'function') continue;
      const on = b.maxX >= view.x - margin && b.minX <= view.x + view.width + margin
        && b.maxY >= view.y - margin && b.minY <= view.y + view.height + margin;
      if (g.visible !== on) g.setVisible(on);
    }
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
    // #321: stashed so `_redrawWallEdges` can re-apply culling to a ring it repaints between
    // recomputes (a freshly created Graphics defaults to visible).
    this._lastCullView = view;
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
      // #289: the cover canopy overlay (if any) follows its ground tile's visibility exactly —
      // same culling ring, same on/off transitions — so it's never left visible over a culled-out
      // ground tile or vice versa.
      const canopy = this.canopyImages?.get(k);
      if (canopy) canopy.setVisible(true);
    }
    for (const k of this._visibleTiles) {
      if (nextVisible.has(k)) continue;
      const img = this.tileImages.get(k);
      if (img) img.setVisible(false);
      const canopy = this.canopyImages?.get(k);
      if (canopy) canopy.setVisible(false);
    }
    this._visibleTiles = nextVisible;

    // #321: the static world-spanning Graphics layers ride the SAME rate-limited recompute as the
    // tiles — no new per-frame work, and they share the tiles' 1200px margin so a layer is never
    // culled before the ground under it is.
    this._cullWallGfx(view, GFX_CULL_MARGIN_PX);
    if (this._outlineChunks) {
      for (const [k, g] of this._outlineChunks) {
        const b = this._outlineBounds.get(k);
        if (!b || typeof g?.setVisible !== 'function') continue;
        const m = GFX_CULL_MARGIN_PX;
        const on = b.maxX >= view.x - m && b.minX <= view.x + view.width + m
          && b.maxY >= view.y - m && b.minY <= view.y + view.height + m;
        if (g.visible !== on) g.setVisible(on);
      }
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

  // The CENTRE pixel of the hex under a world point (#374 block-visual): used by the origin-less
  // fallback of `_softCoverStopsShot` to detonate a foliage puff at the target's own hex centre.
  _hexCenterAt(x, y) {
    const h = pixelToHex(x, y);
    return hexToPixel(h.q, h.r);
  },

  // Does a world point block line-of-sight (cover / projectile blocker)? Forest + buildings do;
  // open grass, river, and deep water do not (you can shoot over water and rubble).
  // #72: `transparent` (optional Set of hex keys) lists hexes that are see-through for THIS
  // ray — the shooter's muzzle hex and the target's own hex — so soft cover never protects its
  // own occupant. Solid cover blocks regardless (the pure rule lives in terrain.js). #269:
  // #374 removed the `smallUnitInvolved` size-tier parameter this used to thread: soft cover no
  // longer blocks any ray geometrically (see terrain.js `coverBlocksForRay`), so what remains here
  // is the hard-cover/wall test.
  // #288: a standing wall span is solid to sight and fire exactly like a solid terrain hex is —
  // checked in ADDITION to the terrain rule, never instead of it, and never exempted by the own-hex
  // soft-cover transparency (`transparent`), which only ever applied to walk-through cover.
  // #310 `ignoreSpanKey`: one span this ray does not see — the parapet under a wall turret that is
  // either the shooter or the thing being shot at. See wallEdges.js `wallEdgeAt`.
  _isWall(x, y, transparent = null, ignoreSpanKey = null) {
    const k = this._hexKeyAt(x, y);
    if (shotBlockedAt(this.terrain.get(k), k, transparent)) return true;
    return !!wallEdgeAt(this.wallEdges, x, y, WALL_THICKNESS_PX, ignoreSpanKey);   // #309: see through an open gate
  },

  // #426: is `(x, y)` on the EXPOSED side of the span keyed `spanKey` — the side a wall turret
  // riding on it is meant to be freely hittable from? A missing span (bad key, already collapsed)
  // fails CLOSED — not exposed — so a stale/garbage key can never open a shot through a wall.
  // Pure geometry lookup; see wallEdges.js `isOutwardOfSpan` for the actual side test.
  _spanExposedTo(spanKey, x, y) {
    const edge = this.wallEdges?.edges?.get(spanKey);
    return !!edge && isOutwardOfSpan(edge, x, y);
  },

  // #168: like `_isWall`, but the see-through set is the UNION of a shared per-frame Set (all
  // living enemy hexes for a player round, or the player's own hex for an enemy round — built
  // once per frame and reused across every round of that owner) and this round's own tiny
  // `originHexes` array. Checked in place so no fresh combined Set is allocated per round per
  // frame. Behaviourally identical to `_isWall(x, y, new Set([...originHexes, ...shared]))`;
  // only the allocation is removed. Defers to `coverBlocksForRay` (terrain.js) — the same shared
  // decision `shotBlockedAt`/`_wallDistanceLos` use — so the cover rule can't drift between the
  // three call sites. #374: the size-tier parameter is gone — see `_isWall` above.
  _isWallForRound(x, y, sharedTransparent, originHexes, ignoreSpanKey = null) {
    const k = this._hexKeyAt(x, y);
    const id = this.terrain.get(k);
    const ownHexExempt =
      (sharedTransparent != null && sharedTransparent.has(k)) ||
      (originHexes != null && originHexes.includes(k));
    if (coverBlocksForRay(id, ownHexExempt)) return true;
    return !!wallEdgeAt(this.wallEdges, x, y, WALL_THICKNESS_PX, ignoreSpanKey);   // #288/#309 — see `_isWall`
  },

  // #374 REWORK: the SOFT-COVER LANE for one shot — every soft-cover hex between the muzzle and
  // the point the shot resolved at, as `[{ id, ownHex }, …]` for terrain.js `softCoverStopsShot`.
  //
  // WHY THIS SHAPE, and what it costs. Soft cover is now a per-hex 10% roll along the whole lane
  // rather than one lookup on the target's hex, so the lane must be walked. It reuses the
  // traversal the codebase already owns — `hexesAlongSegment` (hexgrid.js), the same interpolated
  // cube-rounded walk `_damageHexesAlongSegment`/wayfinding use — rather than adding a second,
  // differently-shaped walk or a fresh 8px pixel march. That makes the cost proportional to the
  // number of HEXES crossed, not pixels: a 400px lane is ~5 hexes ⇒ ~5 `cubeRound`s, ~5 key
  // strings and ~5 terrain lookups, versus `_wallDistanceLos`'s ~50 pixel samples. It is
  // deliberately NOT folded into the LOS raycast: that runs per enemy per frame (staggered/cached,
  // `_cachedLosToPlayer`) and answers a DISTANCE question, while this runs ONCE per shot that has
  // already resolved onto a unit. Net cost is therefore well under one cached-LOS raycast per hit
  // — cheaper than the geometry it sits beside — plus one rng draw per soft hex actually crossed
  // (at most ~5, usually 0–1, and the loop short-circuits on the first hex that blocks).
  //
  // THE OWN-HEX EXEMPTION (#72/#279) IS THE OMISSION OF THE MUZZLE HEX: `originHexes` (the
  // shooter's muzzle + body hex, stamped at spawn) and the muzzle point's own hex are skipped, so
  // a shooter standing in the target's own thicket produces an EMPTY lane and no roll at all —
  // exactly the old behaviour, now falling out of the traversal instead of needing its own flag.
  // The target's own hex is marked `ownHex`, which is what earns it the vehicle 25% / mech 10%
  // destination chance instead of the standard 10% (a bump that REPLACES the base chance — one
  // roll per hex, never two).
  //
  // Hard cover is not this function's business: a lane that crosses a wall never reaches here,
  // because the shot detonated on it (`_isWallForRound` / `_hitscanReach`).
  // Each lane entry carries the hex's CENTRE pixel (`hexToPixel`) alongside its `id`/`ownHex`, so
  // that when `softCoverStopsShot` names the blocking hex the projectile code can detonate the
  // foliage puff at that hex's middle (mid-lane), reading as the trees eating the round rather than
  // a weapon impact at the target. Pure geometry — the same `hexToPixel` this file already uses.
  _softCoverLane(x0, y0, x1, y1, originHexes = null) {
    const lane = [];
    const seen = new Set(originHexes || []);
    seen.add(this._hexKeyAt(x0, y0));
    const targetHex = pixelToHex(x1, y1);
    const targetKey = axialKey(targetHex.q, targetHex.r);
    for (const h of hexesAlongSegment(x0, y0, x1, y1)) {
      const k = axialKey(h.q, h.r);
      if (k === targetKey || seen.has(k)) continue;
      seen.add(k);                                    // never roll one hex twice for one shot
      const id = this.terrain.get(k);
      if (isSoftCover(id)) {
        const c = hexToPixel(h.q, h.r);
        lane.push({ id, ownHex: false, x: c.x, y: c.y });
      }
    }
    // The destination hex, always last and always the `ownHex` one — appended explicitly rather
    // than taken from the walk so it can't be missed when the muzzle and target share a hex
    // (in which case `seen` already holds it and the lane stays empty — the brawling exemption).
    if (!seen.has(targetKey)) {
      const id = this.terrain.get(targetKey);
      if (isSoftCover(id)) {
        const c = hexToPixel(targetHex.q, targetHex.r);
        lane.push({ id, ownHex: true, x: c.x, y: c.y });
      }
    }
    return lane;
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
  // #288: standing wall spans block movement the same way impassable terrain does. This point form
  // is what the ENEMY movement integrators use (their per-frame steps are small relative to the
  // wall's thickness); the player's own movement goes through the swept `_blockedAlongSegment`
  // below, which is exact at any speed.
  // #309 playtest ("player should be able to pass through the gate when it's open, it just
  // shouldn't open FOR the player"): there is now ONE movement query, not a player form and an
  // enemy form. An open gate is passable to everyone, so the `passOpenGates` argument this used to
  // take — and the `_blockedForEnemy` alias that opted into it — are gone. A gate the player can
  // see standing open is one he can drive through; what he cannot do is cause it to open.
  // #320: `radius` is the moving unit's own body radius (`wallCollideRadius`, shared.js). It
  // defaults to 0, so every point-shaped caller — powerup placement, spawn scans, both of #288's
  // seal proofs — is bit-for-bit unchanged; only the movement integrators opt in, and they pass
  // the radius of the specific unit being moved rather than one flat value.
  _blocked(x, y, radius = 0) {
    if (!isPassable(this._terrainAt(x, y))) return true;
    return !!wallEdgeAt(this.wallEdges, x, y, WALL_THICKNESS_PX, null, radius);
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
  // #288: the wall half of this is a true SEGMENT-CROSSING test, not a lookup — a wall lives on a
  // line between hexes and has no tile to look up, and its 14px painted thickness is far thinner
  // than a fast mech's frame movement, so only "did this step cross the span" is safe at any speed.
  // #320: `radius` inflates only the WALL half of this test — the terrain half stays a hex-tile
  // lookup, because a tile obstacle is a whole hex and the mech has always been allowed to stand
  // with its shoulders over a neighbouring tile's border. Walls are the thing that reads wrong
  // when a body overlaps them, because a wall IS the border.
  // #369: `ignoreKey` is one span, by canonical key, this query pretends is not there — the same
  // escape hatch `wallEdgeCrossing`/`wallEdgeAt` already carry for #310's wall turrets, surfaced on
  // the swept scene query because the gate nudge needs it. Its one caller is a body being pushed
  // out of the mouth of the very gate that just closed on it: that span must not veto the escape it
  // caused, while every OTHER wall and all terrain still must. Defaults to null, so every existing
  // caller (locomotion, separation, the leash clamp) is bit-for-bit unchanged.
  _blockedAlongSegment(x0, y0, x1, y1, radius = 0, ignoreKey = null) {
    for (const h of hexesAlongSegment(x0, y0, x1, y1)) {
      if (!isPassable(this.terrain.get(axialKey(h.q, h.r)))) return true;
    }
    return !!wallEdgeCrossing(this.wallEdges, x0, y0, x1, y1, WALL_THICKNESS_PX, ignoreKey, radius);
  },

  // #92: does a living GROUND enemy unit's collision circle cover world point (x, y)? Flying
  // kinds (helicopter/drone) narratively fly over ground obstacles, so they're excluded — only
  // mechs, tanks, turrets, and (#104) infantry can physically block the player. Returns the
  // blocking enemy (so the caller can special-case a crushable one — see #269's `isSmallUnit`
  // in shared.js — for instant-kill damage), or null if nothing there blocks.
  _blockedByGroundEnemy(x, y) {
    for (const e of this.enemies) {
      if (e.flying) continue;
      if (e.mech.isDestroyed()) continue;
      if (circleContains(x, y, e.x, e.y, groundEnemyRadius(e))) return e;
    }
    return null;
  },

  // #361: THE ENEMY-vs-ENEMY HALF OF THIS RULE IS GONE. What remains is "a ground unit may not
  // step into a PLAYER's body," which is the same shape as `_blockedByGroundEnemy` above (the
  // player's half of the same pair) and is safe as a hard block because a human can always steer
  // out of the contact. Unit-vs-unit is now SOFT SEPARATION (`data/groundSeparation.js`, applied
  // once per tick in enemies.js `_updateEnemies`), because the hard block below deadlocked a
  // garrison in a gate mouth exactly as #282's `_blockedByOtherFlyer` deadlocked drone piles —
  // playtest 2026-07-19: "a bunch of tanks got piled up at a base gate and couldn't get out."
  // Two movers each rejecting every candidate move because the other is standing in it is not a
  // collision rule, it is a livelock. The size-tier rule the old comment describes below survives
  // in spirit as the separation module's MASS tiers: a tank absorbs nearly all of a tank-vs-mech
  // push, a turret (immobile, infinite mass) absorbs none and stays the wall it always was.
  //
  // HISTORICAL (the deleted enemy-vs-enemy behaviour, kept because the tier reasoning still
  // informs the mass tiers):
  // #282: mutual ground-unit collision — the counterpart to `_blockedByGroundEnemy` above, but
  // called from an ENEMY's own movement integration (enemies.js `_updateEnemy`/`_updateVehicle`)
  // instead of only the player's. (Formerly `_blockedByOtherLargeUnit`, which only ever handled
  // a LARGE `self` — renamed + generalized for #282's follow-up: playtest found tanks visibly
  // overlapping each other, "seems like tanks can nearly be on top of one another," because
  // small-vs-small was deliberately left uncollided in the original scope.)
  //
  // Tier rule (kept deliberately simple/consistent with how the player already treats these
  // tiers, rather than inventing a new one): a LARGE obstacle (mech/carrier/turret) blocks
  // ANY other ground unit's movement, small or large — a tank/infantry unit shouldn't be able
  // to drive through a standing mech/turret any more than the player can (`_blockedByGroundEnemy`
  // already blocks the player against every ground enemy regardless of size). A SMALL obstacle
  // (tank/infantry) only blocks OTHER SMALL units — it stays a non-obstacle to large units,
  // unchanged from before this fix (large enemies still walk through tanks/infantry; only the
  // player gets the special instant-crush treatment for those, via `_crushGroundEnemyAt` — see
  // its comment). So:
  //   • self LARGE — blocked by the player + other LARGE units. (unchanged from before #282)
  //   • self SMALL — blocked by the player + LARGE units + other SMALL units (the fix: small
  //     units used to skip this check entirely and pass through everything for their own
  //     movement; now they respect both tiers, matching the player's own treatment of large
  //     obstacles while still not being obstacles to large units themselves).
  //
  // Checks the PLAYER's own collision circle too (`ENEMY_COLLIDE_RADIUS_MECH` — the player is
  // drawn at the same ARENA_MECH_SCALE as an enemy mech, so it shares that radius) so a large
  // enemy can't walk through the player any more than the player can already walk through it —
  // this stays unconditional (not tier-gated) since the player is always effectively "large."
  // `self` is excluded from the enemy scan so a unit never blocks against its own circle.
  _blockedByOtherGroundUnit(self, x, y) {
    // #347: EVERY player is a solid obstacle to a ground unit, not just "the" player.
    for (const pl of livePlayersOf(this)) {
      if (circleContains(x, y, pl.x, pl.y, ENEMY_COLLIDE_RADIUS_MECH)) return true;
    }
    // #361: no enemy scan here any more — see the note above. `self` is accepted and ignored so
    // every call site keeps its signature.
    void self;
    return false;
  },

  // #282 (follow-up: "piles of drones are stuck on each other"): flyer-vs-flyer collision used to
  // live here as `_blockedByOtherFlyer` — a HARD positional block that rejected any flyer move
  // overlapping another flyer's circle. That gridlocked a dense swarm (every drone in a spawn pile
  // overlaps its neighbours, so every candidate move was rejected and nothing could separate). It
  // was replaced by SOFT boids separation in the flyer behaviours themselves (enemyBehaviors.js
  // `flyerSeparation`, blended into `droneBehavior`/`helicopterBehavior`), which is always
  // resolvable — an overlapping flyer is pushed apart rather than frozen — so this method was
  // removed entirely (no movement gate remains on the flyer integration path in enemies.js).

  // #112: is a CRUSHABLE ground enemy (tank/infantry — 'small' units, see #269's `isSmallUnit`
  // in shared.js) within the (larger) crush-trigger radius of world point (x, y)? Deliberately
  // separate from `_blockedByGroundEnemy` above: that one still uses `groundEnemyRadius` alone
  // (unchanged) so general movement-blocking against a mech/turret stays exactly as tight as
  // before — only the crush trigger itself gets the player's extra reach (`crushTriggerRadius`,
  // shared.js). Only scans small units, so a nearby mech/turret (both 'large') can never satisfy
  // this check.
  _crushTargetAt(x, y) {
    for (const e of this.enemies) {
      if (e.flying) continue;
      if (!isSmallUnit(e)) continue;
      if (e.mech.isDestroyed()) continue;
      if (circleContains(x, y, e.x, e.y, crushTriggerRadius(e))) return e;
    }
    return null;
  },

  // #92 (corrected per playtest 2026-07-10): the player driving into a TANK is an INSTANT kill
  // on contact, not a multi-second grind — the original gradual-DPS crush (mirroring the outpost
  // stomp below) read as "blocked/stuck" rather than "destroying the tank." #104 (playtest:
  // infantry, the weakest unit in the game, "should be stompable" too) extends the exact same
  // instant-kill treatment to infantry — `isSmallUnit` (#269; formerly the CRUSHABLE_BEHAVIORS
  // Set) below is the scope, checked by the caller (`_drive` in locomotion.js). One call dealing
  // damage >= the enemy's entire remaining hp pool, so it dies THIS frame. Still goes through
  // combat.js `_damageEnemyAt`, so the kill runs the normal death path unchanged (explosion FX,
  // corpse teardown, powerup/salvage drop) — only the amount/pacing changed, not the destruction
  // machinery. Other ground enemies (mechs, turrets) just BLOCK via `_blockedByGroundEnemy` above
  // — no crush/instakill — per the explicit scope.
  _crushGroundEnemyAt(e) {
    if (e.mech.isDestroyed()) return;
    const dmg = (e.mech.hp ?? e.mech.maxHp) + 1;   // comfortably >= remaining hp: dies in one hit
    // #106: the trailing `true` marks this as a CRUSH kill, so the powerup drop roll uses the
    // flat CRUSH_KILL_DROP_CHANCE instead of the toughness curve — stomping a tank is free, so
    // it shouldn't pay out at a fought tank's rate.
    this._damageEnemyAt(e, e.x, e.y, dmg, 0xffffff, true);
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
    // #288: a hit that landed ON a wall span damages that span, not the (perfectly intact, merely
    // adjacent) terrain hex underneath the impact point. Checked FIRST and returns immediately, so
    // one shot never chips both a wall and a building. `nearestWallEdge`'s search radius is a touch
    // wider than the wall's own painted thickness so a round detonating against its face — which
    // stops a hair short of the centreline — still counts as hitting it.
    const wall = nearestWallEdge(this.wallEdges, x, y, WALL_THICKNESS_PX);
    if (wall) return this._damageWallEdge(wall, opts.stomp ? amount * WALL_STOMP_FACTOR : amount);
    const h = pixelToHex(x, y);
    const k = axialKey(h.q, h.r);
    const store = this.buildingHp.has(k) ? this.buildingHp : (this.coverHp.has(k) ? this.coverHp : null);
    if (!store) return false;
    const soft = store === this.coverHp;
    if (soft && opts.flame) amount = flameCoverDamage(amount);
    const { hp, destroyed } = damageBuilding(store.get(k), amount);
    if (!destroyed) {
      store.set(k, hp);
      // #269 overhaul Part 1: a damaged-but-surviving alert tower commits to calling reinforcements
      // — flag it so the next `_updateAlertTowers` tick treats this hit as an activation trigger.
      // A KILLING blow instead collapses the hex to rubble below (destroyed branch), where the
      // per-tick `terrain.get(key) !== 'alertTower'` check drops the tower's state and it never
      // fires — the existing "destroy it before the countdown completes" stealth window. Optional
      // chaining: most tests/scenes never wire the alert-tower system at all.
      if (this.terrain.get(k) === 'alertTower') this._onAlertTowerDamaged?.(k);
      return false;
    }
    // Collapse to rubble: swap the terrain data (movement + LOS now read the biome's rubble) and
    // texture. `rubbleFor` maps this outpost to its biome-appropriate debris (data-driven).
    store.delete(k);
    const rub = rubbleFor(this.terrain.get(k));
    this.terrain.set(k, rub);
    const img = this.tileImages.get(k);
    if (img) img.setTexture(getTerrain(rub).tex);
    // #289: a collapsed cover hex's rubble terrain has no canopy of its own — destroy the now-
    // orphaned foliage overlay (if this hex had one) so a burned-down forest/scrub/etc. tile
    // doesn't keep showing an intact tree/foliage silhouette floating over its rubble.
    const canopy = this.canopyImages?.get(k);
    if (canopy) { canopy.destroy(); this.canopyImages.delete(k); }
    const { x: cx, y: cy } = hexToPixel(h.q, h.r);
    this._outpostCollapseFx(cx, cy, soft);
    // #269 Part 2: generic hook for anything that needs to react to a SPECIFIC hex collapsing
    // (currently only a closed dock, whose resupply must be permanently retired the instant it's
    // destroyed — see bases.js `_onTerrainCollapsed`). No-op for every other destructible hex;
    // optional chaining since most scenes/tests never wire a handler at all.
    this._onTerrainCollapsed?.(k);
    // #306: the hex just stopped blocking line of sight, so the player's cached field-of-view set
    // is stale — invalidate it so the dimming behind the hole clears on the next tick. This is
    // what makes "destroying cover visibly buys vision" true rather than cosmetic; without it the
    // overlay would only refresh the next time the player happened to cross a hex boundary.
    // Optional chaining: plenty of tests build a bare world without the visibility mixin.
    this._invalidateVisibility?.();
    // #312: the hex's movement cost just changed too (an impassable building collapsed into
    // walkable rubble), so every cached enemy route is stale — a unit that was routing the long
    // way around this structure can now go straight through where it stood.
    this._invalidateRoutes?.();
    return true;
  },

  // #405: chip a soft-cover hex's clear-HP because a shot's #374 block roll CAUGHT a round in it.
  // This is the ONLY thing that damages soft cover, and it is deliberately its OWN path — separate
  // from `_damageBuildingAt`/`buildingHp`/`coverHp` — because soft cover is never a targeting/lock/
  // convergence candidate (it's not in those maps). Clearing woods therefore can never compete with
  // shooting enemies; it only happens incidentally, as a side effect of fire the foliage ate.
  // Symmetric by construction: the caught-shot sites (projectiles.js / firing.js) never read who
  // fired, so an enemy round chips a hex exactly as a player round does.
  // At 0 HP the hex CLEARS to its OWN under-lump ground (`clearedSoftCoverFor` — the same hex's base
  // look, not a distinct rubble tile) and stops being cover: it no longer eats shots, slows, or
  // conceals. `key` is the hex the shot was caught in. No-op if that hex isn't standing soft cover.
  // Returns true iff this hit cleared the hex. Guards every scene-object touch with optional chaining
  // so the headless world-test doubles (no tileImages/canopy/FX) exercise the HP+clear logic cleanly.
  _damageSoftCoverHex(key, amount = SOFT_COVER_CATCH_DAMAGE) {
    if (!this.softCoverHp || !this.softCoverHp.has(key)) return false;
    const { hp, destroyed } = damageBuilding(this.softCoverHp.get(key), amount);
    if (!destroyed) { this.softCoverHp.set(key, hp); return false; }
    this.softCoverHp.delete(key);
    const cleared = clearedSoftCoverFor(this.terrain.get(key));
    if (cleared) {
      this.terrain.set(key, cleared);
      const img = this.tileImages?.get(key);
      if (img) img.setTexture(getTerrain(cleared).tex);
    }
    // The foliage canopy overlay goes with it — a cleared hex shows open ground, no floating trees.
    const canopy = this.canopyImages?.get(key);
    if (canopy) { canopy.destroy(); this.canopyImages.delete(key); }
    // A light debris puff (soft=true), same feedback a burning forest hex played before #351.
    // Gated on a real scene (`this.add`) — same stub-tolerance the rest of this mixin shows toward
    // the headless test doubles, which mix in the method but have no Phaser display list.
    const [q, r] = key.split(',').map(Number);
    const { x, y } = hexToPixel(q, r);
    if (this.add) this._outpostCollapseFx?.(x, y, true);
    // Cover just fell: vision opens up and a unit's terrain speed cost here just changed, so the
    // cached FOV and routes are stale — same invalidation `_damageBuildingAt`'s collapse runs.
    this._invalidateVisibility?.();
    this._invalidateRoutes?.();
    return true;
  },

  // #288: chip one wall span's HP, repaint the line, and — if that killed it — collapse it. A
  // destroyed span stops blocking movement, sight, and fire the instant it falls, leaving a real
  // hole in the line the player can drive through while the rest of the wall still stands. Plays
  // the same debris/fireball the other destructible structures use, centred on the span itself.
  // Returns true iff this hit destroyed the span, matching `_damageBuildingAt`'s contract.
  _damageWallEdge(edge, amount) {
    const { destroyed, felled } = damageWallEdge(this.wallEdges, edge, amount);
    this._redrawWallEdges();
    if (destroyed) {
      // #392: destroying one span opens a fixed three-span breach — `felled` is the hit span PLUS
      // its two nearest contiguous neighbours along the wall run that fell with it, so the collapse
      // FX and turret-drop below run once per fallen span, not just the one the shot/stomp landed on.
      for (const span of felled) {
        this._outpostCollapseFx((span.x0 + span.x1) / 2, (span.y0 + span.y1) / 2);
        // #310: a span that carried a wall turret takes the gun down with it — the direct analogue
        // of `_onTerrainCollapsed` -> `_killEmplacedAt` for a collapsing turret emplacement (#287),
        // and the same reasoning: a breached span must not leave its gun hovering intact over the
        // hole. Optional chaining because plenty of tests build a bare world with no bases mixin.
        this._killWallTurretsOn?.(span.key);
      }
      // #306: the span just stopped blocking sight, so the cached field-of-view set is stale —
      // breaching a base wall has to visibly reveal what was behind it, same as collapsing a tile.
      this._invalidateVisibility?.();
      // #312: THE breach case the issue calls out — the player just opened a route that every
      // cached path is unaware of. Without this, the garrison he just breached would keep
      // believing it was sealed in until its failure backoff expired.
      this._invalidateRoutes?.();
    }
    return destroyed;
  },

  // #288: the first standing wall span a swept step crosses, as `{ edge, x, y, dist }` or null —
  // the projectile-facing form of the same crossing test movement uses (projectiles.js).
  _wallEdgeHit(x0, y0, x1, y1) {
    // #309: an open gate does not stop a round — the opening is a real opening. Rounds still stop
    // on the gate's own leaves while it is shut, so the span is shootable-down like any other.
    return wallEdgeCrossing(this.wallEdges, x0, y0, x1, y1, WALL_THICKNESS_PX);
  },

  // #320, the SECOND half of "I'm able to shoot OVER walls if I stand real close." Inflating
  // movement by body radius fixes most of it, but not by construction: a shot leaves the weapon's
  // real art tip (`_muzzle`), which sits forward of the mech's centre by the part layout plus the
  // weapon's own `muzzleForward`, and nothing guarantees that reach is shorter than the radius the
  // body now stops at. Measured in the real game, a long arm weapon on a mech parked as close as
  // the game allows DOES still get its tip across the plate — and then the round's ray STARTS on
  // the far side and never crosses the span, so the wall isn't failing to stop the shot, it never
  // gets asked.
  //
  // Of the issue's two options — block the shot, or re-origin the blocking ray at the body centre —
  // this is the first, and deliberately. Re-origining would change the geometry of EVERY shot in
  // the game (spawn point, spread lateral offsets, convergence, beam endpoints, muzzle FX and
  // positional audio all key off the muzzle), to fix a case that only arises when a wall is
  // physically between the barrel and the chest. This guard is inert otherwise: a single swept
  // test over the few centimetres from centre to tip, which can only trip when a STANDING span
  // actually separates the two. Legitimate close-range fire — hugging a wall and shooting along
  // it, over a breach, through an open gate mouth, or at anything not across a plate — is
  // completely unaffected.
  //
  // Uses `wallEdgeSeparating`, NOT `wallEdgeCrossing`: only a span the barrel has genuinely got to
  // the far side of counts. A muzzle merely buried in the plate is a gun pressed against a wall,
  // and that shot must still go off so the player can breach a wall he is leaning on.
  _muzzleWallBlocked(cx, cy, mx, my) {
    if (!this.wallEdges) return false;
    return !!wallEdgeSeparating(this.wallEdges, cx, cy, mx, my);
  },

  // #288: the standing wall spans, for tests/debug and for anything that needs the live geometry.
  _liveWallEdges() {
    return liveWallEdges(this.wallEdges);
  },

  // #250: world-space centres of every currently-STANDING destructible terrain hex within
  // `maxDist` of (x, y) — outposts (`buildingHp`) and soft cover (`coverHp`) alike. Both maps
  // delete a hex's key the instant `_damageBuildingAt` collapses it to rubble, so membership in
  // EITHER map already means "still standing" — no separate live/dead bookkeeping needed. Bounded
  // to a local ring scan (`hexesWithinPixelRadius`, same trick `_updateTileCulling` above uses)
  // rather than walking either full map, so cost stays independent of how much destructible
  // terrain the map has overall. Feeds the direct-fire convergence fallback (#250: destructible
  // terrain is a convergence target — see shared.js `pickConvergeTarget`, called from targeting.js
  // `_updateLock`. #322: scanned out to the full derived TARGETING_RANGE now, not a 450px stub).
  // #318 renamed from `_destructibleHexesNear`: the pool is no longer hexes only. A base WALL SPAN
  // is destructible (200 HP, wallEdges.js) and is the single most-destroyed thing in the game, but
  // #288 rebuilt walls as hex-EDGE geometry — they have no hex key, so the hex-map scan above could
  // never see them and the reticle would not converge on the one wall you must breach to get in.
  // Spans are added here alongside hexes as one terrain pool (#262's focus toggle is gone as of
  // #322). They no longer sit structurally below enemies: #322 scores spans, hexes and enemies by
  // the same cone-then-nearest rule, so a span you're pointed at and standing next to CAN outrank a
  // distant mech — which is the point. The ~20° cone is what keeps a 25-30 span wall ring from
  // grabbing the reticle: only the couple of spans actually ahead of you ever qualify.
  //
  // Every candidate carries its IDENTITY, not just a point (#317 needs it too):
  //   • a hex   ⇒ `{ x, y, hexKey }`   — the centre of a standing destructible tile
  //   • a span  ⇒ `{ x, y, edgeKey, edge }` — the segment midpoint (`hexEdges.js` derives the
  //     endpoints from the two shared corners), plus the live record so a hit can damage it.
  // Nothing downstream may assume a hex key: `pickConvergeTarget` scores on x/y alone, and
  // firing.js discriminates on which key is present.
  //
  // GATE spans (#309) are included deliberately: a gate has HP like any other span and blowing one
  // is a permanent breach, so it would be strange to be able to shoot it down but never lock it.
  // TURRET spans (#310) are included as spans; the `wallTurret` riding on one is a separate live
  // enemy in `this.enemies`, so "shoot the gun" and "shoot the wall out from under it" are two
  // candidates competing under #322's one rule (the turret, being an enemy, gets the range edge).
  _destructibleTargetsNear(x, y, maxDist) {
    const pts = [];
    for (const h of hexesWithinPixelRadius(x, y, maxDist)) {
      const k = axialKey(h.q, h.r);
      if (this.buildingHp.has(k) || this.coverHp.has(k)) {
        const p = hexToPixel(h.q, h.r);
        pts.push({ x: p.x, y: p.y, hexKey: k });
      }
    }
    // Spans are a flat list (a ring is tens of edges, not thousands), so a straight distance
    // filter is cheaper than any spatial index would be here.
    for (const e of liveWallEdges(this.wallEdges)) {
      const mx = (e.x0 + e.x1) / 2, my = (e.y0 + e.y1) / 2;
      if (Math.hypot(mx - x, my - y) <= maxDist) pts.push({ x: mx, y: my, edgeKey: e.key, edge: e });
    }
    return pts;
  },

  // #317: is the destructible terrain hex `key` still STANDING? Membership in either HP map is
  // exactly that fact — both delete the key the instant `_damageBuildingAt` collapses it to rubble.
  // Used by the targeted-hex impact rule (projectiles.js/firing.js) so a shot only stops in its
  // target hex while there is actually something there left to hit.
  _destructibleStandingAt(key) {
    return this.buildingHp.has(key) || this.coverHp.has(key);
  },

  // #317: distance from (x0,y0) along `angle` to the first sample inside hex `key`, or Infinity if
  // the ray never enters it within `maxT`. The hitscan counterpart of the projectile's per-step
  // "am I in my target hex yet" test — a beam does not travel in steps, so its stopping point has
  // to be solved up front, exactly as `_wallDistance` solves the cover blocker's.
  _targetHexDistance(x0, y0, angle, maxT, key) {
    if (!key) return Infinity;
    const cx = Math.cos(angle), cy = Math.sin(angle);
    for (let t = 8; t < maxT; t += 8) {
      if (this._hexKeyAt(x0 + cx * t, y0 + cy * t) === key) return t;
    }
    return Infinity;
  },

  // #412, hitscan half of the targeted-open-gate rule: distance from (x0,y0) along `angle` to the
  // point where the ray comes within `GATE_PIP_HIT_RADIUS` of an open gate's PIP (its span
  // midpoint), or Infinity if the ray never grazes it within `maxT`. The beam counterpart of the
  // projectile's per-step proximity test — a beam does not travel in steps, so its stopping point
  // is solved up front, exactly as `_targetHexDistance` solves the targeted-hex one. Only ever
  // asked about the ONE open gate the player has locked, so it can never manufacture solidity in a
  // mouth the player is merely firing past.
  _targetGateDistance(x0, y0, angle, maxT, edge) {
    if (!edge) return Infinity;
    const mx = (edge.x0 + edge.x1) / 2, my = (edge.y0 + edge.y1) / 2;
    const cx = Math.cos(angle), cy = Math.sin(angle);
    // Nearest point on the ray to the pip centre, clamped to the beam's own [0, maxT] span.
    const t = Math.max(0, Math.min(maxT, (mx - x0) * cx + (my - y0) * cy));
    const px = x0 + cx * t, py = y0 + cy * t;
    return Math.hypot(px - mx, py - my) <= GATE_PIP_HIT_RADIUS ? t : Infinity;
  },

  // #41: the mech STOMPING a building it's pressed against. Applies a per-frame bite of crush
  // damage (a fixed per-second rate scaled by how fast the mech is driving into it) so leaning
  // on an outpost flattens it in a beat or two rather than instantly. No-op off buildings.
  // #365: the STOMPING player is passed in — `this.speed`/`this.mech` are co-op phase-1 (#347)
  // accessors onto players[0], so reading them here scaled every player's crush by player 1's
  // speed and chassis (P2 stomping while P1 stood still did nothing). Defaults to players[0]
  // for the single-player/no-arg case.
  _stompBuildingAt(x, y, dt, stomper = null) {
    const p = stomper || (this.players && this.players[0]) || this;
    const speedFrac = Math.min(1, p.speed / Math.max(1, p.mech.movement.maxSpeed));
    const dmg = crushDamage(STOMP_DPS, dt, speedFrac);
    // #288: `stomp` marks this as the mech LEANING on the structure rather than shooting it, so a
    // wall span can scale it down (see WALL_STOMP_FACTOR) without changing how anything else
    // stomps. Every other destructible reads the flag and ignores it.
    if (dmg > 0) this._damageBuildingAt(x, y, dmg, { stomp: true });
  },

  // Debris + fireball when an outpost is flattened (#41): a bright flash, an expanding shock ring,
  // and a scatter of dust/rubble chunks flung outward, plus a heavy explosion cue. #72: soft cover
  // (a forest hex burning/chewed down) plays a lighter version — quieter cue, smaller flash/ring.
  _outpostCollapseFx(x, y, soft = false) {
    // #264: real positional audio — the collapsing outpost's position vs. the player (listener).
    Audio.explosion(soft ? 0.45 : 1.0, { x, y, ...listenerOf(this) });
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
  _wallDistance(x0, y0, angle, maxT, transparent = null, ignoreSpanKey = null) {
    const cx = Math.cos(angle), cy = Math.sin(angle);
    // #288: the nearest standing wall span this ray crosses, resolved up front so the sampled
    // terrain scan below can stop the moment it passes that point — whichever blocker is CLOSER
    // wins, exactly as it would if walls were tiles.
    const tw = this._wallEdgeDistance(x0, y0, x0 + cx * maxT, y0 + cy * maxT, ignoreSpanKey);
    for (let t = 8; t < maxT; t += 8) {
      if (t >= tw) break;
      if (this._isWall(x0 + cx * t, y0 + cy * t, transparent, ignoreSpanKey)) return t;
    }
    return tw;
  },

  // #288: distance from (x0,y0) to the first standing wall SPAN the ray crosses, or Infinity. An
  // exact segment-crossing test rather than a sampled one, for the same reason movement uses one:
  // a wall is a line, and both ray marchers above sample coarsely (8px steps, and `_wallDistanceLos`
  // deliberately skips samples that land in the same hex as the last one) — coarsely enough that a
  // ray could otherwise slip past a span it genuinely crosses. Returns Infinity on a wall-free map
  // after a single Map-size check, so this costs nothing where there are no walls.
  // #309: sight and fire pass through an OPEN gate (the `true` below). That is the half of the
  // gate mechanic that lets a base fight back the moment it rouses, before a single unit has
  // walked out — and it is also what sells the fiction that stops the open gate reading as a bug:
  // the opening is genuinely open — you can see through it, shoot through it, and (since the #309
  // playtest) drive through it, so a hole in the wall line behaves in every way like a hole.
  // #310 `ignoreSpanKey`: ONE span this ray does not see — the parapet under a wall turret that is
  // either the shooter or the thing being shot at. See wallEdges.js `wallEdgeCrossing`'s
  // `ignoreKey` for why it exists and why it is scoped to one named span.
  _wallEdgeDistance(x0, y0, x1, y1, ignoreSpanKey = null) {
    const hit = wallEdgeCrossing(this.wallEdges, x0, y0, x1, y1, WALL_THICKNESS_PX, ignoreSpanKey);
    return hit ? hit.dist : Infinity;
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
  // therefore the same to the bit. Defers to `coverBlocksForRay` (terrain.js) — the same shared
  // decision `shotBlockedAt`/`_isWallForRound` use. #374: the size-tier parameter is gone — see
  // `_isWall` above; propagated through `_cachedLosToPlayer` so a caller with a live enemy handle
  // can pass `isSmallUnit(e)`.
  _wallDistanceLos(x0, y0, angle, maxT, x1, y1, ignoreSpanKey = null) {
    const cx = Math.cos(angle), cy = Math.sin(angle);
    const oh = pixelToHex(x0, y0);          // shooter/muzzle endpoint hex (soft-cover-transparent)
    const eh = pixelToHex(x1, y1);          // target endpoint hex (soft-cover-transparent)
    // #288: nearest wall-span crossing, same up-front resolution as `_wallDistance` above — needed
    // here in particular because this loop deliberately SKIPS samples that land in the same hex as
    // the previous one, which a point-sampled wall check could not survive.
    const tw = this._wallEdgeDistance(x0, y0, x0 + cx * maxT, y0 + cy * maxT, ignoreSpanKey);
    let lastQ = null, lastR = null;
    for (let t = 8; t < maxT; t += 8) {
      if (t >= tw) break;
      const h = pixelToHex(x0 + cx * t, y0 + cy * t);
      if (h.q === lastQ && h.r === lastR) continue;   // same hex as last step ⇒ wall-ness unchanged
      lastQ = h.q; lastR = h.r;
      const id = this.terrain.get(axialKey(h.q, h.r));
      // #72: soft cover on either endpoint's OWN hex is see-through for this ray; solid cover and
      // any non-endpoint soft cover between the two blocks (exactly shotBlockedAt's rule).
      const ownHexExempt = (h.q === oh.q && h.r === oh.r) || (h.q === eh.q && h.r === eh.r);
      if (coverBlocksForRay(id, ownHexExempt)) return t;
    }
    return tw;
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
  // #374: the `smallUnitInvolved` size-tier parameter this used to take is gone — soft cover no
  // longer blocks any sightline, so what this caches is a hard-cover/wall answer. See `_isWall`.
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
      // #310: a wall turret ignores the span it is bolted to (and only that one), so a gun seated
      // on the wall's centreline can see out across the approach AND back into the compound.
      e._losClear = this._wallDistanceLos(x0, y0, angle, maxT, x1, y1, e.spanKey ?? null) === Infinity;
    }
    return e._losClear;
  },

};
