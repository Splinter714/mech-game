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
import {
  axialKey, range, neighbors, hexToPixel, pixelToHex, distance, HEX_SIZE, hexesWithinPixelRadius,
  nearestHex,
} from './hexgrid.js';
import { buildingHp as buildingHpOf, isPassable as isPassableOf, isBaseCategory } from './terrain.js';

// #269 §3 (issue: base population rework — dormant docks + alert towers, REPLACES the old
// stage/squad system, data/run.js's now-retired `squadForStage`/`DEFAULT_SQUAD`): enemies are no
// longer squad-dropped off-camera near the player on mission-complete — they're placed once,
// here, at world-gen time, dormant, inside a handful of real bases.
//
// BASE_COUNT: how many bases a generated map gets.
//
// #308 (Jackson 2026-07-19: "runs should have more objectives before completion, like they
// should just be longer in general"): 3 → 5. Crucially he asked for BOTH more bases AND a longer
// corridor, not just a higher count — "a longer run should feel like a longer trek, not a more
// crowded one." So this constant does NOT stand alone: `CORRIDOR_LENGTH_PX` below is derived from
// it via `CORRIDOR_LENGTH_PER_BASE_PX`, which pins the per-base share of corridor (and therefore
// the calm travel gap between encounters, #283) at exactly what 3 bases got out of the old
// 3400px. Changing BASE_COUNT alone can't compress the run any more — the corridor grows with it.
export const BASE_COUNT = 5;

// Docks per base: a small cluster (not a wall of enemies) — mirrors the old SQUAD_BASE/GROWTH
// escalation's spirit (more, tougher units later) via `baseLateFraction` below rather than a
// flat per-base count.
export const DOCKS_PER_BASE_MIN = 3;
export const DOCKS_PER_BASE_MAX = 5;

// #275 (redesign, on top of the outpost-terrain removal): alert towers are no longer anchored to
// an "outpost" concept at all — Jackson clarified he never thought of the removed building/
// adobe/iceRuin/tower/obsidian terrain as "outposts," and didn't want alert towers anchored to
// where those used to cluster, not even on the now-plain ground left behind. Instead, towers
// place SOLO, one per "gap" along the corridor's spine progression: one somewhere between spawn
// and the first base, one between the first and second base, one between the second and third,
// and so on — exactly `baseCount` gaps for `baseCount` bases (see `placeGapTowers` below). This
// makes a tower a real "you're about to walk into a base" tripwire rather than tied to a
// building that no longer exists. The tower's own trigger behaviour (detect → countdown → wake
// its linked base, by `baseId` — see #284) is unchanged; only how its position is chosen changed.

// #287 (owner, playtest 2026-07-19: "remove interior base turret hexes now that we have them on
// walls"): the interior `turretEmplacement` bunker and its per-base placement loop are GONE. #310
// put rail-lance guns on the wall ring itself, which made two different turret-bearing structures
// per base pure noise — a base's fixed guns now live on its parapet and nowhere else. The `turret`
// enemy KIND survives, still used by the free-roaming `turretNest` spawn (enemies.js).

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
// `_wakeBase`, so their heavier tactical AI reads fine as a defender). `swarm`/
// `turretNest`/`infantryMob` (multi-unit cluster EXPANSIONS, not single kinds) are excluded too —
// a dock hosts a KIND, spawned in the COUNT `dockCountFor` below assigns for that kind, not a
// bespoke cluster-expansion typeId.
//
// #269 playtest follow-up (dock composition): `'drone'` is REMOVED entirely — quadrupeds already
// have their own independent drone-deploy mechanic (enemyBehaviors.js `quadrupedBehavior`'s
// `deployEveryMs`/`deployBatchMin/Max`/`deployCap`), so a dock ALSO producing standalone drones
// was redundant with that. `'turret'` is REMOVED entirely too — a base's fixed guns are its WALL
// turrets (#310 `assignWallTurrets`), never a kind drawn from the generic dock pool. (#287 removed
// the interim interior `turretEmplacement` bunker that briefly served that role.)
//
// #269 playtest follow-up ("too many fuckin' tanks; get some helicopters up in this bitch"):
// the early pool was a single `['tank']` entry, so EVERY early base was 100% tanks — the core of
// the "too many tanks" complaint (early bases are where the run is mostly spent, and they read as
// wall-to-wall armour). It's now a 50/50 tank/helicopter mix: tanks stay the basic ground opener,
// but helicopters are an immediate, equal presence from base 0 instead of not showing up until the
// late pool bleeds in. Kept to just these two soft vehicle kinds (no quadruped, no mechs) so the
// early tier stays the SOFT opener half of the escalation — mechs/quadruped remain late-only per
// `BASE_LATE_KIND_POOL` below, preserving the early→late difficulty ramp `baseLateFraction` drives.
//
// #314 (Jackson 2026-07-19: "add a burst of drones to the potential spawns for a dock; maybe like
// 10 of them? same for infantry, maybe like 10 of them?"): `'drone'` is BACK in the pool — but as
// a fundamentally different thing than the single standalone drone #269 removed. A drone dock is
// now a SWARM dock (`DOCK_SWARM_COUNT` = 10 bodies, see `dockCountFor`), so it doesn't re-create
// the "redundant with the quadruped's own drone-deploy" problem #269 was solving; it's a set-piece
// burst, not a lone escort. `'infantry'` joins for the same reason (infantry are already live in
// every run via the alert-tower patrol, scenes/arena/bases.js `TOWER_PATROL_KIND_ID` — this adds
// nothing that was switched off; #239 only ever disabled the 28-strong `infantryMob`).
//
// WEIGHTING (#314, deliberate, and measured — see below): both swarm kinds are ONE entry each
// against tank ×8 / helicopter ×8, i.e. ~1/18 of early draws apiece. A swarm dock is worth 10x a
// normal dock's body count, so equal weighting is nothing like equal density — a first cut at
// ×3/×3 measured out at 64% of bases fielding a swarm and average base population tripling from
// ~4 bodies to ~12, which is exactly the "too dense once every dock hex filled" verdict #269's
// playtest handed down (that's why it tuned every dock to a single unit in the first place).
// Thin weighting plus the one-swarm-per-base cap in `placeBases` keeps a swarm a memorable
// occasional set-piece, and keeps the tank/helicopter mix #269 asked for as the early texture.
export const BASE_EARLY_KIND_POOL = [
  'tank', 'tank', 'tank', 'tank', 'tank', 'tank', 'tank', 'tank',
  'helicopter', 'helicopter', 'helicopter', 'helicopter', 'helicopter', 'helicopter', 'helicopter', 'helicopter',
  'drone', 'infantry',
];
// #269 playtest follow-up ("where did all the enemy mechs go?" / "fold mechs into the dock
// system"): mechs (data/enemies.js `ENEMIES` — raider/skirmisher/sniper/artillery, the full
// tactical-AI Mech roster) are now dockable too, but ONLY in the LATE pool — they're the
// toughest thing in the game, so they read as the hard/late-run tier, never an early-base
// opener. `_spawnDormantUnits` (scenes/arena/bases.js) tells a mech id apart from a vehicle-kind
// id via `isEnemyKind` (data/enemyKinds.js) and constructs it through `_spawnMech` instead of
// `_spawnKind`; every woken mech defaults to `holdGround` regardless of chassis (see
// scenes/arena/bases.js `_wakeBase` and its comment) — a stronger dock defender than a fast
// vehicle kind, unlike the old off-screen-squad system where a slow heavy chassis artillery
// would otherwise never catch up to the player (#273: sniper moved off the heavy chassis onto
// medium — see enemies.js). #285: `holdGround` no longer leashes movement or forces a
// stand-and-fight posture — once woken, a docked mech runs the exact same tactical AI
// (PRESS/KITE/FLANK/COVER/HOLD) as any other mech and fully commits to closing on the player,
// same as a non-docked one. `raider` is weighted 2x (a mid-range brawler/skirmisher hybrid — the
// most generic, always-reads-right defender) over the three specialists (each 1x): `skirmisher`
// (an aggressive brawler), `sniper` (kites/holds at long range), and `artillery` (every weapon
// indirect-fire — camps behind cover and lobs shells, the normal `allIndirect` behavior every
// artillery already has, docked or not).
//
// #269 playtest follow-up ("get some helicopters up in this bitch"): helicopter weight raised from
// 2/9 to 3/10 (~22% → 30% of late draws) so gunships stay a clear presence even in the mech-heavy
// late tier, not just the early pool. Tank is left at its already-minimal 1/10 (late bases lean on
// the tougher mech roster, not armour columns — the "too many tanks" complaint is fixed in the
// EARLY pool and the per-dock count, not by touching the already-thin late tank slot). Mech roster
// (raider ×2, skirmisher/sniper/artillery ×1 each = 5/10) still dominates late, keeping the
// escalation intent intact.
//
// #314: `drone`/`infantry` swarm docks are available in the LATE pool too ("a swarm can show up at
// any point in a run"), at the same deliberately-thin 1 entry each. Every pre-existing late entry
// is doubled so the ORIGINAL late mix (helicopter 3 : quadruped 1 : tank 1 : raider 2 :
// skirmisher/sniper/artillery 1 each) is preserved EXACTLY in relative terms while the two swarm
// kinds land at 1/22 of draws apiece — same density reasoning as the early pool's comment above.
export const BASE_LATE_KIND_POOL = [
  'helicopter', 'helicopter', 'helicopter', 'quadruped', 'tank', 'raider', 'raider', 'skirmisher', 'sniper', 'artillery',
  'helicopter', 'helicopter', 'helicopter', 'quadruped', 'tank', 'raider', 'raider', 'skirmisher', 'sniper', 'artillery',
  'drone', 'infantry',
];

// #314: is this dock kind a SWARM dock (a `DOCK_SWARM_COUNT` burst rather than a single body)?
// One predicate, used by both `dockCountFor` (how many) and `placeBases` (the per-base cap).
export function isSwarmDockKind(kindId) {
  return kindId === 'drone' || kindId === 'infantry';
}

// #314: how many bodies a SWARM dock (drone / infantry) hosts — Jackson's "maybe like 10 of them?"
// taken literally, a flat 10 rather than a random band so the burst is a predictable set-piece.
// Deliberately far below the existing cluster expansions (`SWARM_SIZE` = 18 drones,
// `INFANTRY_MOB_SIZE` = 28 troopers, data/enemyKinds.js) — those composition ids are NOT reused
// here precisely because they'd give 18/28 instead of the requested 10.
export const DOCK_SWARM_COUNT = 10;

// #269 playtest follow-up (dock composition): "2-3 tanks should dock on ONE dock hex" / "2
// helicopters should dock on ONE dock hex" — a dock is now a KIND + COUNT, not just a kind
// (`{ q, r, kindId, count }`, see `placeBases` below). `dockCountFor` is the one place that
// count is decided, keyed off the kind.
//
// #269 playtest follow-up ("tone it down to 1 tank per dock and 1 helicopter per dock"): even a
// flat 2 read as too dense once every dock hex filled, so EVERY dockable kind is now a single
// unit — a dock hosts exactly one body regardless of kind. The per-kind structure is retained
// (rather than collapsing to a bare `return 1`) as explicit re-tuning seams: bumping tanks or
// helicopters back to a cluster later is a one-line change on its own branch. `rng` likewise
// stays in the signature (callers pass it) so re-adding a randomized count is drop-in.
//
// #314 is the first actual USE of that seam: `drone` and `infantry` — the two weakest kinds in the
// game (3 HP each post-#299) — are the deliberate exception to the flat-1 rule, hosting a
// `DOCK_SWARM_COUNT` burst instead. #269's density verdict is about how much ARMOUR a base fields;
// ten 3-HP bodies is a cloud the player shreds, not ten more tanks, so it doesn't reopen that.
// Everything else stays at exactly 1.
export function dockCountFor(kindId, rng) {
  if (isSwarmDockKind(kindId)) return DOCK_SWARM_COUNT;  // #314: a ~10-body burst from one dock
  if (kindId === 'tank') return 1;         // #269: "1 tank per dock" — a lone tank, no cluster
  if (kindId === 'helicopter') return 1;   // #269: "1 helicopter per dock" — a single gunship
  return 1;                                // every other dockable kind (quadruped, mechs) is a single unit
}

// Same 0→1 escalation shape as the old (now-retired) run.js `lateFraction`, just indexed by
// BASE rather than stage — base 0 draws only from BASE_EARLY_KIND_POOL, the last base skews
// fully toward BASE_LATE_KIND_POOL.
export function baseLateFraction(baseIndex, baseCount) {
  if (baseCount <= 1) return 0;
  return baseIndex / (baseCount - 1);
}

// #323: THE weighted draw of a dock's kind — "which unit does this base field in this dock?".
// Extracted so `placeBases` (world-gen time) and scenes/arena/bases.js's `_resupplyDock`
// (mid-fight, because Jackson asked that "a dock should not be locked into its original type; it
// should pull from that base difficulty's pool at the correct ratios") produce kinds from the SAME
// distribution rather than one of them re-deriving it.
//
// The ratios live in the pools themselves — both are plain arrays whose ENTRIES ARE REPEATED to
// weight them (#308 doubled every pre-existing late-pool entry precisely so #269's relative mix
// survived adding the swarm kinds thin). A uniform pick over the array therefore already IS the
// intended weighting, and going through this function is what guarantees a caller can't
// accidentally flatten it by de-duplicating or hand-rolling its own table.
//
// `hasSwarm` is #314's one-swarm-per-base density cap, threaded through rather than reimplemented:
// when the base already fields a swarm dock, a swarm draw falls back to a non-swarm kind from the
// same pool, so the base keeps its full dock count but never stacks bursts.
export function drawDockKind(rng, lateFraction, { hasSwarm = false } = {}) {
  const pool = rng() < lateFraction ? BASE_LATE_KIND_POOL : BASE_EARLY_KIND_POOL;
  const kindId = pool[Math.floor(rng() * pool.length)];
  if (!hasSwarm || !isSwarmDockKind(kindId)) return kindId;
  const plain = pool.filter((id) => !isSwarmDockKind(id));
  return plain[Math.floor(rng() * plain.length)];
}

// Place `baseCount` bases into the terrain map `T` (mutated in place): each base is a small
// cluster of `dock` hexes (one dormant enemy KIND+COUNT pre-assigned per dock — world-gen
// PLACEMENT DATA, not a new terrain entry per kind, per the issue), plus a small cluster of
// plus one dedicated `objective` hex. Returns the array of base descriptors: `{ id, center:
// {q,r}, docks: [{q, r, kindId, count}], objectiveHex }`. (#287 removed the interior
// `turretEmplacement` cluster that used to be placed here too.) Every hex actually used is stamped
// into `T` only if it's still plain open ground (`isGround`) at the time its turn comes up —
// never overwriting cover/another dock/turret.
//
// #269 playtest follow-up (bases/outposts role swap): bases no longer place their own alert
// towers — see `placeGapTowers` below, which places one tower per GAP between successive bases
// (#275 redesign) instead.
//
// #269 playtest follow-up: base CENTRES are stratified along the run instead of drawn by pure
// uniform-random pick across the whole candidate list. With only `baseCount` (3) draws, a pure
// random pick can (and did, in play) cluster every base toward the far end of the ~3400px
// corridor by sheer chance. Bases don't have that luxury with only 3 draws, so instead we
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
// #269 (spawn rear-pad fix): `prevProgress` below starts at literal `0`, not the player's actual
// spawn position — investigated whether it needed to change now that the player spawns behind
// origin (`spineSpawnHex`, negative `u`/progress) instead of exactly at it. It does not: `0` was
// always just the FLOOR ANCHOR for gap 0 ("base 0 must land at least `minGapProgress` past this
// value"), never a literal claim about where the player stands. Every real `progressOf` in play
// (`spineProgressHexOf`, or this file's own straight-line-distance default) returns >= 0 for any
// hex reachable by `placeBases`'/`placeGapTowers`' own candidate sets, so the `0` floor anchor was
// already the true minimum either way — moving spawn to a negative `u` only ADDS unused-but-real
// travel distance behind that floor (the rear-pad stretch), it never changes where base 0 or gap
// 0's tower are allowed to land (`floor = prevProgress(0) + minGapProgress`, always > 0). Confirmed
// by the existing '#283 minimum calm-gap spacing' suite in worldgen.test.js, which still asserts
// this floor holds unchanged. If a future change ever lets `progressOf` return negative values for
// in-bounds hexes, this anchor would need revisiting — it does not today.
// #288 (placement re-spec — "a full ring around the base", "the bases should flow with no natural
// hexes directly behind each wall segment"): how many hex rings out from its centre a base's
// COMPOUND FOOTPRINT extends. This is now a load-bearing shape decision, not just a placement
// bound: the wall ring is literally this footprint's outline, so the footprint's shape IS the
// fortification's shape.
//
// 2 (a 19-hex disc) is deliberately the SAME radius `placeBases`' dock/turret/objective candidate
// ring already used, so the compound is exactly "the area the base's own structures were always
// drawn from" — nothing moves, the empty ground between the structures simply becomes yard. It's
// also the smallest radius that comfortably holds a full base (up to 5 docks + 1
// objective = 8 structures in 19 hexes) while staying compact enough that the ring reads as one
// fortified compound you can see around rather than a wall stretching off past the horizon.
//
// Radius 1 (7 hexes) was rejected: it can't fit a max-roll base's structures, and a ring that tight
// leaves no interior to fight across once breached. Radius 3 (37 hexes) was rejected: the corridor
// is only CORRIDOR_HALF_WIDTH_PX * 2 = 500px ≈ 6 hex steps wide, so a radius-3 compound would
// routinely span the entire corridor and leave the ring's own outline pressed against the world
// boundary on both flanks, which reads as a wall across the map rather than around a base.
export const BASE_FOOTPRINT_RADIUS = 2;

// #288: a base's compound footprint — the CONTIGUOUS hexes within `BASE_FOOTPRINT_RADIUS` of its
// centre that are real play space (`playableKeys`). Returned as a key Set.
//
// Contiguity (a BFS from the centre, confined to the disc) rather than a plain disc-∩-playable
// intersection is what keeps the footprint — and therefore the ring — a single closed shape. Where
// a base sits near the corridor's edge the disc gets clipped, and an unconstrained intersection can
// leave an island of footprint hexes cut off around a bulge in the corridor wall; that island would
// get its own separate little ring, floating away from the base. The BFS drops those.
//
// Note the disc is intersected with playable space but NOT with passability or terrain type: a
// lake, a boulder field or a forest that happens to fall inside a base's footprint is PAVED OVER
// into yard by the caller. That's the point — the compound is fabricated ground, so its outline is
// the base's own deliberate perimeter rather than a shape negotiated with the local scenery.
export function baseFootprint(center, playableKeys, radius = BASE_FOOTPRINT_RADIUS) {
  const disc = new Set(range(center, radius).map((h) => axialKey(h.q, h.r)));
  const centerKey = axialKey(center.q, center.r);
  if (!playableKeys.has(centerKey)) return new Set();
  const out = new Set([centerKey]);
  const queue = [center];
  for (let i = 0; i < queue.length; i++) {
    for (const n of neighbors(queue[i].q, queue[i].r)) {
      const nk = axialKey(n.q, n.r);
      if (out.has(nk) || !disc.has(nk) || !playableKeys.has(nk)) continue;
      out.add(nk);
      queue.push(n);
    }
  }
  return out;
}

export function placeBases(
  rng, all, T, isGround, baseCount = BASE_COUNT, progressOf = null, minGapProgress = MIN_GAP_PROGRESS_HEX,
) {
  const bases = [];
  // #288 (ring placement): the set of hexes that are actually PLAY SPACE, as keys. A base's
  // footprint is clipped to this rather than to `T.has` — by the time anything reads `T` it also
  // contains the impassable boundary ring, and a footprint must never annex a slab of that.
  const playable = new Set(all.map((h) => axialKey(h.q, h.r)));
  const progress = progressOf || ((h) => distance(h, { q: 0, r: 0 }));
  const sorted = [...all].sort((a, b) => progress(a) - progress(b));
  const segSize = Math.max(1, Math.floor(sorted.length / baseCount));
  // #308: segments are sliced by PROGRESS SPAN, not by hex COUNT.
  //
  // The original split was `sorted.slice(i * segSize, …)` — equal numbers of hexes per segment.
  // That silently assumed hex count is uniform along the corridor, and it isn't: the spawn end
  // carries the rear pad AND the force-included radius-3 safe disc, so it holds far more hexes
  // per unit of travel than anywhere else. Measured on the real pipeline at 5 bases, segment 0
  // came out spanning progress -4.0 → 6.9 while segments 1-4 each spanned ~14.4 — i.e. the first
  // segment lay ENTIRELY below `minGapProgress` (7.22), so base 0's own slice was always fully
  // eaten by the calm-gap floor. It then fell through to the "anywhere past the floor" fallback,
  // landed deep in segment 1's territory (~23), and shoved every later base forward until the
  // last one ran out of corridor and its gap collapsed to 4.0 hexes.
  //
  // Splitting the PROGRESS RANGE into `baseCount` equal spans instead makes each segment mean
  // what it was always supposed to mean — an equal share of the RUN, measured in travel — so the
  // stratification is uniform regardless of how hexes bunch up. That's also exactly the quantity
  // #308's corridor scaling holds constant per base, so the two now agree by construction.
  const pMin = progress(sorted[0]);
  const pMax = progress(sorted[sorted.length - 1]);
  const segSpan = (pMax - pMin) / baseCount;
  // #283: `prevProgress` chains forward from spawn (progress 0) through each placed base in
  // turn — the floor for base `i` is "at least `minGapProgress` past wherever base `i-1` (or
  // spawn, for base 0) actually landed," not just "somewhere in this segment."
  let prevProgress = 0;
  for (let i = 0; i < baseCount; i++) {
    const segLo = pMin + i * segSpan;
    const segHi = i === baseCount - 1 ? Infinity : pMin + (i + 1) * segSpan;
    const inSeg = sorted.filter((h) => progress(h) >= segLo && progress(h) < segHi);
    const segment = inSeg.length ? inSeg : all;
    // #283: an exclusion zone at the START of this segment — filter out any candidate whose own
    // progress doesn't clear the floor. This is layered ON TOP of the existing stratified-slice
    // logic (still exactly one random pick within `segment`), not a replacement for it: on a
    // typical corridor the segment itself extends well past the floor, so this just trims its
    // early edge. If the floor eats the WHOLE segment (a short/curvy corridor, or a large floor
    // relative to segment width — expected sometimes since `minGapProgress` is sized off travel
    // TIME, not off "1/`baseCount`th of the corridor"), fall back to the nearest ground hexes
    // ANYWHERE past the floor (still ordered by progress, so this stays "as close to the
    // segment's intended position as the floor allows," not a random jump down the corridor).
    // If literally nothing anywhere clears the FULL floor (corridor too short/curvy to fit
    // `baseCount` full floors — a real possibility since `minGapProgress` is sized off travel
    // TIME, not off "1/`baseCount`th of the corridor"), fall back to whichever candidates sit
    // farthest along the corridor while still AT LEAST matching `prevProgress` (never less) —
    // guarantees `prevProgress` only ever moves forward (or stays put, on a maximally-degenerate
    // corridor with a single hex of headroom left) and a base can never land BEHIND the one
    // before it, even in this doubly-degraded case. Base COUNT is unaffected either way — this
    // only changes WHERE within the corridor a base lands, never whether one gets placed.
    const floor = prevProgress + minGapProgress;
    let pool = segment.filter((h) => progress(h) >= floor);
    if (!pool.length) {
      const beyond = sorted.filter((h) => progress(h) >= floor);
      if (beyond.length) {
        pool = beyond.slice(0, Math.max(1, segSize));
      } else {
        const forward = sorted.filter((h) => progress(h) >= prevProgress);
        pool = (forward.length ? forward : sorted).slice(-Math.max(1, segSize));
      }
    }
    // #308: NO TWO COMPOUNDS MAY OVERLAP. Each base paves its whole radius-`BASE_FOOTPRINT_RADIUS`
    // footprint as `baseYard` (#288) and then rings that footprint with a sealed wall, so two
    // footprints sharing a hex is not a cosmetic collision — the second base's paving stamps over
    // the first's already-placed objective/docks, and the two rings interpenetrate into a shape
    // neither seals. On the real corridor `minGapProgress` (~7.22 hexes) already keeps centres far
    // enough apart that this can't happen, so this is belt-and-braces there — but it was resting
    // on a constant tuned for a completely different purpose (calm travel time), one corridor-
    // geometry change away from breaking, and it DOES bite on tighter regions than the shipped
    // corridor. Two radius-R discs are disjoint exactly when their centres are more than 2R apart,
    // which is the whole test. Degrades gracefully: if honouring it would leave nowhere to put
    // this base, the unfiltered pool is kept — a base is never dropped, count is never affected.
    if (bases.length) {
      const disjoint = pool.filter(
        (h) => bases.every((b) => distance(h, b.center) > BASE_FOOTPRINT_RADIUS * 2),
      );
      if (disjoint.length) pool = disjoint;
    }
    const center = pool[Math.floor(rng() * pool.length)];
    prevProgress = progress(center);
    const frac = baseLateFraction(i, baseCount);
    const dockCount = DOCKS_PER_BASE_MIN + Math.floor(rng() * (DOCKS_PER_BASE_MAX - DOCKS_PER_BASE_MIN + 1));
    // #288 (ring placement): PAVE THE COMPOUND FIRST. Every hex of the base's footprint that isn't
    // about to become a structure becomes `baseYard`, so the base is a solid built compound rather
    // than a scatter of structures on grass. This has to happen BEFORE the dock/turret/objective
    // loops below (they stamp over the yard), and it's what makes the wall ring's invariant hold by
    // construction: the ring is this footprint's outline, so nothing natural can sit behind a span.
    //
    // Unlike every other stamp in this function it is UNCONDITIONAL — it deliberately paves over
    // cover, channel and hazard alike. A base is a fabricated installation; the alternative (paving
    // only plain ground) is precisely the ragged, grass-backed outline the owner rejected.
    const footprint = baseFootprint(center, playable);
    for (const k of footprint) T.set(k, 'baseYard');
    // Candidate hexes for this base's structures: the centre, then successive rings out from it —
    // now drawn from the FOOTPRINT itself (identical set to the old `range(center, 2)` disc, minus
    // anything clipped off the edge of play space), so a structure can never land outside the ring
    // that is supposed to be protecting it.
    const inFootprint = (h) => footprint.has(axialKey(h.q, h.r));
    const candidates = [center, ...neighbors(center.q, center.r), ...range(center, 2)].filter(inFootprint);
    // #288: the whole footprint is `baseYard` now, so `isGround` (which only recognises the biome's
    // two natural ground ids) would reject every candidate. "Free" for a structure means "still
    // bare yard" — i.e. no earlier loop has claimed it. Same first-come semantics as before.
    const isFree = (k) => T.get(k) === 'baseYard';
    const docks = [];
    for (const h of candidates) {
      if (docks.length >= dockCount) break;
      const k = axialKey(h.q, h.r);
      if (!isFree(k)) continue;
      // #314 density cap: AT MOST ONE swarm dock per base. A swarm dock fields 10 bodies where
      // every other dock fields 1, so two or three of them on the same base stops reading as "a
      // swarm defends this base" and becomes an unreadable wall of bodies — the exact failure
      // #269's playtest called out when it tuned docks down to a single unit. Pool weighting alone
      // can't guarantee this (a base draws several docks independently), so once a base has its
      // swarm, further swarm draws fall back to a NON-swarm kind from the same pool rather than
      // being dropped — the base keeps its full dock count, it just doesn't stack bursts.
      // #323: the draw + that fallback both live in `drawDockKind` above now, shared with
      // mid-fight resupply so the two paths can't drift into different distributions.
      const kindId = drawDockKind(rng, frac, { hasSwarm: docks.some((d) => isSwarmDockKind(d.kindId)) });
      T.set(k, 'dock');
      docks.push({ q: h.q, r: h.r, kindId, count: dockCountFor(kindId, rng) });
    }
    // #287: the interior turret-emplacement placement loop that used to sit here is removed —
    // see the constants' comment at the top of this file. A base's fixed guns are the wall
    // turrets (`assignWallTurrets` below), not a second cluster of interior bunkers.
    // #269 playtest follow-up ("objectives are picking an arbitrary hex, not a real target"): one
    // dedicated, DESTRUCTIBLE `objective` hex per base — the same near-centre candidate ring the
    // docks above draw from (already-claimed candidates fail `isGround` naturally, so this
    // only ever lands on whatever ground neither loop already took), stamped LAST so it never
    // steals a dock/turret's spot. `_targetCurrentBase` (scenes/arena/mission.js) points the
    // mission marker at this instead of the old `base.center` (just a geometric centroid, not
    // necessarily even a real placed hex). Falls back to forcing it onto the base's own `center`
    // hex if every candidate is already claimed — a base must always have a real objective hex for
    // the marker to target; the centre is the best fallback since it's the base's own anchor point
    // regardless of what else is on it.
    let objectiveHex = null;
    for (const h of candidates) {
      const k = axialKey(h.q, h.r);
      if (!isFree(k)) continue;
      T.set(k, 'objective');
      objectiveHex = { q: h.q, r: h.r };
      break;
    }
    if (!objectiveHex) {
      T.set(axialKey(center.q, center.r), 'objective');
      objectiveHex = { q: center.q, r: center.r };
    }
    // #288: `footprint` travels with the base — `placeBaseWalls` builds the wall ring as this
    // set's outline, and `generateTerrain` re-validates it against the final terrain map.
    bases.push({
      id: `base${i}`, center: { q: center.q, r: center.r }, docks, objectiveHex,
      footprint: [...footprint].map((k) => { const [q, r] = k.split(',').map(Number); return { q, r }; }),
    });
  }
  return { bases };
}

// #275 (redesign): place one alert tower per GAP along the corridor's progression, instead of
// anchoring towers to the removed "outpost" concept. `bases` is the ordered list of base
// descriptors (`placeBases`' returned `bases`, in base-index order 0..N-1, each already
// stratified by `progressOf` — see that function's own comment). For gap `i` (0-indexed), the
// tower goes somewhere between base `i-1`'s progress position (or the corridor START, progress
// 0 — spawn sits at spine u=0 — for gap 0) and base `i`'s progress position: a real "you're
// about to walk into a base" tripwire between encampments, not tied to a building that no
// longer exists. `bases.length` gaps are placed for `bases.length` bases — gap 0 before the
// first base, gap 1 between the first and second, and so on.
//
// #284: gap `i`'s tower is placed strictly within gap `i`'s progress bounds, i.e. between base
// `i-1` and base `i` — it conceptually already "belongs" to base `i`. Rather than making the
// wake-trigger code re-derive that relationship geometrically (`nearestBaseTo`, which can
// disagree with actual gap ownership on a curving spine), each returned tower record carries the
// `baseId` of the base it precedes directly, so wake-routing can use it as-is with no guessing.
//
// Implementation: for each gap, filter the candidate set `all` down to hexes whose OWN progress
// falls within that gap's [lo, hi] progress range AND are still plain open ground (`isGround`) —
// guarantees the tower's final position genuinely sits within its gap (no ring-hop drift that
// could push it past a boundary), then rng-picks one. If a gap has no valid ground candidate
// (rare — a heavily-hazarded/covered gap, or a very short one), that gap simply gets no tower
// rather than forcing a bad placement. `progressOf(hex)` defaults to straight-line distance from
// the world origin (matching `placeBases`' own default); callers with a real corridor spine pass
// `(h) => spineProgressHexOf(spine, h.q, h.r)` instead, same as `placeBases`. Roaming patrols
// (`scenes/arena/bases.js` `_spawnTowerPatrols`) still anchor to wherever the tower ends up,
// unaffected by this redesign — they're just fed a different tower-position source now.
export function placeGapTowers(
  rng, all, T, isGround, bases, progressOf = null, minGapProgress = MIN_GAP_PROGRESS_HEX,
) {
  const alertTowers = [];
  const progress = progressOf || ((h) => distance(h, { q: 0, r: 0 }));
  let prevProgress = 0;   // the corridor start (spawn sits at spine u=0 / distance 0 from origin)
  for (const base of bases ?? []) {
    const baseProgress = progress(base.center);
    // #269 playtest follow-up ("alert towers are too close to their linked base"): the floor used
    // to apply ONLY to the tower's distance from the PREVIOUS base/spawn (`lo`), leaving `hi`
    // (the ceiling before the linked base) completely unbuffered — a tower could land right on
    // top of its own base with zero calm space before it. Fix: apply the SAME `minGapProgress`
    // floor symmetrically on both sides — at least `minGapProgress` past the previous segment
    // AND at least `minGapProgress` before the linked base's own position — so "spawn -> tower0"
    // and "tower(i) -> base(i)" read as the same size of calm gap (Jackson's framing: "there
    // should be a similar amount of safe space between all segments").
    //
    // Graceful degradation: if the gap is too short to fit BOTH full floors (a short/curvy
    // corridor segment), a naive `lo = lower + minGapProgress` / `hi = upper - minGapProgress`
    // can invert (lo > hi), leaving an empty candidate window and silently dropping the tower —
    // exactly the "skip it silently" outcome the issue asks to avoid where possible. Instead,
    // shrink the buffer PROPORTIONALLY to fit: `buffer = min(minGapProgress, width / 2)`. This
    // still gives the full floor whenever the gap is wide enough (buffer == minGapProgress, the
    // common case), and as the gap narrows the buffer shrinks in lockstep so `lo` and `hi`
    // converge smoothly on the gap's own midpoint (`buffer == width / 2` implies `lo == hi ==
    // (lower + upper) / 2`) rather than ever crossing — the tower still gets *some* space on
    // both sides (proportional to what the gap can actually offer) and, in the fully-degenerate
    // case, lands exactly at the midpoint, mirroring `placeBases`' own "split the difference
    // rather than skip" fallback spirit for a too-tight corridor.
    const lower = Math.min(prevProgress, baseProgress);
    const upper = Math.max(prevProgress, baseProgress);
    const buffer = Math.min(minGapProgress, (upper - lower) / 2);
    const lo = lower + buffer;
    const hi = upper - buffer;
    let candidates = all.filter((h) => {
      const p = progress(h);
      return p >= lo && p <= hi && isGround(axialKey(h.q, h.r));
    });
    // Second-layer fallback: on a genuinely tight/sparse gap, even the proportionally-shrunk
    // `[lo, hi]` window can come up EMPTY — e.g. it's shrunk to a single floating-point progress
    // value that no real hex's progress exactly equals, or the narrow window just has no ground
    // candidate (cover/hazard ate it). Rather than skip the tower, widen back out to the gap's
    // FULL bounds `[lower, upper]` and take whichever ground hex's progress lands closest to the
    // buffered window's own centre — still "as close to the intended calm midpoint as this gap's
    // actual ground allows," just not constrained to the (possibly empty) exact window.
    if (!candidates.length) {
      const target = (lo + hi) / 2;
      const inGap = all.filter((h) => progress(h) >= lower && progress(h) <= upper && isGround(axialKey(h.q, h.r)));
      if (inGap.length) {
        let best = inGap[0];
        let bestDiff = Math.abs(progress(best) - target);
        for (const h of inGap) {
          const diff = Math.abs(progress(h) - target);
          if (diff < bestDiff) { best = h; bestDiff = diff; }
        }
        candidates = [best];
      }
    }
    if (candidates.length) {
      const h = candidates[Math.floor(rng() * candidates.length)];
      T.set(axialKey(h.q, h.r), 'alertTower');
      alertTowers.push({ q: h.q, r: h.r, baseId: base.id });
    }
    prevProgress = baseProgress;
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
// thin corridor doesn't get a disc-sized dose of cover.
//
// #110: `boundaryRing` (optional Set of hex keys, e.g. from `boundaryRingKeys`) stamps every
// hex it contains with the biome's `deep` terrain id — the world's outer boundary — regardless
// of membership (these hexes are, by construction, just OUTSIDE the playable shape). This is
// the ONLY place `biome.deep` is ever stamped now; the old in-map "deep blob" is gone (see
// `hasHazard`/`hazard` below).
export function generateTerrain({
  seed, worldRadius, biome, safeCenter = { q: 0, r: 0 }, extraClear = [],
  included = null, includedKeys = null, boundaryRing = null, baseCount = BASE_COUNT,
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

  // #269 §3: place the run's bases (dormant docks + turret emplacements) — "random valid ground
  // hex" style, BEFORE the safe-zone clear so anything that lands inside it is reset back to open
  // ground. #269 playtest follow-up: prefer real progress-along-the-spine over straight-line
  // distance from origin when a spine is available — the corridor curves, so distance-from-origin
  // alone can rank a hex that's actually far down a bend as "early" (falls back to the distance
  // proxy, matching the pattern used elsewhere in this function, when no spine is passed).
  const progressOf = spine ? (h) => spineProgressHexOf(spine, h.q, h.r) : null;
  const { bases } = placeBases(rng, all, T, isGround, baseCount, progressOf);
  // #275 (redesign): one alert tower per GAP between successive bases (`placeGapTowers`'s own
  // comment has the full reasoning) — replaces the old outpost-cluster-anchored placement.
  // Placed after bases (using their final centres) for the same "never overwrite a base's
  // docks" reason the old per-outpost placement observed, still before the safe-zone
  // clear below.
  const alertTowers = placeGapTowers(rng, all, T, isGround, bases, progressOf);

  // Clear the safe zone (spawn point + line of fire) back to open ground.
  for (const h of range(safeCenter, 3)) { const k = axialKey(h.q, h.r); if (T.has(k)) T.set(k, groundAt(h)); }
  // Force-clear any extra hexes (e.g. the debug DUMMY_HEX) regardless of the RNG.
  for (const k of extraClear) {
    if (!T.has(k)) continue;
    T.set(k, B.groundA);
  }

  // #269: `bases`/`alertTowers` are returned as their OWN data — the scene spawns a real dormant
  // enemy record at each dock's exact position, so a dock/tower whose hex the safe-zone clear
  // just reset back to open ground must be dropped from these lists too, or the scene would spawn
  // a "dormant unit" standing on plain grass with no matching terrain marker under it.
  // Re-validated against the now-final `T` (cheap — base/tower counts are small).
  for (const base of bases) {
    base.docks = base.docks.filter((d) => T.get(axialKey(d.q, d.r)) === 'dock');
    // #269 playtest follow-up: same re-validation as docks above — if the safe-zone clear
    // (or a debug extraClear hex) reset this base's objective hex back to open ground, drop it
    // rather than leaving a stale position; `_targetCurrentBase` (mission.js) falls back to
    // `base.center` when `objectiveHex` is null.
    if (base.objectiveHex && T.get(axialKey(base.objectiveHex.q, base.objectiveHex.r)) !== 'objective') {
      base.objectiveHex = null;
    }
  }
  // #275: re-validated against the now-final `T` the same way bases' docks/objective are
  // above — if the safe-zone clear (or a debug extraClear hex) reset a gap tower's hex back to
  // open ground, drop it rather than leaving a stale position.
  const finalAlertTowers = alertTowers.filter((t) => T.get(axialKey(t.q, t.r)) === 'alertTower');

  // #110: stamp the boundary ring LAST (and unconditionally) — these hexes sit just OUTSIDE
  // the playable shape, so nothing above ever touched them; this is the one and only place
  // `biome.deep` is written to the terrain map.
  if (boundaryRing) {
    for (const k of boundaryRing) T.set(k, B.deep);
  }

  // #288 (placement re-specced to a full RING): each base's perimeter wall is the outline of its
  // own compound FOOTPRINT, so before building it, re-validate that footprint against the now-final
  // `T` — exactly the same re-validation the docks/objective/towers above get, and for the
  // same reason. `placeBases` paved the footprint as `baseYard`, but the safe-zone clear and
  // `extraClear` both run AFTERWARDS and reset hexes back to plain ground; a footprint hex that got
  // reset is natural terrain again, and leaving it in would break the ring's whole point ("no
  // natural hexes directly behind each wall segment"). Dropping it instead simply shrinks the
  // compound, and the BFS re-connect from the base centre keeps what's left a single closed shape
  // so the ring stays one ring rather than fragmenting into a ring plus an orphaned islet.
  //
  // Deliberately still the LAST placement pass, after every mutation of `T` is finished (including
  // the boundary ring). Unlike every other pass it does NOT touch `T`: an edge wall lives on the
  // boundaries BETWEEN hexes and owns no tile, so it can't overwrite a dock/turret/objective. It's
  // returned as its own parallel layer.
  for (const base of bases) {
    const surviving = new Set(
      (base.footprint ?? [])
        .filter((h) => isBaseCategory(T.get(axialKey(h.q, h.r))))
        .map((h) => axialKey(h.q, h.r)),
    );
    base.footprint = [...baseFootprint(base.center, surviving, BASE_FOOTPRINT_RADIUS)]
      .map((k) => { const [q, r] = k.split(',').map(Number); return { q, r }; });
  }
  const baseWalls = placeBaseWalls(T, bases);
  for (const base of bases) {
    base.wallEdges = baseWalls.find((w) => w.baseId === base.id)?.edges ?? [];
  }

  const buildingHp = new Map();   // hexKey → remaining HP for destructible OUTPOST (solid, impassable) hexes
  const coverHp = new Map();      // hexKey → remaining HP for destructible walk-through cover hexes
  for (const [k, id] of T) {
    const hp = buildingHpOf(id);
    // #279: this split keys off `isPassableOf(id)`, not the LOS cover tier. The real
    // distinguishing feature downstream is "can a unit stand inside it" (walk-through cover →
    // coverHp) vs "is it a solid structure" (base infra → buildingHp), which is exactly
    // passability. Keying off passability rather than `isSoftCover` keeps the flame-damage
    // multiplier and "soft" collapse FX in `_damageBuildingAt` (world.js, which check
    // `store === this.coverHp`) wired correctly regardless of whether the walk-through cover is
    // the `soft` or `hard` tier — robust even though forest/scrub/drift/wreck/fumarole are `soft`.
    if (hp > 0) (isPassableOf(id) ? coverHp : buildingHp).set(k, hp);
  }
  // #288: the run's wall EDGES, flattened across every base into one list of `{ a, b, baseId }`
  // defs — exactly the shape `makeWallEdgeSet` (data/wallEdges.js) consumes. Each base also keeps
  // its own `base.wallEdges` (above) for anything that needs them per base.
  const wallEdges = baseWalls.flatMap((w) => w.edges.map((e) => ({ ...e, baseId: w.baseId })));
  return { terrain: T, buildingHp, coverHp, bases, alertTowers: finalAlertTowers, wallEdges };
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
// of width: at GAMEPLAY_ZOOM=1.3 the camera shows ~985px of world across, so the corridor reveals
// only a fraction of its length from spawn, and a full run marches the objective progressively
// down it (`spineProgressHexOf` + `pickStageObjective`).
//
// #308: length is no longer a free-standing magic number — it is DERIVED from `BASE_COUNT`, so
// "more objectives" can never silently mean "the same trek, more crowded." The per-base share is
// pinned at what the shipped 3-base/3400px corridor actually gave each base (3400/3 ≈ 1133px,
// rounded to 1140), which is the quantity that determines the FEEL Jackson asked to preserve:
// how far you travel between encounters. Everything downstream is sized off that share rather
// than off total length — `placeBases` stratifies one base per 1/`baseCount` slice (so a slice is
// still ~1140px), and `MIN_GAP_PROGRESS_PX`'s 600px floor was itself sized against a ~1130px
// slice (see its comment), so both stay exactly as valid at 5 bases as they were at 3.
//
// At BASE_COUNT = 5 this is 5700px ≈ 69 hexes of travel end-to-end (was 3400px ≈ 41).
export const CORRIDOR_LENGTH_PER_BASE_PX = 1140;
export const CORRIDOR_LENGTH_PX = CORRIDOR_LENGTH_PER_BASE_PX * BASE_COUNT;

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

// WAVELENGTH — main-axis pixels per full snake wave. ~1500px gives a broad bend roughly every
// 1500px of travel — a clear meander without cramming in tight switchbacks.
//
// #308: deliberately NOT scaled with `CORRIDOR_LENGTH_PX`. Wavelength is a LOCAL property — it
// sets how tight a bend feels as you drive through it. Scaling it with total length would keep
// the bend COUNT fixed (~2.3 waves) and stretch every curve out as the run grows, so a longer run
// would read as a straighter one. Holding it fixed keeps each individual bend exactly the shape
// it is today and simply gives you more of them (~2.3 waves at 3400px → ~3.8 at 5700px), which is
// the "longer trek, same texture" reading Jackson asked for.
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

// #269 (spawn rear-pad fix, playtest follow-up): the hex the player should actually SPAWN at —
// the spine's own first sample, `spine.points[0]` (u = -rearPad, snapped out to the same
// u=0-aligned sample grid `generateSpine` builds on), converted to its nearest hex centre. The
// spine — and the corridor carved around it, `corridorHexSet` — already extends
// CORRIDOR_REAR_PAD_PX behind world origin (u=0); previously the player spawned exactly at
// origin anyway, leaving that whole already-generated, already-safe rear-pad stretch behind them
// and never walked. Spawning here instead means the player walks FORWARD through it on the way
// to u=0 and then on to the first gap tower/base, using space that's already there. Exported so
// both the live scene (`scenes/arena/world.js` `_buildWorld`) and tests derive the exact same
// spawn hex from a spine, with no duplicated "which spine sample is spawn" logic.
export function spineSpawnHex(spine) {
  const p = spine.points[0];
  return pixelToHex(p.x, p.y);
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

// #288 (placement re-specced 2026-07-19 — "instead of a line across the corridor, let's do a full
// RING around the base"): one base's perimeter wall, as a set of hex EDGES. Returns
// `[{ baseId, edges: [{ a, b }] }]`, one entry per base that got a ring (`a`/`b` are the two
// adjacent axial coords the edge separates; `a` is always the BASE-side hex). Consumes nothing from
// `T` and writes nothing to it: an edge wall occupies no tile, so world-gen's terrain map is
// untouched by this pass — the caller hands the returned edges to `makeWallEdgeSet`
// (data/wallEdges.js) as their own parallel layer.
//
// THE CONSTRUCTION: the ring is the TOPOLOGICAL BOUNDARY OF THE BASE'S OWN FOOTPRINT — walk every
// hex of `base.footprint` and wall every edge whose far side is NOT in the footprint. Three
// properties fall straight out of that, none of which needs a patching pass:
//
//   1. SEALED, unconditionally. Any walk from outside the footprint to inside it must, at some
//      step, cross from a non-footprint hex to a footprint hex — and by definition every such
//      edge is walled. There is no seam, no corner gap, and no "between two spans" to slip
//      through: the boundary is a complete cut in the adjacency graph. The owner confirmed the
//      seal is deliberate (with #309's gates being enemies-only, BREACHING IS THE ONLY WAY IN).
//   2. NOTHING NATURAL BEHIND A SPAN. `a` is always a footprint hex, and `placeBases` paves the
//      entire footprint as base infrastructure — so every span backs onto the compound, which is
//      the "the bases should flow with no natural hexes directly behind each wall segment"
//      requirement, satisfied by construction rather than by a proximity heuristic.
//   3. It HUGS the base. There is no setback parameter anymore because there is no longer anything
//      for a setback to mean: the wall is the compound's own perimeter fence. `WALL_LINE_SETBACK_PX`
//      (250px, ~3 hex steps up-corridor) is deleted along with the BFS level-set construction it
//      fed — that whole approach put the wall out in alert-tower territory, which is what failed
//      the 2026-07-19 playtest.
//
// Deliberately walls boundary edges REGARDLESS of what's on the far side — including edges facing
// impassable terrain or the world boundary ring. Those spans are redundant for sealing (nothing
// walks through a mesa either), but the ring is a visible fortification and a fortification with
// its far wall missing because a lake happened to be there reads as broken. Keeping it
// unconditional also means the seal can never be quietly weakened by a later change to what counts
// as passable.
//
// Takes no `spine` and no `T`-derived reachability: unlike the deleted level-set version, a ring
// is a purely local property of the base, so it can't be thrown off by a corridor that doubles
// back (which broke two earlier constructions of the wall LINE on real curved seeds).
export function placeBaseWalls(T, bases) {
  const walls = [];
  if (!bases?.length) return walls;
  for (const base of bases) {
    const footprint = new Set((base.footprint ?? []).map((h) => axialKey(h.q, h.r)));
    if (!footprint.size) continue;
    const edges = [];
    for (const k of footprint) {
      const [q, r] = k.split(',').map(Number);
      for (const n of neighbors(q, r)) {
        if (footprint.has(axialKey(n.q, n.r))) continue;
        edges.push({ a: { q, r }, b: { q: n.q, r: n.r } });   // `a` = the base side
      }
    }
    // #310: turrets are assigned AFTER gates, and read the gate flags in order to avoid them —
    // see `assignWallTurrets`. Order matters here and nowhere else.
    if (edges.length) walls.push({ baseId: base.id, edges: assignWallTurrets(T, base, assignGates(T, base, edges)) });
  }
  return walls;
}

// ── #309: which spans of a ring are GATES ───────────────────────────────────────────────────
// A gate is not a separate structure — it is one of the ring's own spans, flagged `role: 'gate'`
// (data/wallEdges.js). It keeps the same HP pool and the same geometry as any other span, so
// destroying a closed gate simply breaches it like any other span and leaves a permanent hole; and
// it stays SOLID TO THE PLAYER whether open or shut, which is what preserves #288's seal.
//
// TWO gates per ring, on roughly OPPOSITE sides.
//   - Why two and not one: a single gate is a fixed answer to the fight — the player parks off the
//     one opening and farms whatever walks out of it. With one gate facing his approach and one
//     behind, a garrison that sorties can come at him from two headings and he cannot cover both,
//     which is the whole reason a fortification has more than one sally port.
//   - Why not more: every gate is a span he can shoot open, and a ring with gates all round starts
//     to read as a fence rather than a wall. Two is the smallest number that creates a flank.
//
// WHERE THEY SIT. The first gate faces the player's APPROACH — the bearing from the base's centre
// back toward the world origin, which is where the run spawns (the corridor spine starts at u=0 at
// the origin, see `placeBases`). That is a cheap proxy for "the side he will arrive on" that needs
// no spine argument and cannot be thrown off by a corridor that doubles back, unlike anything
// derived from progress. The second gate is the span nearest the opposite bearing.
//
// FORGIVING GEOMETRY (#312 is not built — enemy movement is still straight-line steering, so a
// unit that emerges facing its own wall will grind along it rather than path around). Two things
// keep that from happening: a span is only eligible if the hex on its OUTER side is passable
// ground, so nothing ever opens onto a mesa or a lake; and the outward bearing test naturally
// favours a span whose outward normal points away from the compound, so a unit stepping through is
// already heading into open field. If no eligible span exists (a base wedged against impassable
// terrain on every side), that base simply gets no gate rather than one that opens into a cliff —
// it is then a purely passive fortress, exactly as it was before this issue, which is a safe
// degradation rather than a broken one.
function assignGates(T, base, edges) {
  const c = hexToPixel(base.center.q, base.center.r);
  // Outward bearing of each span: from the base centre toward the OUTER hex's centre. Using the
  // outer hex rather than the edge midpoint makes the measure agree with the direction a unit
  // actually travels as it steps through.
  const withBearing = edges.map((e) => {
    const o = hexToPixel(e.b.q, e.b.r);
    return { e, bearing: Math.atan2(o.y - c.y, o.x - c.x), outerPassable: isPassableOf(T?.get(axialKey(e.b.q, e.b.r))) };
  });
  const eligible = withBearing.filter((w) => w.outerPassable);
  if (!eligible.length) return edges;
  // The approach: back toward the origin, where the run spawns.
  const approach = Math.atan2(-c.y, -c.x);
  const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const nearestTo = (target, exclude) => {
    let best = null, bestD = Infinity;
    for (const w of eligible) {
      if (exclude && w.e === exclude) continue;
      const d = angDiff(w.bearing, target);
      if (d < bestD) { best = w; bestD = d; }
    }
    return best;
  };
  const front = nearestTo(approach, null);
  const rear = nearestTo(approach + Math.PI, front?.e);
  for (const w of [front, rear]) if (w) w.e.role = 'gate';
  return edges;
}

// ── #310: which spans of a ring mount a RAIL-LANCE TURRET ───────────────────────────────────
// Same shape as `assignGates` above and deliberately so: a turret span is one of the ring's own
// spans flagged `role: 'turret'` (data/wallEdges.js), keeping its HP pool, its geometry and its
// contribution to the seal. The gun itself is a separate dormant enemy unit garrisoning the span
// (scenes/arena/bases.js `_spawnWallTurrets`), not a property of the wall — so destroying the span
// destroys the gun (the #287 precedent), while the wall stays a wall.
//
// HOW MANY: PROPORTIONAL to the ring, clamped — `round(eligible * TURRET_SPAN_FRACTION)` into
// [MIN, MAX]. Not a fixed count, because base footprints differ in size and #308 now runs five of
// them: a flat 3 would make a big compound feel under-defended and a small one feel like a
// porcupine. Proportional keeps turret DENSITY along the wall roughly constant, so the wall reads
// the same however big the base is. The clamp is what stops the proportion from doing anything
// silly at the extremes — every ring gets at least two (one gun is a single blind spot away from
// being no guns), and never more than five however large the compound, because past that the
// approach stops having any survivable heading at all.
//
// WHERE THEY SIT: EVENLY SPREAD by bearing, with the first anchored on the player's APPROACH (the
// same origin-facing bearing #309's front gate uses, and for the same reason — it needs no spine
// argument and no progress derivation). The alternative, concentrating them on the approach face,
// was considered and rejected: it makes flanking to the far side a completely safe answer, which
// turns a fortification into a puzzle with one solution. Spread evenly, there is no free heading —
// but a gun is still blocked by every span of the ring OTHER than the one it is bolted to (#310's
// centring exempts only its own span, see TURRET_MOUNT_OFFSET_PX), so only the two or three facing
// the player's arc can engage him at once. The ring is threatening from every side without ever
// bringing its whole armament to bear — and since the centring, that holds INSIDE the compound too
// rather than the guns all falling silent the moment the player is through the wall.
//
// ELIGIBILITY, two rules:
//   - NEVER a gate span. A gate that is also a gun emplacement muddles both reads: the gate's
//     whole visual job (#309) is "this is the moving part, this is where they come out", and
//     bolting a gun on top makes the one span on the ring the player most needs to read at a
//     glance into the busiest. They are also mechanically at odds — a gate wants to be approached
//     (it is the sally port) and a turret wants to deny approach. Keeping them disjoint means
//     every span on the ring says exactly one thing.
//   - The OUTER hex must be passable ground, matching gate eligibility. A gun whose entire field
//     of fire is the inside of a mesa is wasted, and worse, it is wasted INVISIBLY — the player
//     never learns why that stretch of wall was harmless.
// If nothing is eligible the ring simply gets no turrets, the same safe degradation as gates.
const TURRET_SPAN_FRACTION = 0.22;
const TURRET_SPANS_MIN = 2;
const TURRET_SPANS_MAX = 5;

function assignWallTurrets(T, base, edges) {
  const c = hexToPixel(base.center.q, base.center.r);
  const eligible = edges
    .filter((e) => e.role !== 'gate' && isPassableOf(T?.get(axialKey(e.b.q, e.b.r))))
    .map((e) => {
      const o = hexToPixel(e.b.q, e.b.r);
      return { e, bearing: Math.atan2(o.y - c.y, o.x - c.x) };
    });
  if (!eligible.length) return edges;
  const count = Math.max(TURRET_SPANS_MIN, Math.min(TURRET_SPANS_MAX,
    Math.round(eligible.length * TURRET_SPAN_FRACTION)));
  const approach = Math.atan2(-c.y, -c.x);
  const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const taken = new Set();
  // One evenly spaced target bearing per turret, starting at the approach; each claims the nearest
  // still-unclaimed eligible span. A ring can have fewer eligible spans than the count asks for
  // (a base hemmed in by terrain), in which case some targets find nothing left and the ring just
  // gets fewer guns — never a duplicate, never a crash.
  for (let i = 0; i < count; i++) {
    const target = approach + (i * 2 * Math.PI) / count;
    let best = null, bestD = Infinity;
    for (const w of eligible) {
      if (taken.has(w.e)) continue;
      const d = angDiff(w.bearing, target);
      if (d < bestD) { best = w; bestD = d; }
    }
    if (!best) break;
    taken.add(best.e);
    best.e.role = 'turret';
  }
  return edges;
}

// MAX_WORLD_RADIUS: a finite bounding cap on the corridor's reach in hex-distance from origin, used
// as `this.worldRadius` (world.js) for the fallback outpost-spawn ring cap and passed through to
// generateTerrain. The corridor's far end sits at ~CORRIDOR_LENGTH_PX + curviness pixels from
// origin; converting the worst case to hex-distance (÷ the smallest px-per-hex, ~72) and adding a
// little headroom lands here. Nothing scans a full `range({0,0}, MAX_WORLD_RADIUS)` disc in the
// live corridor path anymore (both generateTerrain and boundaryRingKeys take the explicit hex set),
// so this is a loose cap, not a per-hex cost driver.
//
// #308: DERIVED now, not a hand-tuned 60. The old literal was sized against the old 3400px
// corridor; a longer corridor silently overflowing its own bounding cap would break the fallback
// spawn ring and `nearestValidHex`'s search budget (data/spawnPlacement.js sizes `searchSteps`
// off it). Worst case reach from origin is the far end plus the spine's peak lateral swing (both
// harmonics: `curviness` + 0.35*`curviness`), converted at the SMALLEST px-per-hex step (the hex
// distance metric advances ~1.5*HEX_SIZE = 72px per step along a diagonal), plus 20% headroom.
// = ceil((5700 + 405) / 72 * 1.2) = 102 at BASE_COUNT 5, and it re-derives if either changes.
export const MAX_WORLD_RADIUS = Math.ceil(
  ((CORRIDOR_LENGTH_PX + CORRIDOR_CURVINESS * 1.35) / (HEX_SIZE * 1.5)) * 1.2,
);

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

// #283 ("guarantee a calm, threat-free start and genuinely calm travel gaps between base
// encounters"): the enforced MINIMUM spine-progress distance a base/tower must sit past
// whatever came before it (spawn, for the very first one; the previous base, for every
// successive gap) — see `placeBases`/`placeGapTowers` below, which both chain a `prevProgress`
// floor from this constant instead of picking a fully unconstrained random hex within their
// stratified slice.
//
// SIZING: two competing constraints, both checked empirically (scripts-style sweep against the
// REAL `generateSpine`/`corridorHexSet` pipeline, 2000 seeds, mirrored in worldgen.test.js) not
// just guessed:
//   - Bigger is more "calm" — sized against the FASTEST chassis (light, 268px/s,
//     chassis/light.js `maxSpeed`) as the binding case, since a slower chassis only gets MORE
//     calm seconds out of the same px floor.
//   - But `baseCount` floors have to fit end-to-end inside ONE corridor alongside the existing
//     stratified-slice segmentation, which only gives each base a 1/`baseCount` slice (~1130px)
//     to work with. #308 is why this argument SURVIVED going from 3 bases to 5: corridor length
//     is now `CORRIDOR_LENGTH_PER_BASE_PX * BASE_COUNT`, so the slice each base gets is a
//     constant ~1140px no matter the count, and the sweep below still binds. Push the floor
//     too high and `placeBases`'s own fallback (see its comment) increasingly can't reach the
//     full target — the 2000-seed sweep showed ZERO shortfalls up to 600px, but a fast-growing
//     tail of shortfalls from ~700px on (14/2000 short at 700px, worsening from there), so 600px
//     is the largest value that reliably holds the FULL floor on every gap of every seed, not
//     just "most of the time."
// 600px / 268px/s ≈ 2.2s for light, ≈3.1s for medium (195px/s), ≈4.4s for heavy (135px/s) — a
// real, if not enormous, calm stretch for every chassis, and reliably ENFORCED (not just
// probable) given the corridor's own length budget. Comfortably longer than the alert tower's
// own "a few seconds" countdown (ALERT_COUNTDOWN_MS = 3000ms, data/alertTower.js) once its own
// 320px detect bubble is subtracted off the far end (600 - 320 = 280px genuinely calm even in
// the worst-case RNG placement — see the cross-check below and awareness.js
// `PROXIMITY_WAKE_RANGE_CAP`'s own comment for the matching audit).
//
// Cross-checked against the audit in awareness.js (`PROXIMITY_WAKE_RANGE_CAP`, unified at 320px
// — the SAME value as alertTower.js's `ALERT_DETECT_RADIUS`, so the two audited radii don't
// compound) — even in the WORST case (a gap-tower's own random placement landing right at the
// far base's position, zero slack between tower and base — `placeGapTowers`'s candidate filter
// technically allows this), the calm stretch before ANY detection envelope kicks in is
// MIN_GAP_PROGRESS_PX minus that one shared 320px radius: 600 - 320 = 280px, still a real calm
// buffer even for the fastest chassis in the worst RNG case, and larger (up to the full 600px)
// whenever the tower doesn't land flush against the base. Playtest-tunable like every other
// placement constant in this file.
export const MIN_GAP_PROGRESS_PX = 600;
// Converted to the same hex-progress unit `spineProgressHexOf`/the straight-line-distance
// fallback both already use, so `placeBases`/`placeGapTowers` can compare it directly against
// `progressOf(...)` results without a separate px<->hex conversion at every call site.
export const MIN_GAP_PROGRESS_HEX = MIN_GAP_PROGRESS_PX / HEX_STEP_PX; // ≈7.22

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
