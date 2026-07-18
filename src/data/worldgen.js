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

// #269 playtest follow-up (bases/outposts role swap): alert towers are NO LONGER placed as
// connective tissue between bases — they're now OWNED by outposts (the separate, old,
// plain-destructible-building system; see `placeOutpostTowers` below and the `outpostCount`
// loop in `generateTerrain`). A base itself gets no dedicated tower anymore: it's already the
// dense, obviously-dangerous encounter (docks + turretEmplacements), while an outpost — a
// single unassuming building with nothing guarding it — is the one that needed a sentry. The
// tower's own trigger behaviour (detect → countdown → wake the NEAREST base, `nearestBaseTo`)
// is unchanged; only where it gets planted moved.
export const ALERT_TOWERS_PER_OUTPOST_MIN = 1;
export const ALERT_TOWERS_PER_OUTPOST_MAX = 1;

// #269 playtest follow-up (dock composition, point 4): turret emplacements per base — placed via
// their OWN loop (below, mirroring the dock/alert-tower loops' style), never drawn from the
// generic dock kind pools. Small count, similar spirit to `ALERT_TOWERS_PER_OUTPOST_MIN/MAX` —
// a base gets 1-2 defensive turret emplacements guarding it, not a wall of them.
export const TURRET_EMPLACEMENTS_PER_BASE_MIN = 1;
export const TURRET_EMPLACEMENTS_PER_BASE_MAX = 2;

// #269 §3: replaces run.js's retired EARLY_POOL/LATE_POOL (which drew a STAGE's squad
// composition) with an analogous pair for DOCK composition — same "softer openers vs. tougher
// lategame kinds" idea, just drawn per-BASE now via `baseLateFraction` (index of the base along
// the run, 0→1) instead of per-stage.
//
// #269 playtest follow-up ("fold mechs into the dock system"): the pool now mixes the non-mech
// ENEMY_KINDS roster (turret/tank/drone/helicopter/quadruped/infantry) WITH full mech loadouts
// (data/enemies.js `ENEMIES` — raider/skirmisher/sniper/artillery), late-pool only — see
// `BASE_LATE_KIND_POOL`'s own comment for the full reasoning (mechs are the toughest kind, they
// belong in the hard tier; `holdGround` now applies to mechs too, see scenes/arena/bases.js
// `_wakeBase`, so their heavier tactical AI reads fine as a stationary defender). `swarm`/
// `turretNest`/`infantryMob` (multi-unit cluster EXPANSIONS, not single kinds) are excluded too —
// a dock hosts a KIND, spawned in the COUNT `dockCountFor` below assigns for that kind, not a
// bespoke cluster-expansion typeId.
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
// #269 playtest follow-up ("where did all the enemy mechs go?" / "fold mechs into the dock
// system"): mechs (data/enemies.js `ENEMIES` — raider/skirmisher/sniper/artillery, the full
// tactical-AI Mech roster) are now dockable too, but ONLY in the LATE pool — they're the
// toughest thing in the game, so they read as the hard/late-run tier, never an early-base
// opener. `_spawnDormantUnits` (scenes/arena/bases.js) tells a mech id apart from a vehicle-kind
// id via `isEnemyKind` (data/enemyKinds.js) and constructs it through `_spawnMech` instead of
// `_spawnKind`; every woken mech defaults to `holdGround` regardless of chassis (see
// scenes/arena/bases.js `_wakeBase` and its comment) — it defends its dock rather than
// sortieing, so ALL FOUR archetypes (brawler/skirmisher/sniper/artillery) read fine as
// stationary defenders, unlike the old off-screen-squad system where a slow heavy chassis
// sniper/artillery would otherwise never catch up to the player. `raider` is weighted 2x (a
// mid-range brawler/skirmisher hybid — the most generic, always-reads-right defender) over the
// three specialists (each 1x): `skirmisher` (an aggressive brawler, presses in even while
// holding ground via its firing-range weapons), `sniper` (kites/holds at long range — a natural
// dock sentry), and `artillery` (every weapon indirect-fire — normally camps behind cover, but
// with holdGround forcing it to just stand and shell, it reads PERFECTLY as a stationary base
// defender lobbing shells over the wall — the exact "camping siege unit" its design already
// wants, no `allIndirect` cover-seeking even needed once it's rooted at a dock).
export const BASE_LATE_KIND_POOL = [
  'helicopter', 'helicopter', 'quadruped', 'tank', 'raider', 'raider', 'skirmisher', 'sniper', 'artillery',
];

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
// per the issue), plus a small cluster of `turretEmplacement` hexes (its own dedicated placement,
// #269 playtest follow-up point 4 — never drawn from the dock kind pools). Returns the array of
// base descriptors: `{ id, center: {q,r}, docks: [{q, r, kindId, count}], turrets: [{q,r}] }`.
// Every hex actually used is stamped into `T` only if it's still plain open ground (`isGround`)
// at the time its turn comes up, exactly like the outpost/helipad loops — never overwriting
// cover/an outpost/another dock/turret.
//
// #269 playtest follow-up (bases/outposts role swap): bases no longer place their own alert
// towers — see `placeOutpostTowers` below, which anchors towers (+ the roaming patrols they
// imply via `scenes/arena/bases.js` `_spawnTowerPatrols`, unchanged) to OUTPOSTS instead.
//
// #269 playtest follow-up: base CENTRES are stratified along the run instead of drawn by pure
// uniform-random pick across the whole candidate list. With only `baseCount` (3) draws, a pure
// random pick can (and did, in play) cluster every base toward the far end of the ~3400px
// corridor by sheer chance — unlike the outpost loop above, which also draws uniformly at
// random but does so MANY times (`outpostCount` scales with corridor length), so it blankets the
// corridor evenly by volume alone. Bases don't have that luxury with only 3 draws, so instead we
// sort candidates by `progressOf` ("how far down the run" a hex sits) and place base `i` inside
// the `i`-th of `baseCount` roughly-equal slices of that ordering — base 0 is guaranteed to land
// in the first slice, the last base in the final slice — while still picking a RANDOM hex within
// its assigned slice (not a fully deterministic position). This also makes placement position
// correlate with `baseLateFraction`'s difficulty ramp (also indexed 0→baseCount-1), so the
// hardest base can no longer land next to spawn. `progressOf(hex)` defaults to straight-line
// distance from the world origin (mirrors the `effR`/hazard-placement distance-from-origin proxy
// used elsewhere in `generateTerrain`); callers with a real corridor spine pass
// `(h) => spineProgressHexOf(spine, h.q, h.r)` instead, since a curving spine's "progress along
// the run" is NOT the same as straight-line distance from origin once the corridor bends.
export function placeBases(rng, all, T, isGround, baseCount = BASE_COUNT, progressOf = null) {
  const bases = [];
  const progress = progressOf || ((h) => distance(h, { q: 0, r: 0 }));
  const sorted = [...all].sort((a, b) => progress(a) - progress(b));
  const segSize = Math.max(1, Math.floor(sorted.length / baseCount));
  for (let i = 0; i < baseCount; i++) {
    const segStart = i * segSize;
    const segEnd = i === baseCount - 1 ? sorted.length : segStart + segSize;
    const segment = segEnd > segStart ? sorted.slice(segStart, segEnd) : all;
    const center = segment[Math.floor(rng() * segment.length)];
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
    bases.push({ id: `base${i}`, center: { q: center.q, r: center.r }, docks, turrets });
  }
  return { bases };
}

// #269 playtest follow-up (bases/outposts role swap): alert towers (+ the roaming patrols
// `scenes/arena/bases.js` `_spawnTowerPatrols` stations at each tower's position, unchanged) now
// belong to OUTPOSTS instead of bases — a base is already the dense, obviously-dangerous
// encounter; an outpost is the unassuming lone building that needed a sentry watching it. Same
// "pick a nearby ring hex, snap to the first valid ground hex" placement shape the old per-base
// loop used (rings 3-5 out, 10 rejection-sample tries), just anchored to each outpost centre in
// `outpostCenters` (the positions `generateTerrain`'s outpost loop actually stamped) instead of a
// base centre. `ALERT_TOWERS_PER_OUTPOST_MIN/MAX` are both 1 — the issue reads "each outpost"
// literally (1:1), and a biome's flat outpost count (3-8, data/biomes.js) is small enough that
// 1:1 doesn't create the "towers everywhere" density the old per-base loop risked (up to
// BASE_COUNT(3) * 2 = 6 towers before, vs. up to 8 now on the densest biome — same order of
// magnitude, not an explosion). Returns the flat `{q,r}` alert-tower list, same shape as before.
export function placeOutpostTowers(rng, outpostCenters, T, isGround) {
  const alertTowers = [];
  for (const center of outpostCenters ?? []) {
    const towerCount = ALERT_TOWERS_PER_OUTPOST_MIN
      + Math.floor(rng() * (ALERT_TOWERS_PER_OUTPOST_MAX - ALERT_TOWERS_PER_OUTPOST_MIN + 1));
    for (let t = 0; t < towerCount; t++) {
      const ring = range(center, 3 + Math.floor(rng() * 3));
      for (let tries = 0; tries < 10; tries++) {
        const h = ring[Math.floor(rng() * ring.length)];
        const k = axialKey(h.q, h.r);
        if (T.has(k) && isGround(k)) { T.set(k, 'alertTower'); alertTowers.push({ q: h.q, r: h.r }); break; }
      }
    }
  }
  return alertTowers;
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
  spine = null,
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
  //
  // #269 playtest follow-up (bases/outposts role swap): each cluster's centre `c` is now also
  // collected into `outpostCenters`, so `placeOutpostTowers` below has something to anchor an
  // alert tower (+ roaming patrol) to. Collected regardless of whether `c`'s own hex ends up
  // actually stamped `B.outpost` (this loop, unlike the dock/turret/tower loops, doesn't check
  // `isGround` before writing) — a tower planted near "roughly where an outpost cluster is" is
  // the right anchor even on the rare hex where `c` itself got overwritten by a neighbour draw
  // elsewhere; it's re-validated against the final `T` below anyway, same as bases/towers are.
  const outpostCount = outposts ?? B.outposts;
  const outpostCenters = [];
  for (let i = 0; i < outpostCount; i++) {
    const c = all[Math.floor(rng() * all.length)];
    outpostCenters.push({ q: c.q, r: c.r });
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

  // #269 §3: place the run's bases (dormant docks + turret emplacements) — same "random valid
  // ground hex" style as the outpost/helipad loops above, AFTER them so a base never overwrites
  // an outpost/cover cluster, BEFORE the safe-zone clear so anything that lands inside it is
  // reset back to open ground exactly like an outpost or helipad would be.
  // #269 playtest follow-up: prefer real progress-along-the-spine over straight-line distance
  // from origin when a spine is available — the corridor curves, so distance-from-origin alone
  // can rank a hex that's actually far down a bend as "early" (falls back to the distance proxy,
  // matching the pattern used elsewhere in this function, when no spine is passed).
  const progressOf = spine ? (h) => spineProgressHexOf(spine, h.q, h.r) : null;
  const { bases } = placeBases(rng, all, T, isGround, baseCount, progressOf);
  // #269 playtest follow-up (bases/outposts role swap): alert towers (+ the roaming patrols they
  // imply) are now anchored to OUTPOSTS instead of bases — see `placeOutpostTowers` above.
  // Placed after bases for the same "never overwrite a base's docks/turrets" reason, still
  // before the safe-zone clear below.
  const alertTowers = placeOutpostTowers(rng, outpostCenters, T, isGround);

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
  // #269 playtest follow-up (bases/outposts role swap): `outpostCenters` is re-validated the same
  // way — only centres whose own hex is still the biome's `outpost` id in the final map (not
  // reset by the safe-zone clear, not overwritten by a later base/helipad draw) are returned, so
  // a caller anchoring UI/analytics to "where the outposts are" never sees a stale/cleared one.
  // `placeOutpostTowers` above already ran against the pre-clear centres (matching how bases run
  // against pre-clear candidates too) — this filtered list is for callers, not re-fed into it.
  const finalOutposts = outpostCenters.filter((c) => T.get(axialKey(c.q, c.r)) === B.outpost);

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
  return { terrain: T, buildingHp, coverHp, bases, alertTowers: finalAlertTowers, outposts: finalOutposts };
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
