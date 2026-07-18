// Pure procedural map generation (#81, reworked #110/#111/#169) — the seeded terrain-stamping
// algorithm behind `scenes/arena/world.js` `_buildWorld`, extracted so it can run (and be
// unit-tested) without a Phaser scene. Given a seed + biome + the playable hex set + a "safe zone"
// centre, this always produces the SAME terrain/buildingHp/coverHp maps for the same inputs —
// the arena mixin is just the thin wrapper that turns the result into tile Images and stores it
// on `this`. No Phaser here; this is the pure data layer, same spirit as data/mission.js and
// data/run.js.
//
// #111: the whole run's terrain is built ONCE, upfront, at deploy time — there is no more
// per-stage incremental growth. `_buildWorld` calls this with one generously-sized region
// covering everywhere the player could plausibly reach across an entire run; stage advance
// (scenes/arena/run.js) only picks a new objective + spawns a new squad inside that already-built
// terrain, never rebuilds it.
//
// #169: the playable region is no longer an organic BLOB stretched along a straight long axis
// (#127's `organicBoundary`/`sectorBoundaries`, removed) — it is a long, single, non-self-
// intersecting SNAKING CORRIDOR: a curved centreline "spine" (`generateSpine`) with the playable
// area carved as every hex within `CORRIDOR_HALF_WIDTH_PX` of that spine (`corridorHexSet`). Width
// is decoupled from length — the half-width is kept narrow (so #126's boundary ring is reliably
// visible on the SIDES at the real GAMEPLAY_ZOOM=1.3, see below), while the length is long and
// independent, so the corridor's far end is NOT visible from spawn and a run traverses it end-to-end.
import { axialKey, range, neighbors, hexToPixel, distance, HEX_SIZE, hexesWithinPixelRadius } from './hexgrid.js';
import { buildingHp as buildingHpOf, isSoftCover } from './terrain.js';

// #251: how many static `helipad` ground markings (data/terrain.js) get stamped into a
// generated map — pure base-infrastructure set-dressing, not a gameplay objective, so this is a
// small flat count rather than something scaled up like `outposts` (which needs to keep pace
// with a long corridor so every stage has an assault target). 2 is enough that a full traversal
// of the corridor plausibly passes one without turning every map into a helipad showcase.
export const HELIPAD_COUNT = 2;

// #269 §3 (issue: base population rework — dormant docks + alert towers, REPLACES the old
// stage/squad system, data/run.js's now-retired `squadForStage`/`DEFAULT_SQUAD`): enemies are no
// longer squad-dropped off-camera near the player on mission-complete — they're placed once,
// here, at world-gen time, dormant, inside a handful of real bases.
//
// BASE_COUNT: how many bases a generated map gets. 3 is a first-pass pick that mirrors the old
// system's shape at a coarser grain — 5 escalating stages compressed into a handful of real
// encampments spread down the corridor, each a meaningfully-sized fight rather than one-per-
// stage. Small enough to keep this pass simple (per the issue's own "keep it SIMPLE" framing);
// tune via playtest once the core loop is felt out.
export const BASE_COUNT = 3;

// Docks per base: a small cluster (not a wall of enemies) — mirrors the old SQUAD_BASE/GROWTH
// escalation's spirit (more, tougher units later) via `baseLateFraction` below rather than a
// flat per-base count.
export const DOCKS_PER_BASE_MIN = 3;
export const DOCKS_PER_BASE_MAX = 5;

// Alert towers scattered as connective tissue BETWEEN bases (never owned by one ahead of time —
// see data/bases.js `nearestBaseTo`, resolved at wake time). One per base plus a couple of extra
// roamers so the corridor has more sensor coverage than raw base count alone would give.
export const ALERT_TOWERS_PER_BASE_MIN = 1;
export const ALERT_TOWERS_PER_BASE_MAX = 2;

// #269 playtest follow-up (dock composition, point 4): turret emplacements per base — placed via
// their OWN loop (below, mirroring the dock/alert-tower loops' style), never drawn from the
// generic dock kind pools. Small count, similar spirit to `ALERT_TOWERS_PER_BASE_MIN/MAX` — a
// base gets 1-2 defensive turret emplacements guarding it, not a wall of them.
export const TURRET_EMPLACEMENTS_PER_BASE_MIN = 1;
export const TURRET_EMPLACEMENTS_PER_BASE_MAX = 2;

// #269 §3: replaces run.js's retired EARLY_POOL/LATE_POOL (which drew a STAGE's squad
// composition) with an analogous pair for DOCK composition — same "softer openers vs. tougher
// lategame kinds" idea, just drawn per-BASE now via `baseLateFraction` (index of the base along
// the run, 0→1) instead of per-stage. Restricted to the non-mech ENEMY_KINDS roster (turret/
// tank/drone/helicopter/quadruped/infantry) — deliberately NOT full mech loadouts (data/
// enemies.js `ENEMIES`), since the wake-response split (data/bases.js `isFastWakeKind`) and the
// "hold ground" dock behaviour (scenes/arena/enemyBehaviors.js `e.holdGround`) are both built
// against the simpler non-mech kind AI, not the mech tactical-AI state machine — a reasonable
// scope line for this pass (see the issue's own base-wall/layout deferral for the analogous
// "don't over-build this pass" spirit). `swarm`/`turretNest`/`infantryMob` (multi-unit cluster
// EXPANSIONS, not single kinds) are excluded too — a dock hosts a KIND, spawned in the COUNT
// `dockCountFor` below assigns for that kind, not a bespoke cluster-expansion typeId.
//
// #269 playtest follow-up (dock composition): `'drone'` is REMOVED entirely — quadrupeds already
// have their own independent drone-deploy mechanic (enemyBehaviors.js `quadrupedBehavior`'s
// `deployEveryMs`/`deployBatchMin/Max`/`deployCap`), so a dock ALSO producing standalone drones
// was redundant with that. `'turret'` is REMOVED entirely too — turrets now get their own
// dedicated `turretEmplacement` terrain hex, placed via a separate loop below
// (`placeTurretEmplacements`), never mixed into the generic dock pool. `BASE_EARLY_KIND_POOL`
// is left as the single remaining entry (`'tank'`) rather than padded back out with other
// kinds — not asked for by the issue, and an easy follow-up tune once playtested.
export const BASE_EARLY_KIND_POOL = ['tank'];
export const BASE_LATE_KIND_POOL = ['helicopter', 'helicopter', 'quadruped', 'tank'];

// #269 playtest follow-up (dock composition): "2-3 tanks should dock on ONE dock hex" / "2
// helicopters should dock on ONE dock hex" — a dock is now a KIND + COUNT, not just a kind
// (`{ q, r, kindId, count }`, see `placeBases` below). `dockCountFor` is the one place that
// count is decided, keyed off the kind: tank rolls a small 2-3 cluster (mirrors the old
// SQUAD_BASE-style "a few of them" escalation spirit), helicopter is a flat paired 2 (the issue
// asked for "2 helicopters" literally, and a gunship pair reads as a natural wingman formation
// rather than needing a randomized range), every other still-dockable kind (today just
// `quadruped`, per the pools above) stays a single dormant unit — not asked to extend further.
export function dockCountFor(kindId, rng) {
  if (kindId === 'tank') return 2 + Math.floor(rng() * 2);   // 2 or 3
  if (kindId === 'helicopter') return 2;
  return 1;
}

// Same 0→1 escalation shape as the old (now-retired) run.js `lateFraction`, just indexed by
// BASE rather than stage — base 0 draws only from BASE_EARLY_KIND_POOL, the last base skews
// fully toward BASE_LATE_KIND_POOL.
export function baseLateFraction(baseIndex, baseCount) {
  if (baseCount <= 1) return 0;
  return baseIndex / (baseCount - 1);
}

// Place `baseCount` bases into the terrain map `T` (mutated in place, same style as the
// outpost/helipad loops above): each base is a small cluster of `dock` hexes (one dormant enemy
// KIND+COUNT pre-assigned per dock — world-gen PLACEMENT DATA, not a new terrain entry per kind,
// per the issue), a small cluster of `turretEmplacement` hexes (its own dedicated placement,
// #269 playtest follow-up point 4 — never drawn from the dock kind pools), plus a couple of
// `alertTower` hexes scattered nearby as connective tissue. Returns the array of base
// descriptors: `{ id, center: {q,r}, docks: [{q, r, kindId, count}], turrets: [{q,r}] }` —
// `alertTowers` (flat `{q,r}` list, NOT nested per base — see the file-header comment on why
// they're never base-owned) is returned separately. Every hex actually used is stamped into `T`
// only if it's still plain open ground (`isGround`) at the time its turn comes up, exactly like
// the outpost/helipad loops — never overwriting cover/an outpost/another dock/turret.
export function placeBases(rng, all, T, isGround, baseCount = BASE_COUNT) {
  const bases = [];
  const alertTowers = [];
  for (let i = 0; i < baseCount; i++) {
    const center = all[Math.floor(rng() * all.length)];
    const frac = baseLateFraction(i, baseCount);
    const dockCount = DOCKS_PER_BASE_MIN + Math.floor(rng() * (DOCKS_PER_BASE_MAX - DOCKS_PER_BASE_MIN + 1));
    // Candidate hexes for this base's docks: the centre, then successive rings out from it —
    // mirrors the outpost cluster's "centre + neighbours" shape but wider, since a base needs
    // more hexes than a single building footprint.
    const candidates = [center, ...neighbors(center.q, center.r), ...range(center, 2)];
    const docks = [];
    for (const h of candidates) {
      if (docks.length >= dockCount) break;
      const k = axialKey(h.q, h.r);
      if (!T.has(k) || !isGround(k)) continue;
      const pool = rng() < frac ? BASE_LATE_KIND_POOL : BASE_EARLY_KIND_POOL;
      const kindId = pool[Math.floor(rng() * pool.length)];
      T.set(k, 'dock');
      docks.push({ q: h.q, r: h.r, kindId, count: dockCountFor(kindId, rng) });
    }
    // #269 playtest follow-up: turret emplacements — their OWN dedicated placement, drawn from
    // the same near-centre candidate ring the docks use (a turret emplacement is base defense,
    // so it belongs close in), but stamped AFTER the dock loop above so it only ever lands on
    // whatever ground the docks didn't already claim.
    const turretCount = TURRET_EMPLACEMENTS_PER_BASE_MIN
      + Math.floor(rng() * (TURRET_EMPLACEMENTS_PER_BASE_MAX - TURRET_EMPLACEMENTS_PER_BASE_MIN + 1));
    const turrets = [];
    for (const h of candidates) {
      if (turrets.length >= turretCount) break;
      const k = axialKey(h.q, h.r);
      if (!T.has(k) || !isGround(k)) continue;
      T.set(k, 'turretEmplacement');
      turrets.push({ q: h.q, r: h.r });
    }
    // Alert towers: connective tissue placed a bit further out (rings 3-5) than the dock
    // cluster itself, so they read as separate roaming sentries rather than part of the base.
    const towerCount = ALERT_TOWERS_PER_BASE_MIN
      + Math.floor(rng() * (ALERT_TOWERS_PER_BASE_MAX - ALERT_TOWERS_PER_BASE_MIN + 1));
    for (let t = 0; t < towerCount; t++) {
      const ring = range(center, 3 + Math.floor(rng() * 3));
      for (let tries = 0; tries < 10; tries++) {
        const h = ring[Math.floor(rng() * ring.length)];
        const k = axialKey(h.q, h.r);
        if (T.has(k) && isGround(k)) { T.set(k, 'alertTower'); alertTowers.push({ q: h.q, r: h.r }); break; }
      }
    }
    bases.push({ id: `base${i}`, center: { q: center.q, r: center.r }, docks, turrets });
  }
  return { bases, alertTowers };
}

// Small seeded PRNG (mulberry32) — deterministic given `a`, so the same seed always yields
// the same terrain layout.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The hex keys the safe-clear zone occupies when centered at `center` — a filled disc of
// `radius` hexes (default 3, matching the original fixed spawn clearing). Exported so the
// geometry alone is unit-testable, independent of the rest of generation.
export function safeZoneKeys(center, radius = 3) {
  return range(center, radius).map((h) => axialKey(h.q, h.r));
}

// Generate one deterministic terrain layout. `biome` is a resolved biome record (data/
// biomes.js getBiome() result). `safeCenter` (default world origin, matching the original
// always-clear-the-centre behaviour) is cleared back to open ground so nothing spawns
// stranded there; `extraClear` is a list of additional hex keys (e.g. the debug DUMMY_HEX)
// force-cleared regardless of the RNG, same as before.
//
// #169: `includedKeys` (optional Set/array of hex keys, e.g. from `corridorHexSet`) is the exact
// set of playable hexes — used DIRECTLY as the candidate set. A long snaking corridor is a thin
// sliver of a huge bounding disc, so scanning `range({0,0}, worldRadius)` (the older organic-blob
// path, kept as a fallback via the `included` predicate for existing callers/tests) would waste
// almost all of its work. Feature density scales off `all.length` (the true playable area), so a
// thin corridor doesn't get a disc-sized dose of cover/outposts.
//
// #110: `boundaryRing` (optional Set of hex keys, e.g. from `boundaryRingKeys`) stamps every
// hex it contains with the biome's `deep` terrain id — the world's outer boundary — regardless
// of membership (these hexes are, by construction, just OUTSIDE the playable shape). This is
// the ONLY place `biome.deep` is ever stamped now; the old in-map "deep blob" is gone (see
// `hasHazard`/`hazard` below). `outposts` (optional) overrides the biome's default outpost count
// — the live game scales it up with corridor length so objectives can march the whole way down.
export function generateTerrain({
  seed, worldRadius, biome, safeCenter = { q: 0, r: 0 }, extraClear = [],
  included = null, includedKeys = null, boundaryRing = null, outposts = null, baseCount = BASE_COUNT,
}) {
  const R = worldRadius;
  const rng = mulberry32(seed);
  const all = includedKeys
    ? [...includedKeys].map((k) => { const [q, r] = k.split(',').map(Number); return { q, r }; })
    : range({ q: 0, r: 0 }, R).filter((h) => !included || included(h.q, h.r));
  // The actual extent of the playable area (may be far smaller than the `worldRadius`
  // bounding box) — the channel sweep and hazard placement below scale off this.
  const effR = all.length
    ? Math.max(5, ...all.map((h) => distance(h, { q: 0, r: 0 })))
    : R;
  const T = new Map();
  const B = biome;
  const groundAt = (h) => ((h.q + h.r) % 2 ? B.groundB : B.groundA);
  const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };

  // Base: a checkered open floor (grass / sand / snow / pavement / ash by biome).
  for (const h of all) T.set(axialKey(h.q, h.r), groundAt(h));

  // Channel: a winding strip sweeping across the map — river / dry-bed / slush / road / lava-crust.
  if (B.hasChannel) {
    for (let q = -effR + 2; q <= effR - 2; q++) {
      const r = Math.round(7 * Math.sin(q * 0.26) + 3 * Math.sin(q * 0.11));
      for (const dr of [0, 1]) { const k = axialKey(q, r + dr); if (T.has(k)) T.set(k, B.channel); }
    }
  }

  // #110: a LESSER in-map hazard blob (quicksand / broken ice / debris / cinder field — never
  // the biome's reserved-for-boundary `deep` id anymore), grown as a blobby disc so its edge
  // reads naturally; kept clear of the world's true centre (deliberately NOT `safeCenter` — the
  // hazard avoids world origin specifically so it stays a stable landmark independent of where
  // the player is). Grassland has no `hazard` (its channel already reads as the "watch your
  // footing" role) — `hasHazard` is false there, so this block simply doesn't run.
  if (B.hasHazard) {
    const spot = all[Math.floor(rng() * all.length)];
    if (Math.hypot(hexToPixel(spot.q, spot.r).x, hexToPixel(spot.q, spot.r).y) > 6 * 48) {
      for (const h of range(spot, 3)) {
        const d = Math.max(Math.abs(h.q - spot.q), Math.abs(h.r - spot.r), Math.abs(h.q + h.r - spot.q - spot.r));
        const k = axialKey(h.q, h.r);
        if (T.has(k) && rng() < 1 - d * 0.28) T.set(k, B.hazard);
      }
    }
  }

  // Cover clusters scattered across the field (seed + organic neighbour growth) — walk-through
  // cover (forest / scrub / snowdrift / wreckage / fumarole). Count scales with the TRUE playable
  // area (`all.length`), not a bounding radius, so a thin corridor gets corridor-appropriate density
  // (~5.5% of hexes seed a cluster) rather than a disc-sized dose. Per biome via `coverClusters`.
  for (let i = 0; i < Math.round(all.length * 0.055 * B.coverClusters); i++) {
    const c = all[Math.floor(rng() * all.length)];
    const k0 = axialKey(c.q, c.r);
    if (!isGround(k0)) continue;
    T.set(k0, B.cover);
    for (const n of neighbors(c.q, c.r)) {
      const k = axialKey(n.q, n.r);
      if (isGround(k) && rng() < 0.6) T.set(k, B.cover);
    }
  }

  // A few DESTRUCTIBLE outposts (building clusters) — hard cover. HP seeded below. `outposts`
  // (from the caller) overrides the biome default so a long corridor gets outposts spread along
  // its whole length — otherwise late stages, whose objective sits near the far end, would have
  // no standing outpost to target there.
  const outpostCount = outposts ?? B.outposts;
  for (let i = 0; i < outpostCount; i++) {
    const c = all[Math.floor(rng() * all.length)];
    for (const h of [c, ...neighbors(c.q, c.r).filter(() => rng() < 0.55)]) {
      const k = axialKey(h.q, h.r); if (T.has(k)) T.set(k, B.outpost);
    }
  }

  // #251: a couple of static helipad ground markings — base-infrastructure SET DRESSING
  // (data/terrain.js `helipad`: passable, no LOS block; destructible with its own hp, same as a
  // real outpost, but excluded from ever being picked as the mission objective via
  // `setDressing: true`/`isMissionObjective`), placed as a normal part of the generated layout
  // exactly like the outposts/cover above, NOT tied to any
  // enemy's spawn moment (helicopters keep using their own independent offscreen spawn logic —
  // there is no requirement a helicopter spawn near one, or vice versa). `HELIPAD_COUNT` is
  // deliberately tiny (flavor, not a repeated hazard/cover density like the loops above) — each
  // candidate hex only actually becomes a helipad if it's still plain open ground by the time
  // its turn comes up (`isGround`), so a helipad never overwrites cover/an outpost placed just
  // above; landing inside the spawn safe zone is fine too, since the safe-zone clear right below
  // already resets anything there back to open ground the same way it would an outpost.
  for (let i = 0; i < HELIPAD_COUNT; i++) {
    const c = all[Math.floor(rng() * all.length)];
    const k = axialKey(c.q, c.r);
    if (isGround(k)) T.set(k, 'helipad');
  }

  // #269 §3: place the run's bases (dormant docks + connective-tissue alert towers) — same
  // "random valid ground hex" style as the outpost/helipad loops above, AFTER them so a base
  // never overwrites an outpost/cover cluster, BEFORE the safe-zone clear so anything that lands
  // inside it is reset back to open ground exactly like an outpost or helipad would be.
  const { bases, alertTowers } = placeBases(rng, all, T, isGround, baseCount);

  // Clear the safe zone (spawn point + line of fire) back to open ground.
  for (const h of range(safeCenter, 3)) { const k = axialKey(h.q, h.r); if (T.has(k)) T.set(k, groundAt(h)); }
  // Force-clear any extra hexes (e.g. the debug DUMMY_HEX) regardless of the RNG.
  for (const k of extraClear) {
    if (!T.has(k)) continue;
    T.set(k, B.groundA);
  }

  // #269: unlike the outpost/helipad loops (which bake straight into `T` with nothing else ever
  // tracking their positions separately), `bases`/`alertTowers` are returned as their OWN data —
  // the scene spawns a real dormant enemy record at each dock's exact position, so a dock/tower
  // whose hex the safe-zone clear just reset back to open ground must be dropped from these
  // lists too, or the scene would spawn a "dormant unit" standing on plain grass with no matching
  // terrain marker under it. Re-validated against the now-final `T` (cheap — base/tower counts
  // are small), same "landing in the safe zone is fine, it just gets cleared" spirit as helipad.
  for (const base of bases) {
    base.docks = base.docks.filter((d) => T.get(axialKey(d.q, d.r)) === 'dock');
    base.turrets = (base.turrets ?? []).filter((t) => T.get(axialKey(t.q, t.r)) === 'turretEmplacement');
  }
  const finalAlertTowers = alertTowers.filter((t) => T.get(axialKey(t.q, t.r)) === 'alertTower');

  // #110: stamp the boundary ring LAST (and unconditionally) — these hexes sit just OUTSIDE
  // the playable shape, so nothing above ever touched them; this is the one and only place
  // `biome.deep` is written to the terrain map.
  if (boundaryRing) {
    for (const k of boundaryRing) T.set(k, B.deep);
  }

  const buildingHp = new Map();   // hexKey → remaining HP for destructible OUTPOST (solid) hexes
  const coverHp = new Map();      // hexKey → remaining HP for destructible soft-cover hexes
  for (const [k, id] of T) {
    const hp = buildingHpOf(id);
    if (hp > 0) (isSoftCover(id) ? coverHp : buildingHp).set(k, hp);
  }
  return { terrain: T, buildingHp, coverHp, bases, alertTowers: finalAlertTowers };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// #169: SNAKING CORRIDOR geometry.
//
// The map is a long, single, non-self-intersecting winding corridor. It is generated by following
// a curved "spine" (a meandering centreline from the spawn end to the far end); the playable area
// is every hex within `CORRIDOR_HALF_WIDTH_PX` (perpendicular pixel distance) of that spine.
//
// WIDTH — decoupled from length, and kept narrow so #126's boundary ring is reliably visible on
// the SIDES at the real GAMEPLAY_ZOOM=1.3 camera. Re-derived by simulation against the REAL 1.3x
// view RECTANGLE (canvas 1280x720 / zoom, dpr cancels — half-dims ≈492x277px), the same rigor
// #158 used, NOT #158's blob-geometry `FULL_BUILD_BASE_RADIUS`/`CORRIDOR_ASPECT_RATIO` (which don't
// transfer). The binding tension is identical to #158's: the corridor's perpendicular half-width
// must be
//   - LARGE enough that the guaranteed-clear radius-3 spawn safe zone is fully inside the corridor
//     (else the boundary ring, stamped last, could overwrite part of it — MIN_SPAWN_BOUNDARY_HEX_
//     DIST). The radius-3 disc reaches ~250px from spawn, so the corridor must be at least that
//     wide there; `corridorHexSet` also force-includes the safe disc as belt-and-suspenders.
//   - SMALL enough that the side boundary falls inside the 277px camera half-height even when the
//     corridor happens to run so the perpendicular aligns with the screen's SHORT axis (the worst
//     orientation, since `startAngle` is random per deploy).
// A 4000-seed sweep against the real 1.3x rectangle (scripts/corridor-sim.mjs, mirrored in
// worldgen.test.js) put spawn-side boundary visibility at ~99% at 250px — better than #158's blob
// (~90.6%) because a corridor is wrapped by boundary on BOTH sides AND behind the spawn end, so
// SOME ring hex lands in the view far more reliably than a single blob's lone near edge did.
export const CORRIDOR_HALF_WIDTH_PX = 250;

// LENGTH — the main-axis span from the spawn end to the far end, in pixels. Long and independent
// of width: at GAMEPLAY_ZOOM=1.3 the camera shows ~985px of world across, so a ~3400px corridor
// reveals only ~1/4 of its length from spawn, and a full run's five stages march the objective
// progressively down it (`spineProgressHexOf` + `pickStageObjective`). ~3400px ≈ 41 hexes of travel.
export const CORRIDOR_LENGTH_PX = 3400;

// REAR PAD — how far the corridor extends BEHIND the spawn end (origin sits at spine u=0, the
// corridor runs from u=-REAR_PAD to u=+LENGTH). Gives the radius-3 spawn safe zone room on the
// "behind" side too (so it's a normal interior point of the corridor, not a bare tip), while
// keeping the rear boundary close enough behind spawn to be visible there. ~320px ≈ 4 hexes.
export const CORRIDOR_REAR_PAD_PX = 320;

// CURVINESS — the peak lateral swing of the snake, in pixels (amplitude of the primary meander
// harmonic). MODERATE first pass; the owner will dial this after seeing it. Because the spine is a
// single-valued lateral offset over the monotonic main axis (see `generateSpine`), ANY curviness
// is mathematically non-self-intersecting — this only controls how pronounced the S-bends read.
export const CORRIDOR_CURVINESS = 300;

// WAVELENGTH — main-axis pixels per full snake wave. ~1500px over a 3400px corridor gives a bit
// over two broad bends — a clear meander without cramming in tight switchbacks.
export const CORRIDOR_WAVELENGTH_PX = 1500;

// How finely the spine is sampled into points (pixels). Must be < CORRIDOR_HALF_WIDTH_PX so
// `corridorHexSet`'s per-sample discs overlap into a continuous corridor with no gaps.
const SPINE_SAMPLE_STEP_PX = HEX_SIZE / 2;   // 24px

// Generate the snaking spine: a sequence of centreline points from the rear end (u=-rearPad),
// through the spawn origin (u=0, world (0,0)), to the far end (u=+length). The lateral offset is a
// sum of two incommensurate sine harmonics (random phase per seed) over the monotonic main axis,
// so the path meanders organically yet is GUARANTEED non-self-intersecting (a single-valued graph
// over u, rotated by `startAngle` — rotation preserves non-self-intersection, and u is monotonic
// so it never doubles back along its own length). Each point carries its `u` (main-axis progress),
// used by `spineProgressHexOf` to measure how far "down the corridor" a hex sits.
export function generateSpine(rng, {
  length = CORRIDOR_LENGTH_PX, rearPad = CORRIDOR_REAR_PAD_PX,
  curviness = CORRIDOR_CURVINESS, wavelength = CORRIDOR_WAVELENGTH_PX,
  startAngle = 0, sampleStep = SPINE_SAMPLE_STEP_PX,
} = {}) {
  const dirX = Math.cos(startAngle), dirY = Math.sin(startAngle);          // main-axis unit vector
  const perpX = -Math.sin(startAngle), perpY = Math.cos(startAngle);       // perpendicular unit vector
  const k1 = (Math.PI * 2) / wavelength;
  const k2 = (Math.PI * 2) / (wavelength * 0.57);   // a second, shorter harmonic for organic wobble
  const phase1 = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;
  const a1 = curviness;
  const a2 = curviness * 0.35;
  const lateralRaw = (u) => a1 * Math.sin(u * k1 + phase1) + a2 * Math.sin(u * k2 + phase2);
  const lateral0 = lateralRaw(0);   // anchor so the spine passes exactly through origin at u=0
  const points = [];
  // Sample on a grid aligned to u=0 so the spawn point (origin) is always an exact spine sample.
  const startU = -Math.ceil(rearPad / sampleStep) * sampleStep;
  for (let u = startU; u <= length + 1e-6; u += sampleStep) {
    const v = lateralRaw(u) - lateral0;
    points.push({ x: dirX * u + perpX * v, y: dirY * u + perpY * v, u });
  }
  return { points, startAngle, length, rearPad };
}

// The set of playable hex keys for a spine: every hex within `halfWidth` (perpendicular pixel
// distance) of the spine polyline, found by unioning `hexesWithinPixelRadius` over the dense
// samples (spacing < halfWidth guarantees no gaps between samples). `extraInclude` (hex keys) is
// force-added regardless — the live game passes the radius-3 spawn safe zone so it is ALWAYS part
// of the corridor and the boundary ring can never encroach it (MIN_SPAWN_BOUNDARY_HEX_DIST).
export function corridorHexSet(points, halfWidth = CORRIDOR_HALF_WIDTH_PX, extraInclude = []) {
  const set = new Set();
  for (const p of points) {
    for (const h of hexesWithinPixelRadius(p.x, p.y, halfWidth)) set.add(axialKey(h.q, h.r));
  }
  for (const k of extraInclude) set.add(k);
  return set;
}

// How far "down the corridor" a hex sits — the main-axis progress `u` of the nearest spine sample,
// converted from pixels to hex-step units (÷HEX_STEP_PX) so it reads in the same ~hex scale as the
// straight-line hex distances the objective picker's floor/fractions are tuned against. Spawn is at
// u=0, so progress is ~0 near spawn and ~length/HEX_STEP_PX at the far end. Used to place each
// stage's objective progressively along the spine (mission.js/run.js via `pickStageObjective`).
export function spineProgressHexOf(spine, q, r) {
  const { x, y } = hexToPixel(q, r);
  let bestU = 0, bestD = Infinity;
  for (const p of spine.points) {
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
    if (d < bestD) { bestD = d; bestU = p.u; }
  }
  return bestU / HEX_STEP_PX;
}

// MAX_WORLD_RADIUS: a finite bounding cap on the corridor's reach in hex-distance from origin, used
// as `this.worldRadius` (world.js) for the fallback outpost-spawn ring cap and passed through to
// generateTerrain. The corridor's far end sits at ~CORRIDOR_LENGTH_PX + curviness pixels from
// origin; converting the worst case to hex-distance (÷ the smallest px-per-hex, ~72) and adding a
// little headroom lands here. Nothing scans a full `range({0,0}, MAX_WORLD_RADIUS)` disc in the
// live corridor path anymore (both generateTerrain and boundaryRingKeys take the explicit hex set),
// so this is a loose cap, not a per-hex cost driver.
export const MAX_WORLD_RADIUS = 60;

// #169: the near-spawn safety floor #110/#127/#158 introduced protects one invariant: the boundary
// ring must never encroach the guaranteed-clear radius-3 safe zone around spawn. In the corridor,
// `corridorHexSet` force-includes that whole radius-3 disc, so the boundary (grown just outside the
// playable set) can never land within it — the invariant holds by construction. Set to the literal
// hard requirement (3, the safe-zone radius itself); the smoke/unit tests assert `deep` is absent
// within this many hexes of spawn.
export const MIN_SPAWN_BOUNDARY_HEX_DIST = 3;

// #126 (playtest: black void visible past the boundary ring at some camera positions/zooms):
// BOUNDARY_RING_WIDTH is sized from the actual worst-case camera view distance, not a guessed
// constant, so the fix is a real guarantee rather than "probably fine." Still needed for the
// snaking corridor — the ring wraps the whole corridor shape, so no void shows past the narrow sides.
//
// The camera's world-space viewport is `innerWidth x innerHeight` CSS px (the dpr term cancels —
// `setZoom(dpr)` divides the physical-pixel canvas back down). The camera follows the player and
// converges to being centred on them at rest, so the farthest point ever visible from the player's
// own position is half the viewport's diagonal (the screen's far corner); the player's worst-case
// position is flush against the impassable ring itself, so the ring's rendered depth must cover
// that whole half-diagonal with no buffer credit.
const WORST_CASE_VIEWPORT_W = 3840;
const WORST_CASE_VIEWPORT_H = 2160;
// 30% headroom on top of the raw 4K half-diagonal for camera-follow overshoot on a fast stop,
// non-fullscreen browser chrome quirks, and modest zoom-out.
const VIEW_DEPTH_SAFETY_MARGIN = 1.3;
// Exported (not just an internal const) so worldgen.test.js can assert BOUNDARY_RING_WIDTH
// actually derives from — and covers — this figure, rather than re-guessing a magic number.
export const REQUIRED_VIEW_DEPTH_PX =
  0.5 * Math.hypot(WORST_CASE_VIEWPORT_W, WORST_CASE_VIEWPORT_H) * VIEW_DEPTH_SAFETY_MARGIN; // ≈2864px
// Euclidean centre-to-centre distance between adjacent hexes — constant in every direction on
// this regular grid (unlike the hex "distance" metric), so it's the real px depth each BFS ring
// layer in `boundaryRingKeys` adds outward.
export const HEX_STEP_PX = HEX_SIZE * Math.sqrt(3); // ≈83.14px for HEX_SIZE=48
// BOUNDARY_RING_WIDTH: how many hexes thick the impassable boundary ring is, just outside the
// pre-built area's own edge. Derived (not guessed) from the camera math above.
export const BOUNDARY_RING_WIDTH = Math.ceil(REQUIRED_VIEW_DEPTH_PX / HEX_STEP_PX); // = 35

// #110/#169: the Set of hex keys forming a ring `ringWidth` hexes thick immediately OUTSIDE the
// playable shape — the world's impassable outer boundary. Found by BFS-expanding outward from the
// shape's own edge, so the ring hugs the irregular corridor coastline instead of reading as a disc.
//
// #169: pass `insideKeys` (the corridor's `corridorHexSet`) to seed the BFS directly from the known
// playable set — no need to scan a bounding disc at all. The older signature (an `included`
// predicate + `boundingRadius`, which builds the inside set by scanning `range({0,0}, boundingRadius)`)
// is kept for the isolated unit tests that still exercise a predicate-shaped region.
export function boundaryRingKeys(included, {
  ringWidth = BOUNDARY_RING_WIDTH, boundingRadius = MAX_WORLD_RADIUS + BOUNDARY_RING_WIDTH + 2,
  insideKeys = null,
} = {}) {
  const insideSet = insideKeys
    ? (insideKeys instanceof Set ? insideKeys : new Set(insideKeys))
    : (() => {
      const s = new Set();
      for (const h of range({ q: 0, r: 0 }, boundingRadius)) {
        if (included(h.q, h.r)) s.add(axialKey(h.q, h.r));
      }
      return s;
    })();
  let frontier = insideSet;
  const ring = new Set();
  for (let layer = 0; layer < ringWidth; layer++) {
    const next = new Set();
    for (const k of frontier) {
      const [q, r] = k.split(',').map(Number);
      for (const n of neighbors(q, r)) {
        const nk = axialKey(n.q, n.r);
        if (insideSet.has(nk) || ring.has(nk) || next.has(nk)) continue;
        next.add(nk);
      }
    }
    for (const k of next) ring.add(k);
    frontier = next;
  }
  return ring;
}

// #81: pick the next stage's objective from the still-standing outpost hex keys, biased
// toward one that's actually far from `fromHex` — so reaching it takes a real drive rather than a
// step to an adjacent hex. Pure (no RNG). `distanceOf(q, r)` (optional) overrides the metric: the
// live game passes spine-progress (`spineProgressHexOf`) so "far" means "far DOWN THE CORRIDOR,"
// not straight-line from the player; omitting it falls back to straight hex distance from `fromHex`.
export const FAR_OBJECTIVE_MIN_DIST = 3;
export function pickFarObjective(hexKeys, fromHex, minDistance = FAR_OBJECTIVE_MIN_DIST, reveal = null, distanceOf = null) {
  if (!hexKeys || !hexKeys.length) return null;
  const candidates = reveal
    ? hexKeys.filter((k) => { const [q, r] = k.split(',').map(Number); return reveal(q, r); })
    : hexKeys;
  if (!candidates.length) return null;
  const metric = distanceOf ?? ((q, r) => distance({ q, r }, fromHex));
  const ranked = [...candidates].sort().map((k) => {
    const [q, r] = k.split(',').map(Number);
    return { k, d: metric(q, r) };
  }).sort((a, b) => b.d - a.d);
  const farEnough = ranked.find((c) => c.d >= minDistance);
  return (farEnough ?? ranked[0]).k;
}

// #138 (playtest: "the map still feels huge, especially on initial deploy"): objective distance
// scales with `lateFrac` (the same 0→1 `lateFraction(stageIndex)` curve data/run.js uses for
// squad-composition escalation): stage 0 (`lateFrac` 0) targets a NEAR objective at
// STAGE_OBJECTIVE_NEAR_FRACTION of the farthest candidate's distance; the final stage (`lateFrac`
// 1) targets STAGE_OBJECTIVE_FAR_FRACTION — the farthest candidate. Distances in between lerp.
//
// #169: with `distanceOf` set to spine-progress, "distance" here is PROGRESS DOWN THE CORRIDOR, so
// stage 0 sits near the spawn end and the final stage near the far end — the run physically
// traverses the whole spine — while the near→far escalation math (and its minDistance floor)
// is unchanged from #138. Omitting `distanceOf` keeps the original straight-line-distance behavior.
//
// Picks the candidate whose distance is closest to the target (ties broken by sorted hex-key
// order). `minDistance` is a REAL lower bound on the returned candidate: the "closest to target"
// search only considers candidates that themselves clear it, unless NONE do (then it falls back to
// the overall closest-to-target — graceful degradation on a sparse late-run map).
export const STAGE_OBJECTIVE_NEAR_FRACTION = 0.2;
export const STAGE_OBJECTIVE_FAR_FRACTION = 1.0;
export function pickStageObjective(
  hexKeys, fromHex, lateFrac, minDistance = FAR_OBJECTIVE_MIN_DIST, reveal = null, distanceOf = null,
) {
  if (!hexKeys || !hexKeys.length) return null;
  const candidates = reveal
    ? hexKeys.filter((k) => { const [q, r] = k.split(',').map(Number); return reveal(q, r); })
    : hexKeys;
  if (!candidates.length) return null;
  const metric = distanceOf ?? ((q, r) => distance({ q, r }, fromHex));
  const ranked = [...candidates].sort().map((k) => {
    const [q, r] = k.split(',').map(Number);
    return { k, d: metric(q, r) };
  });
  const maxD = ranked.reduce((m, c) => Math.max(m, c.d), 0);
  const clampedFrac = Math.max(0, Math.min(1, lateFrac));
  const frac = STAGE_OBJECTIVE_NEAR_FRACTION
    + clampedFrac * (STAGE_OBJECTIVE_FAR_FRACTION - STAGE_OBJECTIVE_NEAR_FRACTION);
  const targetD = Math.max(minDistance, frac * maxD);
  const closestTo = (pool) => {
    let best = pool[0];
    let bestDiff = Math.abs(best.d - targetD);
    for (const c of pool) {
      const diff = Math.abs(c.d - targetD);
      if (diff < bestDiff) { best = c; bestDiff = diff; }
    }
    return best;
  };
  const clearsFloor = ranked.filter((c) => c.d >= minDistance);
  return closestTo(clearsFloor.length ? clearsFloor : ranked).k;
}
