// #269 §3-§7 (issue: base population rework — dormant docks + alert towers) — scene-side wiring
// for the base population system. Methods use `this` (the ArenaScene); composed onto the
// prototype via Object.assign, same as the other mixins. The pure logic underneath lives in
// data/alertTower.js (countdown state machine) and data/bases.js (nearest-base routing +
// fast/slow wake-response split) — this file is just the thin per-frame glue: real world
// positions, the live `this.enemies` array, and `this.bases`/`this.alertTowerHexes` (both set
// by `_buildWorld`, world.js, from `generateTerrain`'s result — `this.bases` from `placeBases`,
// `this.alertTowerHexes` from `placeGapTowers`, #275 redesign: one tower placed solo per gap
// between successive bases along the corridor's progression, not anchored to any base or
// "outpost" concept).
import { hexToPixel, axialKey } from '../../data/hexgrid.js';
import { ART_SCALE } from '../../art/index.js';
import { DOCK_DOOR_TEX, DOCK_DOOR_SLIDE, BASE_INFRA_COLOR } from '../../art/hexArt.js';
import { DORMANT, AWARE, shouldBecomeAware, PROXIMITY_WAKE_RANGE_CAP, NOISE_WINDOW_MS, NOISE_AGGRO_RANGE } from '../../data/awareness.js';
import { makeAlertState, tickAlertTower, ALERT_DETECT_RADIUS, pickSirenSource } from '../../data/alertTower.js';
import { isFastWakeKind } from '../../data/bases.js';
import { isEnemyKind } from '../../data/enemyKinds.js';
import { DEPTH, strokeHexRing, wallCollideRadius, PLAYER_WALL_COLLIDE_RADIUS } from './shared.js';
import { nudgeFromGateMouth, gateMouthOccupied } from '../../data/gateClearance.js';
import { Audio } from '../../audio/index.js';
import { nearestValidPixel } from '../../data/spawnPlacement.js';
import { makeDockResupplyState, tickDockResupply, spendDockResupply, DOCK_RESUPPLY_COOLDOWN_MS } from '../../data/dockResupply.js';
import {
  mulberry32, drawDockKind, dockCountFor, baseLateFraction, towerPatrolComposition,
} from '../../data/worldgen.js';
import { isBaseObjectiveDestroyed, isBaseFullyCleared } from './mission.js';
import { getTerrain, buildingHp as terrainBuildingHp, isPassable } from '../../data/terrain.js';
import { gateEdges, setGateOpen, turretEdges, spanTurretMount, WALL_THICKNESS_PX } from '../../data/wallEdges.js';
import {
  makeGateState, tickGate, gatePassable, GATE_STAGGER_MAX_MS,
  GATE_OPEN, GATE_OPENING, GATE_OPENING_MS, GATE_CLOSED, GATE_CLOSING, GATE_CLOSING_MS,
} from '../../data/gateCycle.js';
import {
  makeGateDemand, gateRequestOnRoute, remainingToGate, requestsGate, trackApproach,
} from '../../data/gateDemand.js';
import { findHexPath } from '../../data/hexRoute.js';
import { pixelToHex } from '../../data/hexgrid.js';
import { listenerOf, livePlayersOf, playersOf, primaryPlayerOf, targetPlayerFor } from './players.js';
import { scaleComposition, scaleDockWave } from '../../data/playerScaling.js';

// #309 playtest — how often the DEMAND scan runs, and how many garrison units it may ask per scan.
// The scan is the expensive half of demand-driven gates: each unit it asks costs one A* search
// (data/hexRoute.js `findHexPath`), which is the exact cost #312's per-tick router budget exists to
// keep off the frame. So it is throttled AND capped, and the units are visited round-robin so a
// large garrison is still covered completely, just over several scans rather than in one.
//
// 250ms / 4 units means a 12-unit garrison is fully re-asked every ~750ms, comfortably inside
// gateDemand's 1500ms grace window — so a gate that is genuinely wanted never lapses between scans,
// which is what lets a sampled signal be read as if it were continuous.
// 250ms / 6 units means the worst garrison seen in a real world (35 eligible ground movers across
// five woken bases) is fully re-asked every ~1.5s, comfortably inside gateDemand's grace window —
// so a gate that is genuinely wanted never lapses between scans, which is what lets a sampled
// signal be read as if it were continuous. Was 4 per scan, which gave a 2.2s worst-case cycle
// against a then-1500ms grace: a gate wanted by only a FEW units (a depleted garrison late in a
// fight) could have its request expire before the round-robin cursor came back to it. Raised
// alongside the grace window rather than instead of it — see GATE_DEMAND_GRACE_MS.
const GATE_DEMAND_SCAN_MS = 250;
const GATE_DEMAND_UNITS_PER_SCAN = 6;

// ── The node cap for a DEMAND search, and why it is NOT the movement router's ───────────
// PLAYTEST 2 ("I don't see the gates actually opening for the tanks when they seem to be wanting
// it"). This was the bug, and it was invisible from outside: a demand search that hits its node cap
// returns `complete: false`, the scan skips it, and a unit that genuinely wants out registers
// nothing — which looks exactly like a base that correctly has nothing to open for.
//
// MEASURED across six real generated worlds (scripts/diagnose-gates-309.mjs), player at his actual
// 880-1360px combat distance, sweeping the cap over every eligible ground unit:
//
//     cap  400 →  27/35, 6/8, 6/10, 9/12 complete   (expandedMax pinned at exactly 400)
//     cap  800 →  35/35, 8/8, 10/10, 12/12          (expandedMax 567, 403, 457, 542)
//     cap 1600 →  no further improvement
//
// So 400 sat right on the boundary and clipped roughly a quarter of all demand — tanks included
// (4/6, 4/5, 6/7 in the failing worlds), which is precisely what Jackson saw. 800 was sufficient in
// every world sampled; 1200 is that with headroom, since a 5700px corridor can put a garrison
// further from the player than anything sampled here.
//
// Why the demand search legitimately needs a bigger budget than the movement router's 400:
//   - It runs against the gates-as-passable predicate, so it explores MORE of the world than a
//     movement search does (every ring is porous, so the frontier does not get pruned by walls).
//   - Its result is BINARY. The movement router degrades gracefully — an incomplete search still
//     returns a useful partial route and the unit walks that way. A demand search that falls short
//     contributes nothing at all, so "close enough" has no value here.
//
// The perf argument #312 used to drop the movement cap 1200 → 400 does not transfer, because the
// two run at completely different volumes: the movement router spends up to `budgetPerTick` (4)
// searches EVERY TICK (~240/s at 60fps), while this scan spends at most 6 every 250ms (24/s) no
// matter how many units exist. A* is also goal-directed, so a search that SUCCEEDS stops at the
// goal and never approaches its cap — raising the ceiling only costs anything on searches that
// fail, and with gates hypothetically open most garrison units can genuinely reach the player.
// Measured cost of this change in the live game: see `expandedPerSec` in the diagnostic — 400 → 1200
// moved total demand-search node expansion from ~1250/s to ~1600/s, under 0.5% of engine step time.
export const GATE_DEMAND_MAX_NODES = 1200;


// Running counters for the demand scan, read by scripts/audit-gates-309.mjs. Plain integer
// increments on a path that already runs an A* search, so the cost is unmeasurable — and they are
// the difference between diagnosing "no gate opened" and guessing at it, which is exactly how the
// first playtest fix went wrong (a `complete: false` search registers no demand and looks
// identical, from outside, to a base that correctly has nothing to open for).
function makeGateDemandStats() {
  return {
    scans: 0, searches: 0, complete: 0, incomplete: 0, noted: 0, nullGate: 0,
    eligible: 0, expandedTotal: 0, expandedMax: 0, byKind: {},
  };
}

// #269 overhaul ("a pulsing red ring of some kind once it's activated") — the live ring drawn
// over a counting-down alert tower. Was the beacon's own orange (0xff6a3a); Jackson asked for a
// clearly RED, urgent read once a tower is committed, so it's now a saturated alarm red distinct
// from the calm orange beacon light — "this tower is actively calling in reinforcements RIGHT NOW"
// rather than "there is a tower here". Since the countdown is sticky (data/alertTower.js), this
// ring persists the whole activated duration, not just while the player loiters.
const ALERT_RING_COLOR = 0xff2a2a;
// Ring radius/alpha at fraction 0 (just started) and fraction 1 (about to trigger) — grows and
// brightens as the countdown nears completion, same "escalating" idea the issue asks for. The
// PULSE below is layered on top of this baseline escalation.
const ALERT_RING_RADIUS_MIN = 14;
const ALERT_RING_RADIUS_MAX = 34;
const ALERT_RING_ALPHA_MIN = 0.35;
const ALERT_RING_ALPHA_MAX = 0.95;
// #269 overhaul: the throbbing PULSE layered on top of the escalation above — an oscillating
// sine over an accumulated per-tower timer, so the ring visibly BEATS (grows/shrinks + fades in/
// out) on a fixed cadence rather than only smoothly swelling with the countdown. Period ~640ms
// reads as an urgent recurring alarm pulse; the swings are added to the escalation baseline so a
// near-complete countdown still both throbs AND sits at its larger/brighter escalated size.
const ALERT_RING_PULSE_PERIOD_MS = 640;
const ALERT_RING_PULSE_RADIUS = 6;    // +/- px the radius throbs around its escalated baseline
const ALERT_RING_PULSE_ALPHA = 0.3;   // +/- alpha the ring throbs around its escalated baseline

// #269 playtest follow-up — the audio pulse's re-trigger interval (ms) shrinks from
// ALERT_PULSE_INTERVAL_MIN..MAX as `fraction` climbs, so the BEEP RATE itself quickens on top
// of alertPulse's own per-call pitch/brightness rise (audio/sfx.js). 520ms at fraction 0 reads
// as a slow, deliberate "something is scanning"; 120ms near fraction 1 reads as a frantic
// about-to-happen alarm.
const ALERT_PULSE_INTERVAL_MAX_MS = 520;
const ALERT_PULSE_INTERVAL_MIN_MS = 120;

// #385 — the CONTINUOUS post-signal red pulse. Once a tower has SIGNALED (its countdown fired and
// woke the base), it stays lit until destroyed: a steady red hexring that beats at a fixed
// cadence (no more escalation — the countdown is over, this is a persistent "this tower is live"
// marker). Drawn per-tower on EVERY signaled-alive tower (visual doesn't fatigue like stacked
// audio does — only the SIREN is deduped to the nearest one). Sits between the escalation ring's
// min/max size so it reads as clearly "on" without pretending to still be counting down.
const SIGNALED_RING_RADIUS = 26;
const SIGNALED_RING_ALPHA = 0.8;
const SIGNALED_RING_PULSE_PERIOD_MS = 760;   // steady alarm beat, slightly slower than the spool-up
const SIGNALED_RING_PULSE_RADIUS = 5;        // +/- px the radius throbs
const SIGNALED_RING_PULSE_ALPHA = 0.3;       // +/- alpha the ring throbs

// #285 ("units at a base shouldn't all snap into motion in the same instant"): the randomized
// per-unit delay (ms) `_wakeBase` stamps onto `e.reactDelayMs` before a newly-woken unit's
// tactical brain actually kicks in (movement, turret tracking, firing — see enemies.js
// `_isReacting`). Deliberately much shorter than the tactical AI's own re-decide cadence
// (`DECIDE_MIN`/`DECIDE_MAX` in enemies.js, 750-1500ms) — this isn't a second decision timer,
// just enough of a stagger to desync a handful of units reacting on the same tick into a
// natural-looking "oh, we're under attack" cascade rather than a synchronized snap. 80ms is
// short enough to be barely perceptible on its own (~5 frames at 60fps) but non-zero, so even
// a base's very FIRST unit to react doesn't feel instantaneous; 380 is long enough that, spread
// across a handful of units, the gaps between them are individually noticeable (a few frames to
// ~1/4 second apart) without any single unit reading as slow to respond — well under the ~0.5s
// threshold where a delay starts reading as "this thing hasn't noticed the fight yet" rather
// than "reacting a beat after its neighbor." Owner: tunable via playtest.
const WAKE_REACT_STAGGER_MIN_MS = 80;
const WAKE_REACT_STAGGER_MAX_MS = 380;

// #269 playtest follow-up (patrol units): kind + headcount for the roaming units stationed near
// each alert tower. A single cheap `infantry` trooper per tower (the smallest, weakest kind in
// the game, see enemyKinds.js) rather than a tank/drone squad — infantry's own idle-wander
// already has an existing avoidWater/lumbering-mob feel tuned for exactly this "a trooper
// loiters near a fixed point" behavior, so it reuses that machinery for free.
//
// #269 playtest follow-up round 2 (Jackson: "that's insane" re: a lone trooper): 1 read as
// undefended, not "a light escort presence." Bumped to 5 — big enough to read as a real patrol
// squad guarding the tower (not a solo guy standing there), still well short of a base-sized
// fight (a base's own dock clusters run 3-5 docks, several with 2-3 units EACH — a 5-strong
// infantry patrol stays clearly lighter than that). Kept as a single flat count (not a rolled
// range like `dockCountFor`) since the ask was just "meaningfully more," not a new escalation
// curve.
//
// #357 (mixed + escalating patrols): the patrol is no longer a single kind x flat count. Its
// composition now comes from `towerPatrolComposition(towerIndex, towerCount)` (data/worldgen.js),
// which escalates by WHICH tower along the run it is — see that function for the tier table, the
// size ramp, and why the carrier was left out. These two constants survive as the TIER-0 identity
// (`TOWER_PATROL_TIERS[0]` is still exactly five infantry, so the first patrol of a run is
// bit-for-bit what #269's playtest signed off on) and are what the existing tests pin.
export const TOWER_PATROL_KIND_ID = 'infantry';
export const TOWER_PATROL_COUNT = 5;

// #269 playtest follow-up round 2: how far apart a tower patrol's units are scattered around
// their shared spawn point, mirroring `DOCK_HUDDLE_OFFSET` below (same "huddle, don't stack"
// idea for a multi-unit spawn at one shared point) — infantry's own sprite is small/cheap
// (scale-wise the lightest kind in the roster), so it reuses the same 16px huddle radius rather
// than needing the wider berth tank/helicopter docks get.
const TOWER_PATROL_HUDDLE_OFFSET = 16;

// #269 playtest follow-up (dock composition): how far apart a multi-unit dock's units (2-3
// tanks, 2 helicopters — see data/worldgen.js `dockCountFor`) are scattered around their shared
// dock hex's centre pixel, so they don't all render exactly on top of one another. Mirrors
// enemies.js's `TURRET_HUDDLE_OFFSET` (10px) for the same "huddle, don't stack" idea, just a
// bit wider — tank/helicopter sprites (scale 0.4/0.6, both shrunk for this exact reason, see
// enemyKinds.js) read bigger on screen than a turret (scale 0.42), so they need more room to
// stay visually distinct as several units rather than reading as one blob.
const DOCK_HUDDLE_OFFSET = 16;

// #314 (swarm docks: 10 drones / 10 infantry from ONE dock hex): a single ring of
// `DOCK_HUDDLE_OFFSET` can only seat a handful of bodies before they stack on top of each other,
// so a cluster bigger than `DOCK_RING_CAPACITY` spills onto successive concentric rings, each
// `DOCK_RING_STEP` further out. Same shape `_spawnInfantryMob` (scenes/arena/enemies.js) already
// uses for its 28-trooper mob, with the same intent — a dense knot the player plows through, not a
// wide disc. Ten bodies fills ring 0 (6) plus 4 on ring 1, i.e. everything stays within 32px of the
// dock's centre pixel: still comfortably inside the dock's own hex and inside the base's walls
// (#288's sealed ring), so a swarm dock can't leak units outside the compound it's defending.
const DOCK_RING_CAPACITY = 6;
const DOCK_RING_STEP = 16;

// Where the i-th of `count` units in a dock cluster sits relative to the dock's centre pixel.
// count === 1 is dead centre (unchanged); anything more is scattered around concentric rings. The
// constant `Math.PI / 4` phase offset (and the per-ring 0.4 twist) matches the existing dock/turret
// huddle look — no unit directly north, and successive rings don't line up spoke-on-spoke.
function dockClusterOffset(i, count) {
  if (count <= 1) return { dx: 0, dy: 0 };
  const ring = Math.floor(i / DOCK_RING_CAPACITY);
  const idxInRing = i % DOCK_RING_CAPACITY;
  const ringCount = Math.min(DOCK_RING_CAPACITY, count - ring * DOCK_RING_CAPACITY);
  const a = (idxInRing / ringCount) * Math.PI * 2 + Math.PI / 4 + ring * 0.4;
  const r = DOCK_HUDDLE_OFFSET + ring * DOCK_RING_STEP;
  return { dx: Math.cos(a) * r, dy: Math.sin(a) * r };
}

// #323: THE one place that turns "this dock owes N bodies of kind K at pixel (x, y)" into actual
// spawned units. Both spawn paths call it — `_spawnDormantUnits` at deploy time and
// `_resupplyDock` mid-fight — because they had already diverged once: #314 taught the initial
// spawn about swarm counts and cluster rings, #311 reworked resupply's timing, and neither
// noticed resupply was still making a single bare `_spawnKind` call. So a swarm dock opened with
// its full 10 and then trickled back one body at a time, which is the bug Jackson reported. With
// the count lookup, the ring layout, the terrain snapping and the kind dispatch all living here,
// the two paths cannot drift apart again without both changing together.
//
// `awareness` is the one genuine difference between the callers and is passed in: a deploy-time
// cluster is DORMANT (inert until its base wakes), a resupply cluster is AWARE (its base is
// already fighting, so a fresh unit joins the fight immediately rather than standing inert).
export function spawnDockCluster(scene, { x, y, kindId, count, baseId, dockKey, awareness }) {
  const spawned = [];
  for (let i = 0; i < count; i++) {
    // Offsets come from `dockClusterOffset` (concentric rings) so a 10-strong swarm seats every
    // body without stacking, and each point is snapped through `nearestValidPixel`
    // (data/spawnPlacement.js — the same #115 fix `_spawnInfantryMob` uses) so an outer-ring unit
    // can never land off-map or on impassable terrain. A no-op for the count === 1 case (dead
    // centre of an already-validated dock hex).
    const { dx, dy } = dockClusterOffset(i, count);
    const snapped = count > 1 ? nearestValidPixel(scene.terrain, scene.worldRadius, x + dx, y + dy) : { x, y };
    // #269 playtest follow-up: a mech-kind dock goes through `_spawnMech` (the full Mech +
    // tactical-AI-state constructor); every other kind through `_spawnKind` (HpBody + simple
    // per-kind behaviour). `isEnemyKind` is the same predicate `_spawnEnemy`'s own dispatcher
    // uses to tell the two apart, reused rather than reinvented.
    const e = isEnemyKind(kindId) ? scene._spawnKind(snapped.x, snapped.y, kindId) : scene._spawnMech(snapped.x, snapped.y, kindId);
    e.awareness = awareness;
    e.baseId = baseId;
    e.dockKey = dockKey;
    // #283 audit: cap the DORMANT proximity-wake radius (data/awareness.js
    // `PROXIMITY_WAKE_RANGE_CAP` has the full reasoning) — a no-op for every kind whose
    // `detectRange` was already below the cap (tank/helicopter/carrier/mech); the turret kinds'
    // wildly larger combat-range-derived values are the ones it bites on. Only meaningful for a
    // dormant unit — an AWARE resupply unit is already engaged and never consults its wake radius.
    if (awareness === DORMANT) e.detectRange = Math.min(e.detectRange, PROXIMITY_WAKE_RANGE_CAP);
    // #415: a flying dock unit (helicopter/drone) is HIDDEN while it sits in the dock — a docked
    // flyer shouldn't be visible parked on the pad. It stays invisible (alpha 0) until it LAUNCHES:
    // `dockedTakeoff` marks it for the takeoff beat (data/takeoff.js), which _updateVehicle runs the
    // first frames after the unit wakes (a DORMANT unit never ticks its brain, so the fade genuinely
    // begins at the moment of wake, over the dock). A DORMANT flyer waits inert+invisible; an AWARE
    // resupply flyer materialises the same way the instant it spawns into an already-fighting base.
    if (e.flying) {
      e.dockedTakeoff = true;
      e.view?.setAlpha?.(0);
    }
    spawned.push(e);
  }
  return spawned;
}

// #269 Part 2 ("dock open/closed states"): how close a dock's own live unit(s) (matched by
// `dockKey`) must stay to the dock's own pixel centre for the hex to still read as OCCUPIED. A
// DORMANT cluster sits within `DOCK_HUDDLE_OFFSET` (16px) of centre, well inside this; the
// moment a woken unit moves meaningfully away to engage the player (#285: no longer capped by a
// leash — it can travel arbitrarily far once it commits to the fight), or it dies, the dock reads
// as VACATED and closes. Deliberately bigger than the huddle scatter (so idle jitter never
// falsely triggers a close) but still small enough that engaging the player reliably closes the
// dock almost immediately, matching the issue's "the dock closes once its units leave" framing.
// Owner: tunable via playtest.
const DOCK_VACATE_RADIUS_PX = 60;

// #395 part B (owner): a hex outline stroked around every DOCK hex at DEPTH.DOCK_BORDER (above the
// tile, its doors and the DOCK_FX band, but BELOW the units) so a dock reads as a distinct,
// clearly-bounded structure regardless of open/closed state — while a unit standing on the dock
// still renders OVER the ground-level frame. The colour/weight MATCHES the other base-hex borders
// (`BASE_INFRA_COLOR.edge`) so it's a subtle frame like the rest of the base, not a heavy black
// box. Biome-neutral by construction. Radius sits just inside the hex's HEX_SIZE (48) corner so the
// stroke lands on the hex edge and frames it rather than overhanging into neighbours.
const DOCK_BORDER_COLOR = BASE_INFRA_COLOR.edge;
const DOCK_BORDER_ALPHA = 0.65;
const DOCK_BORDER_WIDTH = 2.5;
const DOCK_BORDER_RADIUS = 46;

export const BasesMixin = {
  // §4: spawn every base's docked units NOW, at deploy time, dormant — not lazily, not via the
  // old off-camera `_offscreenSpawnPoint`/squad system. Called once from ArenaScene.create(),
  // in place of the old `_spawnSquad()` opening-squad call (that method and its `DEFAULT_SQUAD`
  // table were deleted outright by #344, which confirmed they had no remaining call sites).
  //
  // #269 playtest follow-up ("fold mechs into the dock system"): a dock's `kindId` can now be
  // EITHER a non-mech ENEMY_KINDS id or a full mech loadout id (data/enemies.js `ENEMIES` — see
  // data/worldgen.js's BASE_LATE_KIND_POOL comment). `isEnemyKind` (data/enemyKinds.js — "is
  // this id in the non-mech kind table") is the SAME predicate `_spawnEnemy`'s own dispatcher
  // already uses to tell the two apart, reused here rather than invented fresh, so a dock
  // branches to `_spawnMech` (the full Mech + tactical-AI-state constructor) instead of
  // `_spawnKind` (HpBody + simple per-kind behavior) exactly when `_spawnEnemy` would have.
  // Whichever constructor built it, the SAME DORMANT/baseId/dockKey tagging below applies
  // uniformly — `_updateEnemy`'s DORMANT early-return and `_wakeBase`'s wake loop both key off
  // `e.awareness`/`e.baseId`/`e.dockKey`, never off `e.kind`, so nothing downstream needs to care
  // which path built a given docked unit.
  //
  // #269 playtest follow-up (dock composition): a dock is now a KIND + COUNT
  // (`dock.count`, data/worldgen.js `dockCountFor`) — 2-3 tanks or 2 helicopters can share ONE
  // dock hex. Each unit in that cluster is scattered a small `DOCK_HUDDLE_OFFSET` around the
  // dock's centre pixel (same "huddle around one validated point" idea as enemies.js's
  // `_spawnTurretCluster`/`_spawnInfantryMob`, just inlined here since a dock cluster shares
  // one already-terrain-validated hex — no fresh nearest-passable-hex lookup needed). Every
  // unit in the cluster shares the SAME `baseId`/`dockKey` so `_wakeBase` wakes them together
  // as one group.
  //
  // #287 (owner, 2026-07-19): the interior turret-emplacement loop that used to follow the dock
  // loop is GONE along with its terrain hex — a base's fixed guns are its WALL turrets
  // (`_spawnWallTurrets` below), spawned the same DORMANT way and tagged with the same `baseId`.
  //
  // #269 §3 "rare multi-spawn exception" (playtest follow-up): also records, per DOCK hex only
  // (see data/dockResupply.js's file header for why), the metadata
  // `_updateDockResupply` needs later — the dock's kind/position/owning base and a fresh
  // resupply state — in `this._dockResupplyMeta`/`this._dockResupplyStates`. Built here rather
  // than a separate pass since this loop already visits every dock exactly once.
  _spawnDormantUnits() {
    this._dockResupplyMeta = new Map();
    this._dockResupplyStates = new Map();
    // #311: one generator for every dock's resupply cadence/phase roll, derived from the run's
    // world seed (set by `_buildWorld`, world.js) so a seeded run reproduces the same staggering
    // — the same reason worldgen.js threads a `mulberry32` rng rather than calling `Math.random`.
    // Falls back to a random draw only when there's no seed (a test stub that never built a world).
    // #323: kept on the scene (not just local) because mid-fight resupply now re-draws each
    // dock's kind from the base's pool, and that draw must come from the SAME seeded stream so a
    // seeded run stays reproducible end-to-end rather than only up to the first reinforcement.
    this._dockRng = mulberry32(((this._worldSeed ?? Math.floor(Math.random() * 0x100000000)) ^ 0x00c0ffee) >>> 0);
    const dockRng = this._dockRng;
    const baseList = this.bases ?? [];
    for (let bi = 0; bi < baseList.length; bi++) {
      const base = baseList[bi];
      for (const dock of base.docks) {
        const { x, y } = hexToPixel(dock.q, dock.r);
        const dockKey = axialKey(dock.q, dock.r);
        // #323: `lateFraction` is this BASE's position on the early→late difficulty ramp
        // (worldgen.js `baseLateFraction`), captured here so `_resupplyDock` can re-draw from the
        // same difficulty-appropriate pool mix world-gen used, without needing the base's index.
        this._dockResupplyMeta.set(dockKey, {
          baseId: base.id, kindId: dock.kindId, x, y, lateFraction: baseLateFraction(bi, baseList.length),
        });
        this._dockResupplyStates.set(dockKey, makeDockResupplyState(DOCK_RESUPPLY_COOLDOWN_MS, dockRng));
        // #323: the whole cluster now goes through the ONE shared placement seam, the same one
        // `_resupplyDock` calls — see `spawnDockCluster` above for why.
        // #350: the base GARRISON scales with player count. `dock.count` is world-gen's
        // per-kind body count (worldgen.js `dockCountFor`, which is also where swarm docks get
        // their `DOCK_SWARM_COUNT` burst), so scaling it here scales both ordinary garrison
        // bodies and swarm sizes through the one seam — no second rule for swarms. Scaled at
        // SPAWN time rather than baked into `dock.count` at world-gen time so the number is read
        // from the live roster; `_initCoop` has already added any garage-joined player (#349) by
        // the time this runs.
        // #389: `scaleDockWave` (not the bare `scaleEnemyCount`) so a single-body MECH dock stays
        // ONE mech at any player count — a mech dock's co-op difficulty comes from resupply
        // cadence, never two heavy mechs from one hex at once. Swarm/vehicle docks scale as before.
        spawnDockCluster(this, {
          x, y, kindId: dock.kindId,
          count: scaleDockWave(dock.kindId, dock.count ?? 1, playersOf(this).length),
          baseId: base.id, dockKey, awareness: DORMANT,
        });
      }
    }
    this._spawnWallTurrets();
    this._drawDockBorders();
  },

  // #395 part B: stroke the strong dark border ring around every dock hex. Driven off
  // `_dockResupplyMeta` (populated just above), which already holds the pixel centre of every dock
  // — so this frames exactly the dock hexes, both open and closed, biome-agnostically. One static
  // `Graphics` per dock, positioned at the dock centre and stroked as a hex outline via the shared
  // `strokeHexRing` helper (the same `hexCorners`-based path terrain hexes and the alert/objective
  // rings use), at DEPTH.DOCK_BORDER so it sits above the tile and door leaves but below the units.
  // No per-tick redraw needed — the frame never moves or resizes; it's drawn once at spawn.
  _drawDockBorders() {
    if (!this.add?.graphics || !this._dockResupplyMeta) return;
    for (const meta of this._dockResupplyMeta.values()) {
      const g = this.add.graphics().setPosition(meta.x, meta.y).setDepth(DEPTH.DOCK_BORDER);
      strokeHexRing(g, DOCK_BORDER_RADIUS, DOCK_BORDER_WIDTH, DOCK_BORDER_COLOR, DOCK_BORDER_ALPHA);
    }
  },

  // #310: seat one Wall Lance on every span flagged `role: 'turret'` (worldgen.js
  // `assignWallTurrets` decides which). Called from `_spawnDormantUnits` above so wall guns join
  // the base's garrison through the exact same path as its dock units and its emplacement
  // turrets — same DORMANT start, same `baseId`, same proximity-wake cap.
  //
  // DORMANT, NOT ALWAYS-ON. This is the single most consequential behaviour choice in the issue
  // and it follows #309's lead deliberately: that issue hung its sorties off `_wakeBase`
  // specifically to avoid the game holding two disagreeing notions of whether a base is awake, and
  // a wall gun is exactly the same kind of thing. An always-on turret would be the game's ONLY
  // unit that shoots at a base the player has not yet triggered, which breaks the dormant-base
  // fiction outright — you would be sniped, from 900px, by a fortress that the HUD, the win
  // condition and every other unit inside it still consider asleep. It would also silently defeat
  // the stealth window #269 built (destroy the alert tower before the countdown and the base never
  // wakes), since the wall guns would have woken it for you. Dormant means the approach has a real
  // shape: quiet, then the base notices, then the wall lights up.
  _spawnWallTurrets() {
    for (const edge of turretEdges(this.wallEdges)) {
      const mount = spanTurretMount(edge);
      if (!mount) continue;
      const e = this._spawnKind(mount.x, mount.y, 'wallTurret');
      e.awareness = DORMANT;
      e.baseId = edge.baseId;
      // `emplaced` — the flag #287 introduced for its (now-removed) interior bunker garrison, and
      // the wall gun's only remaining user. A wall gun is seated ON its own wall band, which
      // `_blocked` reports as impassable, so without this it
      // would be shoved off its parapet by enemies.js's "recover a ground unit stranded on
      // impassable terrain" snap-back (#115) on the very first frame.
      e.emplaced = true;
      // #310: the span this gun belongs to. The wall analogue of `dockKey` — it is how
      // `_killWallTurretsOn` finds the occupant when the span underneath it is breached, and it
      // is deliberately a SEPARATE field from `dockKey` so a wall-span key can never collide with
      // a hex key in any dock-keyed lookup.
      e.spanKey = edge.key;
      // #337 v3: a wall gun draws with its wall, above the fog overlay — the fog now covers the
      // ring of hexes the spans line and is fully opaque, so at its old LARGE_GROUND_UNITS tier it
      // would be blacked out from outside. See DEPTH.WALLS / `unitDepth` (shared.js).
      e.view?.setDepth?.(DEPTH.WALLS);
      e.detectRange = Math.min(e.detectRange, PROXIMITY_WAKE_RANGE_CAP);
    }
  },

  // #310: destroy every wall turret garrisoning `spanKey`. Hooked from world.js `_damageWallEdge`
  // the instant a span collapses, following #287's (removed) emplacement precedent exactly: a
  // breached span should not leave its gun hovering intact over the
  // gap. Blowing the span open is therefore a genuine SECOND way to kill the gun, alongside
  // shooting the gun itself, and the two are separate health pools (the span's 200, the unit's 35
  // structure + 15 armor) — destroy either and the emplacement is out of the fight.
  //
  // Routed through `_damageEnemyAt` rather than a bespoke teardown so the death FX, the powerup
  // drop roll and the win-condition bookkeeping all behave exactly as for a turret killed by
  // direct fire. Iterates a COPY of `this.enemies` because that kill path splices the array.
  _killWallTurretsOn(spanKey) {
    for (const e of [...(this.enemies ?? [])]) {
      if (e.spanKey !== spanKey || e.mech.isDestroyed()) continue;
      // `toughness` (structure + armor + shield) — NOT `hp`. This is #287's hard-won bug, and it
      // bites identically here because the Wall Lance carries the same #299 armor pool (15) over
      // its structure (35): `_damageEnemyAt` routes through `applyDamage`, which spends ARMOR
      // FIRST, so an `hp + 1` bite (35+1) would be fully absorbed and leave the gun alive and
      // firing on top of a span that no longer exists.
      this._damageEnemyAt(e, e.x, e.y, (e.mech.toughness ?? e.mech.maxHp) + 1, 0x5ac8e0);
    }
  },

  // #269 playtest follow-up (patrol units): a small, ALREADY-ACTIVE roaming presence stationed
  // near each alert tower — explicitly NOT part of the dormant/wake system above. The tower
  // itself remains the only thing that actually triggers a base's wake cascade; these units
  // never get a `baseId`/`dockKey` and are never touched by `_wakeBase`/`_allBasesCleared`, so
  // they can't accidentally gate the win condition or wake alongside a base. They spawn UNAWARE
  // (via `_spawnKind`'s own default — never forced to DORMANT) and fight the player through the
  // exact same UNAWARE→AWARE proximity/noise system every other regular enemy already uses.
  //
  // Reuses `_idleMoveIntent`'s existing "wander within IDLE_WANDER_RADIUS of spawnX/spawnY"
  // behavior for the patrol feel — no new patrol-route code needed — by simply setting each
  // unit's own spawn point to (a hex near) the tower's position. The alert tower hex itself is
  // `passable: false` (data/terrain.js), so units can't stand ON the tower's own hex; snapping
  // through `nearestValidPixel` (the same nearest-passable-hex primitive turret clusters/powerup
  // drops already use, data/spawnPlacement.js) finds the nearest passable ground hex next to it
  // instead. Called once from ArenaScene.create(), alongside `_spawnDormantUnits`.
  //
  // #269 playtest follow-up round 2 (`TOWER_PATROL_COUNT` 1 -> 5): a 5-unit patrol all spawning
  // on the exact same pixel would stack/overlap, so scatter them the same way `_spawnDormantUnits`
  // already huddles a multi-unit dock cluster around its shared centre — units placed evenly
  // around a circle of radius `TOWER_PATROL_HUDDLE_OFFSET`, same `Math.PI / 4` phase offset so
  // the pattern doesn't put a unit directly north (a purely cosmetic choice, matches the dock
  // loop's own phase). `_spawnKind` sets each unit's own `spawnX`/`spawnY` to wherever it's
  // actually placed, so `_idleMoveIntent`'s wander radius is centred on the SCATTERED point, not
  // the shared tower point — each patrol member wanders around its own huddle position, which
  // still reads as "loitering near the tower" as a group.
  //
  // #357: the huddle ring is now sized by the tier's OWN unit count rather than the flat
  // `TOWER_PATROL_COUNT`, so a late 11-strong patrol spreads around its circle just as evenly as
  // the 5-strong opener instead of overlapping. Spawning goes through `_spawnEnemy` (not
  // `_spawnKind` directly) because a late tier includes a light MECH ('raider'), and `_spawnEnemy`
  // is the existing `isEnemyKind` dispatcher that routes kind-vs-mech — the same one
  // `_spawnDormantUnits` above already relies on for mech docks. Everything else is unchanged:
  // patrol units still get NO `baseId`/`dockKey` and still spawn UNAWARE (both `_spawnKind` and
  // `_spawnMech`/`_resetAiState` default to UNAWARE), so they remain outside the base wake/win
  // bookkeeping exactly as before.
  _spawnTowerPatrols() {
    const towers = this.alertTowerHexes ?? [];
    towers.forEach((t, towerIndex) => {
      const { x: tx, y: ty } = hexToPixel(t.q, t.r);
      const { x, y } = nearestValidPixel(this.terrain, this.worldRadius, tx, ty);
      // #350: PATROLS scale with player count too — #357's tier list repeated once per player, so
      // the tier's MIX is preserved and co-op meets a bigger version of the same patrol rather
      // than a differently-shaped one. The huddle ring below already distributes an arbitrary `n`
      // evenly, so a doubled patrol needs no placement change.
      const composition = scaleComposition(
        towerPatrolComposition(towerIndex, towers.length), playersOf(this).length,
      );
      const n = composition.length;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.PI / 4;
        const px = n > 1 ? x + Math.cos(a) * TOWER_PATROL_HUDDLE_OFFSET : x;
        const py = n > 1 ? y + Math.sin(a) * TOWER_PATROL_HUDDLE_OFFSET : y;
        this._spawnEnemy(px, py, composition[i]);
      }
    });
  },

  // §5: one alert-tower countdown state per standing `alertTower` hex, keyed by hex key.
  // Called once from ArenaScene.create(), alongside `_spawnDormantUnits` above.
  _initAlertTowers() {
    this._alertTowerStates = new Map();
    // #284: each tower record from `placeGapTowers` (data/worldgen.js) already carries the
    // `baseId` of the base it's linked to (the base it sits in front of, gap-wise) — keep a
    // parallel key→baseId lookup so `_triggerAlert` can wake that exact base directly, with no
    // geometric re-derivation (`nearestBaseTo`, which could disagree with actual gap ownership
    // on a curving spine — see the issue for the failure case).
    this._alertTowerBaseId = new Map();
    for (const t of this.alertTowerHexes ?? []) {
      const key = axialKey(t.q, t.r);
      this._alertTowerStates.set(key, makeAlertState());
      this._alertTowerBaseId.set(key, t.baseId ?? null);
    }
    // §6: which bases have already been woken — a base wakes AT MOST once (waking an
    // already-awake base's units again is a harmless no-op, but tracking this avoids re-scanning
    // `this.enemies` for a base that has nothing left to wake).
    this._wokenBases = new Set();
    // #269 playtest follow-up: live escalating-ring FX + periodic warning-beep state, one entry
    // per tower key, created lazily the instant a countdown actually starts and torn down the
    // instant it completes / the tower dies — see `_updateAlertTowers` below. Never pre-populated
    // here (an idle tower has nothing to show yet).
    this._alertTowerFx = new Map();
    // #269 overhaul Part 1: keys of towers that took damage-but-survived since the last tick — a
    // one-frame activation signal set by `_onAlertTowerDamaged` (called from world.js
    // `_damageBuildingAt`) and consumed by the next `_updateAlertTowers`. Because the countdown is
    // sticky, a single frame in this set is enough to commit the tower forever; the entry is
    // cleared as soon as it's consumed (and when the tower's state is dropped on destruction).
    this._alertTowerDamaged = new Set();
    // #385: towers that have already SIGNALED (countdown completed, base woken) and are still
    // standing. key -> { x, y }. Populated the frame `tickAlertTower` reports `triggered`, dropped
    // when the tower is destroyed. These are the ones that pulse red continuously and are
    // candidates for the single nearest-tower siren. `_signaledFx` holds their per-tower pulse
    // rings (one per signaled-alive tower), created lazily and torn down on death.
    this._signaledTowers = new Map();
    this._signaledFx = new Map();
  },

  // #269 overhaul Part 1: a standing alert-tower hex just took damage (world.js `_damageBuildingAt`,
  // only called through here when the hex survived — a killing blow collapses it to rubble and the
  // per-tick `terrain.get(key) !== 'alertTower'` check drops the state instead). Flag it so the
  // next `_updateAlertTowers` tick treats this as an activation trigger — shooting a tower commits
  // it to calling reinforcements (unless you finish destroying it before the countdown completes).
  _onAlertTowerDamaged(key) {
    this._alertTowerDamaged?.add(key);
  },

  // §5: per-frame tick for every standing alert tower — called from ArenaScene.update(). A
  // destroyed tower (its hex has collapsed to rubble, `_damageBuildingAt`) is dropped from the
  // map the instant this notices, so an already-in-progress countdown can never complete after
  // the tower is gone; that's the whole "destroy it before the call completes" stealth window.
  _updateAlertTowers(dt) {
    // Two independent populations tick here: towers still SPOOLING UP (`_alertTowerStates`, the
    // escalating countdown FX) and towers that have already SIGNALED and stay live until destroyed
    // (`_signaledTowers`, the continuous red pulse + the single siren). Once every tower has
    // signaled the first map is empty but the second isn't — so the signaled pass must NOT sit
    // behind the spool-up map's early-out.
    if (this._alertTowerStates && this._alertTowerStates.size) this._updateSpoolingTowers(dt);
    this._updateSignaledTowers(dt);
  },

  // The countdown/spool-up pass: every tower still working toward triggering its base. Unchanged
  // #269 behaviour, split out of `_updateAlertTowers` so the signaled pass can run independently.
  _updateSpoolingTowers(dt) {
    // #269 overhaul Part 1: is there a "live" player gunshot this frame (within NOISE_WINDOW_MS)?
    // Computed once per frame here — same `_lastFireAt` recency test `_maybeProximityWake`/
    // enemies.js `_updateVehicle` use — then each tower checks its own distance to that shot below.
    const noiseLive = this._lastFireAt != null && this.time.now - this._lastFireAt < NOISE_WINDOW_MS;
    for (const [key, state] of [...this._alertTowerStates]) {
      if (this.terrain.get(key) !== 'alertTower') {
        this._alertTowerStates.delete(key);
        this._alertTowerBaseId?.delete(key);   // #284: no tower left to link, drop its baseId lookup too
        this._alertTowerDamaged?.delete(key);  // #269 overhaul: tower gone — drop any pending damage flag
        this._freeAlertFx(key);   // #269 playtest follow-up: tower destroyed mid-countdown — kill its FX too
        continue;
      }
      const [q, r] = key.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      // #269 overhaul Part 1: the tower activates on ANY of three triggers, not just proximity —
      //   (a) player within the (now larger, sticky) detection radius,
      //   (b) a recent player gunshot within NOISE_AGGRO_RANGE of the tower (heard it), or
      //   (c) the tower took damage this frame (flagged by `_onAlertTowerDamaged`).
      // Because the countdown is sticky (data/alertTower.js), any single true frame commits it.
      // #347: ANY player inside the radius trips the tower — a detector is not "watching for the
      // player", it is watching its own patch of ground. `_livePlayers()` is a one-element array
      // today, so this is the same single `Math.hypot` it always was.
      const inRange = livePlayersOf(this).some(
        (p) => Math.hypot(p.x - x, p.y - y) <= ALERT_DETECT_RADIUS);
      const heardShot = noiseLive && Math.hypot(this._lastFireX - x, this._lastFireY - y) <= NOISE_AGGRO_RANGE;
      const wasDamaged = this._alertTowerDamaged?.has(key) ?? false;
      if (wasDamaged) this._alertTowerDamaged.delete(key);   // one-frame signal — consume it now
      const activate = inRange || heardShot || wasDamaged;
      const next = tickAlertTower(state, { activate, dt });
      if (next.triggered) {
        this._alertTowerStates.delete(key);   // one-shot — nothing left to tick once it fires
        this._freeAlertFx(key);               // #269 playtest follow-up: countdown complete — swap FX for the real alert
        this._triggerAlert(this._alertTowerBaseId?.get(key));
        // #385: this tower has now SIGNALED — it keeps pulsing red + is a siren candidate until
        // destroyed. Record its position for the continuous-pulse + nearest-siren pass below.
        this._signaledTowers?.set(key, { x, y });
      } else {
        this._alertTowerStates.set(key, next);
        this._updateAlertFx(key, x, y, next, dt);
      }
    }
  },

  // #269 overhaul ("a pulsing red ring of some kind once it's activated") — per-frame pulsing red
  // ring + periodic warning beep for one tower's live countdown state. `next.countingDown` is the
  // sole authority on whether FX should exist right now: true the instant any activation trigger
  // starts the countdown, and — since the countdown is now STICKY (data/alertTower.js) — it stays
  // true for the whole activated duration until the tower fires or is destroyed (both of which
  // free the FX from `_updateAlertTowers` directly, not through here). So this method effectively
  // only ever runs with `countingDown === true`; the guard below is kept purely defensively.
  _updateAlertFx(key, x, y, next, dt) {
    if (!next.countingDown) { this._freeAlertFx(key); return; }
    let fx = this._alertTowerFx.get(key);
    if (!fx) {
      // A plain ring (no halo/outline like the objective marker — this needs to read as an
      // urgent, escalating PULSE at a glance, not a static findable-location marker) redrawn
      // every frame from the countdown's own fraction, not tweened — a tween has a fixed
      // duration/easing of its own, which would fight with "the countdown itself controls
      // exactly how far along this is" (and a tower whose countdown resets partway through a
      // tween would leave the tween instantly out of sync).
      // #280: hexagon outline (matching the real grid's pointy-top orientation via the same
      // `hexCorners` helper hexArt.js uses for terrain hexes) instead of a circle. #280 playtest
      // follow-up: drawn with `Graphics` + `strokeHexRing` (shared.js), not a `Polygon` shape —
      // `Polygon`'s display-origin math renders an already-centered point set (what `hexCorners`
      // returns) offset up-left by its own radius, at ANY radius including after a `setTo` resize
      // (see `strokeHexRing`'s comment for the full mechanism). This ring is resized live every
      // tick as the countdown's `fraction` climbs — `Graphics` has no notion of "resize", so it's
      // simply cleared and re-stroked from scratch each tick via `strokeHexRing`, at the ring's
      // fixed world position `(x, y)` set once here via `setPosition`.
      const ring = this.add.graphics().setPosition(x, y).setDepth(DEPTH.WORLD_UI);
      strokeHexRing(ring, ALERT_RING_RADIUS_MIN, 3, ALERT_RING_COLOR, ALERT_RING_ALPHA_MIN);
      fx = { ring, pulseTimerMs: 0, throbMs: 0 };
      this._alertTowerFx.set(key, fx);
    }
    const f = next.fraction ?? 0;
    // #269 overhaul: a throbbing PULSE layered on top of the countdown-fraction escalation. An
    // accumulated timer (framerate-independent, unlike keying off `this.time.now` which some test
    // harnesses don't advance) drives a sine so the ring visibly beats — radius and alpha swing
    // +/- around their escalated baseline on a fixed ~640ms cadence, reading as an urgent recurring
    // alarm rather than a smoothly-growing ring. Baseline still climbs with `f`, so a near-complete
    // countdown throbs around a larger, brighter ring than a just-started one.
    fx.throbMs += Math.max(0, dt) * 1000;
    const throb = Math.sin((fx.throbMs / ALERT_RING_PULSE_PERIOD_MS) * Math.PI * 2);   // -1..1
    const baseRadius = ALERT_RING_RADIUS_MIN + (ALERT_RING_RADIUS_MAX - ALERT_RING_RADIUS_MIN) * f;
    const baseAlpha = ALERT_RING_ALPHA_MIN + (ALERT_RING_ALPHA_MAX - ALERT_RING_ALPHA_MIN) * f;
    strokeHexRing(
      fx.ring,
      Math.max(1, baseRadius + ALERT_RING_PULSE_RADIUS * throb),
      3,
      ALERT_RING_COLOR,
      Math.max(0, Math.min(1, baseAlpha + ALERT_RING_PULSE_ALPHA * throb)),
    );
    // Periodic warning beep, re-triggered on an interval that shrinks as `f` climbs (see
    // ALERT_PULSE_INTERVAL_MIN/MAX_MS above) — a simple countdown timer accumulated in ms,
    // fired the frame it reaches zero and reset to the (now-shorter) interval for `f`.
    fx.pulseTimerMs -= Math.max(0, dt) * 1000;
    if (fx.pulseTimerMs <= 0) {
      Audio.alertPulse(f, { x, y, ...listenerOf(this) });
      fx.pulseTimerMs = ALERT_PULSE_INTERVAL_MAX_MS - (ALERT_PULSE_INTERVAL_MAX_MS - ALERT_PULSE_INTERVAL_MIN_MS) * f;
    }
  },

  // Tear down one tower's live FX immediately — the countdown ended, which (post-#269-overhaul,
  // now that there's no cancel-on-leave path) means only one of two things: the tower was
  // DESTROYED mid-countdown, or the countdown COMPLETED and the alert fired. No held/looping
  // sound to explicitly stop (alertPulse
  // is a one-shot cue re-triggered by `_updateAlertFx`'s own timer above, not a sustained node —
  // simply no longer being called IS it stopping cleanly); the only live object is the ring,
  // destroyed here rather than left for scene shutdown to sweep up.
  _freeAlertFx(key) {
    const fx = this._alertTowerFx.get(key);
    if (!fx) return;
    fx.ring.destroy();
    this._alertTowerFx.delete(key);
  },

  // #385: per-frame pass over towers that have SIGNALED and are still standing. Each one pulses
  // red continuously (per-tower, visual doesn't fatigue); a destroyed tower is dropped here (its
  // hex has collapsed to rubble) and goes silent + unlit. Then, across the survivors, drive
  // EXACTLY ONE siren voice from the nearest signaled-alive tower to the audio listener — a
  // destroyed nearest tower simply drops out of `alive`, so `pickSirenSource` reassigns the voice
  // to the next nearest, or stops it when none remain.
  _updateSignaledTowers(dt) {
    const alive = [];
    if (this._signaledTowers) {
      for (const [key, pos] of [...this._signaledTowers]) {
        if (this.terrain.get(key) !== 'alertTower') {
          this._signaledTowers.delete(key);   // destroyed — neither pulses nor sirens
          this._freeSignaledPulse(key);
          continue;
        }
        this._updateSignaledPulse(key, pos.x, pos.y, dt);
        alive.push(pos);
      }
    }
    // Exactly one siren voice: the nearest signaled-alive tower to the LOCAL player (the audio
    // listener — `listenerOf`, still the co-op audio seam post-#364). None left -> stop it.
    const { listenerX, listenerY } = listenerOf(this);
    const src = pickSirenSource(alive, listenerX, listenerY);
    if (src) Audio.updateSiren({ x: src.x, y: src.y, listenerX, listenerY });
    else Audio.stopSiren(1.1);   // #385: the last signaled tower fell — trail the wail off, don't snap it silent
    // (~1.1s: the fade is an EXPONENTIAL ramp to near-silence, which front-loads its attenuation —
    //  0.6s of scheduled ramp was only ~0.2-0.3s of AUDIBLE fade and still read as a click-off.)
  },

  // #385: the continuous red pulse for ONE signaled-alive tower — a steady hexring that beats on a
  // fixed cadence (the countdown is over; this is a persistent "live" marker, not the escalating
  // spool-up ring). Same `Graphics` + `strokeHexRing` redraw-each-tick approach as `_updateAlertFx`
  // (see its comment for why it's re-stroked rather than tweened), just without the fraction-driven
  // escalation. Created lazily the first frame this tower is seen signaled-alive.
  _updateSignaledPulse(key, x, y, dt) {
    let fx = this._signaledFx.get(key);
    if (!fx) {
      const ring = this.add.graphics().setPosition(x, y).setDepth(DEPTH.WORLD_UI);
      strokeHexRing(ring, SIGNALED_RING_RADIUS, 3, ALERT_RING_COLOR, SIGNALED_RING_ALPHA);
      fx = { ring, throbMs: 0 };
      this._signaledFx.set(key, fx);
    }
    fx.throbMs += Math.max(0, dt) * 1000;
    const throb = Math.sin((fx.throbMs / SIGNALED_RING_PULSE_PERIOD_MS) * Math.PI * 2);   // -1..1
    strokeHexRing(
      fx.ring,
      Math.max(1, SIGNALED_RING_RADIUS + SIGNALED_RING_PULSE_RADIUS * throb),
      3,
      ALERT_RING_COLOR,
      Math.max(0, Math.min(1, SIGNALED_RING_ALPHA + SIGNALED_RING_PULSE_ALPHA * throb)),
    );
  },

  // #385: tear down one signaled tower's continuous pulse ring (tower destroyed).
  _freeSignaledPulse(key) {
    const fx = this._signaledFx?.get(key);
    if (!fx) return;
    fx.ring.destroy();
    this._signaledFx.delete(key);
  },

  // §6: the countdown completed — wake the ONE base this tower is linked to. #284: `baseId` is
  // the tower's own gap-ownership relationship, threaded through from `placeGapTowers` (data/
  // worldgen.js) via `this.alertTowerHexes` → `_alertTowerBaseId` — no geometric re-derivation
  // (the old `nearestBaseTo`, pure straight-line distance) involved, so a curving corridor can
  // never misroute a tower's wake to the wrong base.
  _triggerAlert(baseId) {
    if (baseId != null) this._wakeBase(baseId);
  },

  // #269 playtest follow-up ("enemies should also wake on player proximity, independent of
  // alert towers"): a DORMANT unit's own `detectRange` (set at spawn time in `_spawnKind`,
  // exactly the same `detectionRangeFor(def.fireRange)` an UNAWARE unit uses for its own
  // proximity/noise aggro) doubles as its "someone got close enough to notice me" radius here —
  // reusing `shouldBecomeAware` (data/awareness.js) rather than a new bespoke proximity check,
  // since the underlying concept ("player got close enough, I noticed") is identical to the
  // UNAWARE→AWARE case; only the RESPONSE differs. Passing `e.awareness` (DORMANT, not AWARE)
  // straight through is safe — `shouldBecomeAware` only special-cases the AWARE state, so a
  // DORMANT unit falls through to the same distance/noise-based `seen`/`heard` check any
  // UNAWARE non-mech unit gets (see `_updateVehicle`'s call site — no LOS raycast, distance-only,
  // deliberately cheap since docks can spawn many units). Unlike an UNAWARE unit's own solo
  // wake, this wakes the unit's WHOLE base together via `_wakeBase` — same as an alert tower's
  // countdown completing — since the base-population design already treats "wake" as a
  // per-base group event, not a per-unit one. A no-op once the base is already woken (checked
  // inside `_wakeBase`), so this stays a cheap `Math.hypot` for every already-irrelevant tick.
  _maybeProximityWake(e) {
    if (e.baseId == null) return;
    // #347: distance to the NEAREST player — whoever walked up is who wakes it.
    const tp = targetPlayerFor(this, e);
    const dist = Math.hypot(tp.x - e.x, tp.y - e.y);
    // #269: also wake on nearby gunfire noise, not just physical proximity — a player shooting
    // up a base's front units should stir the rest, even before walking into them. Same
    // `noiseDist` computation the UNAWARE path uses (enemies.js `_updateVehicle`): distance from
    // the most recent still-"live" player gunshot (within NOISE_WINDOW_MS), or null if no shot is
    // currently live. `shouldBecomeAware` compares it against NOISE_AGGRO_RANGE internally. The
    // existing `dist`/`detectRange` proximity check (capped at PROXIMITY_WAKE_RANGE_CAP upstream)
    // is unchanged — this ADDS the noise trigger.
    const noiseLive = this._lastFireAt != null && this.time.now - this._lastFireAt < NOISE_WINDOW_MS;
    const noiseDist = noiseLive ? Math.hypot(this._lastFireX - e.x, this._lastFireY - e.y) : null;
    if (shouldBecomeAware(e.awareness, { dist, detectRange: e.detectRange, noiseDist })) this._wakeBase(e.baseId);
  },

  // §6/§7: wake every still-dormant unit belonging to `baseId`. Idempotent — waking an
  // already-woken base is a no-op. §7 wake-response split: a fast/mobile kind (data/bases.js
  // `isFastWakeKind`, keyed off the kind's own `move.maxSpeed`) needs no special handling at
  // all — every non-mech behavior fn (enemyBehaviors.js) already computes its movement relative
  // to the player's LIVE position each frame once aware, so it starts sortieing the instant it
  // wakes. A slow/defensive kind gets `e.holdGround = true` instead.
  //
  // #285 ("units should fully commit to attacking the player, not stay tethered near their
  // dock"): `e.holdGround` used to also mean "leash movement to a radius around home" — that
  // leash is gone (see scenes/arena/shared.js's removed `leashIntent`/`HOLD_GROUND_LEASH_PX`).
  // The flag now means only what its name says: this is a defensive/stationary-posture unit that
  // fights from wherever it ends up rather than closing distance the way a fast kind does — it no
  // longer constrains WHERE that fighting can happen. Its one remaining functional effect is
  // cosmetic/tactical polish, not movement-limiting: enemies.js `_updateEnemy` reads it to decide
  // that a hold-ground mech which happens to be momentarily stationary should face the player
  // rather than hold its last travel heading (tank/carrier/infantry already got the same
  // "don't read as dead while stopped" fix directly in their own behavior fns). tank/carrier/
  // infantry's OWN behavior fns (enemyBehaviors.js) no longer read `e.holdGround` at all now that
  // the leash is gone — it's still set on them (kept for the flag's documented "which units are
  // hold-ground" semantics, and in case a future feature wants it) but has no code path consuming
  // it for those kinds any more.
  //
  // #269 playtest follow-up ("fold mechs into the dock system"): a docked MECH (e.kind ===
  // 'mech') has no `kindDef` at all (that field only exists on non-mech kinds — see `_spawnKind`)
  // so `isFastWakeKind` was never reachable for one, and its own chassis-based movement stats
  // (data/chassis/*) aren't even the same shape `isFastWakeKind`'s `move.maxSpeed` check expects.
  // Rather than derive an equivalent "effective speed" from chassis weight class and feed it
  // through the same threshold (light 268px/s and even heavy 135px/s both clear
  // FAST_WAKE_SPEED_THRESHOLD=100 — that comparison would call EVERY mech "fast" regardless of
  // chassis, which reads wrong), every mech defaults to `holdGround = true` unconditionally: a
  // mech is the toughest, most dangerous thing the dock system can field, so it reads better as
  // "the boss that holds the objective and makes you come to it" than "the thing that rushes
  // you across the map." The mech tactical AI (enemies.js `_updateEnemy`) runs the exact same
  // PRESS/KITE/FLANK/COVER/HOLD decision machine either way now (it no longer short-circuits on
  // this flag) — every archetype fully engages, `holdGround` just tips the stationary-vs-facing
  // polish above.
  //
  // #285 stagger: each newly-woken unit also gets a short randomized `e.reactDelayMs` — see
  // enemies.js `_isReacting` for how it's consumed, and the constants below for the exact range
  // and reasoning. `e.awareness` itself still flips synchronously for every qualifying unit in
  // this same loop (so "is this base awake" stays an instant, all-at-once fact other systems —
  // the win condition, HUD, tests — can rely on); only the unit's actual movement/turret-
  // tracking/firing is what gets staggered.
  _wakeBase(baseId) {
    if (this._wokenBases.has(baseId)) return;
    this._wokenBases.add(baseId);
    for (const e of this.enemies) {
      if (e.baseId !== baseId || e.awareness !== DORMANT) continue;
      e.awareness = AWARE;
      if (e.kind === 'mech' || (e.kindDef && !isFastWakeKind(e.kindDef))) e.holdGround = true;
      // #416: a woken Broodhauler ADVANCES on the player instead of camping the base. Its whole
      // threat is the drone nest it carries, so leaving it parked at its dock lets a stack of drones
      // pile up and reach the player long before the carrier does. Flagging it here (base alerted =
      // "activation", exactly the issue's trigger — reached by both the alert-tower wake and the
      // walk-up proximity wake) makes carrierMoveIntent (enemyBehaviors.js) close to a much tighter
      // standoff, driving the drone production INTO the fight rather than holding back at its normal
      // 320px camp. Scoped to the carrier kind; every other kind's wake response is unchanged.
      if (e.behavior === 'carrier') e.advanceOnAlert = true;
      e.reactDelayMs = WAKE_REACT_STAGGER_MIN_MS
        + Math.random() * (WAKE_REACT_STAGGER_MAX_MS - WAKE_REACT_STAGGER_MIN_MS);
    }
  },

  // #269 §3 "rare multi-spawn exception" (playtest follow-up) — per-frame tick for every dock's
  // resupply cooldown, called from ArenaScene.update() alongside `_updateAlertTowers`. `awake`
  // and `cleared` are tracked as two SEPARATE signals, not combined into one gate: `awake`
  // (`this._wokenBases` — §2 of the mechanic: a still-fully-dormant base's docks must not be
  // quietly counting down before the player has even discovered it) gates whether the cooldown
  // TICKS at all, while `cleared` (no live enemy — original assignment or an earlier resupply —
  // still carries its `dockKey`; #87's "a killed enemy is pruned from `this.enemies` the same
  // tick it dies" convention, already relied on by `_allBasesCleared` above, makes that a plain
  // `.some()` scan) only gates whether a fully-elapsed cooldown can actually FIRE — you can't
  // spawn a fresh unit into a hex that's still occupied. #269 playtest follow-up: the cooldown's
  // PROGRESS must start as soon as the dock's unit is spawned (base awake), not wait for that
  // unit to actually leave/die — `tickDockResupply` (data/dockResupply.js) is the pure state
  // machine encoding that split; this is just the glue feeding it real per-frame `awake`/
  // `cleared` and reacting to `ready: true`.
  _updateDockResupply(dt) {
    if (!this._dockResupplyStates || !this._dockResupplyStates.size) return;
    for (const [dockKey, meta] of this._dockResupplyMeta) {
      const state = this._dockResupplyStates.get(dockKey);
      if (!state) continue;
      const awake = this._wokenBases.has(meta.baseId);
      const cleared = !this.enemies.some((e) => e.dockKey === dockKey);
      const next = tickDockResupply(state, { awake, cleared, dt });
      this._dockResupplyStates.set(dockKey, next);
      // #326: no budget check and no swarm-eligibility argument any more — an un-retired dock
      // simply resupplies, every cycle, with whatever kind its base's pool draws.
      if (next.ready) this._resupplyDock(dockKey, meta);
    }
  },

  // #269 Part 2 ("dock open/closed states") — per-frame tick, called from ArenaScene.update()
  // alongside `_updateDockResupply`, that detects a dock hex being VACATED (its own live units,
  // matched by `dockKey`, have all either walked far enough away or died) and closes it. Only
  // ever acts on a hex that's CURRENTLY the plain open `dock` terrain — a hex that's already
  // `dockClosed` (or has since collapsed to rubble via `_damageBuildingAt`) is skipped, so this
  // never fights the resupply cycle's own closed→open transition (`_resupplyDock`/`_openDock`
  // below) or re-close an already-destroyed dock. Cheap: `this._dockResupplyMeta` only ever holds
  // DOCK hexes (see that map's own header comment in `_spawnDormantUnits`), and this game has at most a handful of docks, so a plain per-dock
  // `.some()` scan (same cost shape as `_updateDockResupply`/`_maybeProximityWake`) is fine.
  _updateDockOpenClose() {
    if (!this._dockResupplyMeta || !this._dockResupplyMeta.size) return;
    for (const [dockKey, meta] of this._dockResupplyMeta) {
      if (this.terrain.get(dockKey) !== 'dock') continue;   // already closed, or destroyed
      const occupied = this.enemies.some((e) => e.dockKey === dockKey
        && Math.hypot(e.x - meta.x, e.y - meta.y) <= DOCK_VACATE_RADIUS_PX);
      if (!occupied) this._closeDock(dockKey, meta);
    }
  },

  // Swap a vacated dock hex from open `dock` to the sealed, destructible `dockClosed` terrain —
  // the exact same `this.terrain.set` + `tileImages.get(k).setTexture` mechanism `_damageBuildingAt`
  // (world.js) already uses to swap a collapsed outpost to rubble in place, just going the other
  // direction (open → a NEW standing structure, not standing → rubble). Also seeds `this.buildingHp`
  // for this hex so it immediately starts participating in the generic destructible-terrain system
  // — `_damageBuildingAt` can now damage/collapse it exactly like any world-gen-seeded outpost, and
  // `_onTerrainCollapsed` below is how a collapse gets routed back to retiring this dock's resupply.
  _closeDock(dockKey, meta) {
    this.terrain.set(dockKey, 'dockClosed');
    const img = this.tileImages.get(dockKey);
    // #395: both dock states share the same black-bay tile — the swap keeps the terrain system's
    // texture bookkeeping honest, but the visible change is the doors sliding shut below.
    if (img) img.setTexture(getTerrain('dockClosed').tex);
    this.buildingHp.set(dockKey, terrainBuildingHp('dockClosed'));
    // #395: a quiet mechanical thud (the same soft cue the old dome-seal used) as the two door
    // leaves slide SHUT over the black bay — heavy, slow, driven by `_animateDock` below.
    Audio.explosion(0.25, { x: meta.x, y: meta.y, ...listenerOf(this) });
    this._animateDock(dockKey, meta.x, meta.y, false);
  },

  // The inverse of `_closeDock` — swap a still-intact closed dock back to the open `dock`
  // terrain and drop it out of `buildingHp` (an open dock, like the original design, carries no
  // HP of its own — see terrain.js `dock`'s comment). Called from `_resupplyDock` below, right
  // as the resupply elevator sequence starts, so the "doors open / platform rises" FX already
  // built there doubles as the dome's own reopening beat — no separate reopen animation needed.
  _openDock(dockKey) {
    this.terrain.set(dockKey, 'dock');
    const img = this.tileImages.get(dockKey);
    if (img) img.setTexture(getTerrain('dock').tex);   // both dock states share the black-bay tile (#395)
    this.buildingHp.delete(dockKey);
    // #395: slide the two door leaves APART to reveal the black bay. Position comes from the dock's
    // resupply meta (its sole caller, `_resupplyDock`, already keys off it). A dock that never
    // actually closed has no door sprites, so `_animateDock` is a harmless no-op.
    const meta = this._dockResupplyMeta?.get(dockKey);
    if (meta) this._animateDock(dockKey, meta.x, meta.y, true);
  },

  // #395: a dock hex owns a pair of sliding door-leaf sprites (`hex_dockDoorL`/`hex_dockDoorR`)
  // over its black bay. Created LAZILY on the first close — docks start OPEN (doors would be hidden)
  // so most docks never build a pair until they're first vacated — and reused thereafter, kept in
  // `this._dockDoors` keyed by dockKey. Placed at DEPTH.DOCK_DOORS (just above the terrain tile,
  // below every unit) at the same 1/ART_SCALE scale the tile images use, so they register exactly
  // over the bay.
  _dockDoorPair(dockKey, x, y) {
    if (!this._dockDoors) this._dockDoors = new Map();
    let pair = this._dockDoors.get(dockKey);
    if (!pair) {
      // Start the leaves in the fully-PARTED position, hidden — a dock is OPEN before it first
      // closes, so this is the correct resting state, and it means the first close is a real
      // slide-shut (parted → meeting) rather than a snap into place.
      const mk = (tex, px) => this.add.image(px, y, tex).setOrigin(0.5).setScale(1 / ART_SCALE)
        .setDepth(DEPTH.DOCK_DOORS).setVisible(false);
      pair = {
        l: mk(DOCK_DOOR_TEX.L, x - DOCK_DOOR_SLIDE), r: mk(DOCK_DOOR_TEX.R, x + DOCK_DOOR_SLIDE),
        tweenL: null, tweenR: null,
      };
      this._dockDoors.set(dockKey, pair);
    }
    return pair;
  },

  // #395: drive the two door leaves. `opening` slides them APART (revealing the bay, then hides
  // them at rest); `!opening` slides them back TOGETHER over the bay. Slow, heavy easing so it
  // reads as a mechanical bulkhead parting rather than a texture snap. `x` is the hex centre; each
  // leaf's texture already paints only its own half, so a leaf at the hex centre covers its half
  // and slides out by DOCK_DOOR_SLIDE to fully clear it.
  _animateDock(dockKey, x, y, opening) {
    const pair = this._dockDoorPair(dockKey, x, y);
    pair.tweenL?.stop?.();
    pair.tweenR?.stop?.();
    pair.l.setVisible(true);
    pair.r.setVisible(true);
    // #395: a heavier, slower part so the two leaves visibly slide apart to reveal the black bay
    // (owner wasn't reading the motion at 750ms) — long enough to see clear travel, still snappy.
    const dur = 950, ease = 'Sine.easeInOut';
    pair.tweenL = this.tweens.add({ targets: pair.l, x: opening ? x - DOCK_DOOR_SLIDE : x, duration: dur, ease });
    pair.tweenR = this.tweens.add({
      targets: pair.r, x: opening ? x + DOCK_DOOR_SLIDE : x, duration: dur, ease,
      onComplete: () => {
        // Fully-open at rest is just the black bay: hide the parted leaves so they never linger
        // spilled onto neighbouring hexes while the dock stays open.
        if (opening) { pair.l.setVisible(false); pair.r.setVisible(false); }
      },
    });
  },

  // #395: destroy a dock's door sprites — called when its bay collapses to rubble
  // (`_onTerrainCollapsed`), so a blown-open dock doesn't keep phantom doors floating over the wreck.
  _destroyDockDoors(dockKey) {
    const pair = this._dockDoors?.get(dockKey);
    if (!pair) return;
    pair.tweenL?.stop?.();
    pair.tweenR?.stop?.();
    pair.l.destroy();
    pair.r.destroy();
    this._dockDoors.delete(dockKey);
  },

  // #269 Part 2: hooked from world.js `_damageBuildingAt` (`_onTerrainCollapsed`) — fires for
  // EVERY destructible-hex collapse, not just docks, so this is a no-op unless `hexKey` is a
  // dock this scene is actually tracking resupply state for. Permanently retires that dock's
  // resupply (`spendDockResupply`, data/dockResupply.js) the instant its closed dome is
  // destroyed — a real tactical payoff for blowing it open before it can produce reinforcements,
  // even if it hadn't used its one resupply yet.
  _onTerrainCollapsed(hexKey) {
    const state = this._dockResupplyStates?.get(hexKey);
    if (state) this._dockResupplyStates.set(hexKey, spendDockResupply(state));
    // #395: a dock blown open collapses to rubble — drop its door sprites so they don't float over
    // the wreck.
    this._destroyDockDoors(hexKey);
    this._maybeDropObjectiveReward(hexKey);
  },

  // #315: the ARMOR PATCH is no longer a random drop — it is the GUARANTEED reward for
  // destroying a base's objective hex, exactly one per objective, no roll. Keyed off the same
  // `_onTerrainCollapsed` signal #269 already uses for objective completion, so "the objective
  // is destroyed" and "the reward exists" are literally the same event and can't drift apart.
  // A no-op for every other destructible hex. `_objectiveRewardsDropped` guards against a
  // double award if the collapse hook ever fired twice for one hex, and makes the "exactly one"
  // property directly testable.
  _maybeDropObjectiveReward(hexKey) {
    const base = (this.bases ?? []).find((b) => b.objectiveHex
      && axialKey(b.objectiveHex.q, b.objectiveHex.r) === hexKey);
    if (!base) return null;
    if (!this._objectiveRewardsDropped) this._objectiveRewardsDropped = new Set();
    if (this._objectiveRewardsDropped.has(hexKey)) return null;
    this._objectiveRewardsDropped.add(hexKey);
    const { x, y } = hexToPixel(base.objectiveHex.q, base.objectiveHex.r);
    // `spawnPowerup` (scenes/arena/powerups.js) already relocates a drop to the nearest
    // REACHABLE ground, which matters here: the objective hex has just become rubble but a
    // sealed base ring can leave its immediate surroundings walled.
    return this.spawnPowerup?.(x, y, 'armorPatch') ?? null;
  },

  // Plays the doors-open → platform-rise → doors-close FX at a cleared dock's position, and
  // spawns the fresh unit mid-sequence (roughly when it would first be visible rising out of the
  // bay). All Phaser tweens on a temporary container (mirrors world.js `_outpostCollapseFx`'s
  // "build throwaway display objects, tween them, destroy on completion" style — nothing here is
  // baked into the static hex art, which stays untouched). The spawned unit goes DIRECTLY active
  // (AWARE, no `holdGround`/wake-response split needed — its base is already awake and fighting,
  // matched to the mechanic's design intent that a resupply unit doesn't sit inert like an
  // original dormant one) and is scattered like a fresh dock spawn.
  //
  // #269 playtest follow-up ("fold mechs into the dock system"): `meta.kindId` mirrors
  // `_spawnDormantUnits`'s own branch — a mech-kind dock resupplies through `_spawnMech`, every
  // other kind through `_spawnKind`, both via the same `isEnemyKind` predicate.
  // #323 (Jackson: "a dock should not be locked into its original type; it should pull from that
  // base difficulty's pool at the correct ratios"): the kind is RE-DRAWN here on every resupply,
  // through worldgen.js's `drawDockKind` — the same weighted draw `placeBases` uses, against this
  // base's own `lateFraction` (recorded in `meta` at spawn time), so the reinforcement mix matches
  // the base's difficulty rather than being frozen to whatever the dock opened with. Nothing
  // visual is tied to the original kind: the hex terrain and the elevator FX below are generic
  // `dock`/`dockClosed`, and placement/cluster/flyer handling all follow from the DRAWN kind
  // because `spawnDockCluster` re-derives everything from it.
  //
  // #326 removed both of the density guards that used to ride along here — #314's
  // one-swarm-per-base cap and #323's first-resupply-only swarm restriction. Jackson: "drop it —
  // let bases have several". A dock's redraw is now the bare pool draw, so any dock can come back
  // as any kind its base fields, including a swarm, on any cycle. What keeps that from compounding
  // is the `cleared` gate in `tickDockResupply`: a dock that just sent 10 drones cannot send
  // anything else until those 10 are gone, so a base's live population is bounded by its docks'
  // current waves rather than growing with fight length.
  _resupplyDock(dockKey, meta) {
    const { x, y } = meta;
    const rng = this._dockRng ?? Math.random;
    const kindId = drawDockKind(rng, meta.lateFraction ?? 0);
    meta.kindId = kindId;
    // #323 (the original bug): resupply used to make a single bare `_spawnKind` call, so a swarm
    // dock trickled back one body at a time instead of the burst it opened with. The count comes
    // from the same `dockCountFor` the initial spawn uses, so a resupplied swarm arrives at full
    // strength. (#326: nothing is billed for it any more — there is no budget to bill against.)
    // #350: a resupply WAVE is the same population as the opening garrison, so it takes the same
    // player-count scaling — otherwise co-op would face a doubled base that reinforces at solo
    // strength and thins out over the fight. Note this scales wave SIZE only; the resupply
    // CADENCE (`DOCK_RESUPPLY_COOLDOWN_MS`) is untouched, because "faster dock reinforcement" is
    // the lever Jackson explicitly rejected. Read live, so a mid-sortie START join is picked up
    // by every wave from that moment on.
    // #389: a MECH resupply wave is pinned to ONE mech regardless of player count — see
    // `scaleDockWave`. The rejected two-mechs-at-once spawn the owner saw was this call doubling a
    // lone mech at two players; the resupply CADENCE stays the co-op lever, not wave size.
    const count = scaleDockWave(kindId, dockCountFor(kindId, rng), playersOf(this).length);
    // #269 Part 2 ("dock open/closed states"): a dock that's currently CLOSED (the normal case —
    // its original unit(s) walked off/died and `_updateDockOpenClose` already sealed it, see
    // above) reopens right here, at the same moment this elevator sequence kicks off — the
    // doors-open/platform-rise FX below already IS the "dome reopening" beat the issue asks for,
    // so no separate reopen animation is needed. If the dock never actually closed (e.g. its
    // original unit died right on the pad before ever moving — see `_updateDockOpenClose`'s own
    // comment), this is a harmless no-op: the hex is already the open `dock` terrain.
    // #395: the doors are the real sliding sprites now — `_openDock` parts them (heavy, ~750ms)
    // to reveal the black bay. No throwaway door leaves or shaft are drawn here any more; the bay
    // tile IS the dark gap. A dock that never actually closed has no doors, and this is a no-op.
    if (this.terrain.get(dockKey) === 'dockClosed') this._openDock(dockKey);
    const riseFrom = 22;

    // The unit rises out of the now-open bay: a lit platform surfaces from below the deck, and the
    // unit is spawned as it crests — directly ACTIVE (no dormant/wake step, the base is fighting).
    const platform = this.add.rectangle(x, y + riseFrom, 24, 6, 0x565d66, 1).setDepth(DEPTH.DOCK_FX + 0.2);
    const glow = this.add.circle(x, y + riseFrom, 4, 0xd8cba0, 0.9).setDepth(DEPTH.DOCK_FX + 0.3);
    const destroyFx = () => { platform.destroy(); glow.destroy(); };

    // Let the doors part first (now ~950ms, #395), THEN rise the platform through the open bay, so
    // nothing occludes the leaves sliding apart — the parting reads clean before anything emerges.
    this.time.delayedCall(600, () => {
      this.tweens.add({ targets: [platform, glow], y: `-=${riseFrom}`, duration: 450, ease: 'Sine.easeOut' });
    });
    this.time.delayedCall(960, () => {
      // #323: the SAME shared placement seam the initial dormant spawn uses — cluster rings,
      // terrain snapping and mech/kind dispatch all come from there, so a swarm resupply arrives
      // as a properly-seated burst. AWARE, not DORMANT: the base is already fighting.
      spawnDockCluster(this, { x, y, kindId, count, baseId: meta.baseId, dockKey, awareness: AWARE });
    });
    // Once surfaced, fade the platform FX out. The bay stays OPEN (doors parted) while the unit(s)
    // occupy the hex; `_updateDockOpenClose` slides the doors shut once they vacate.
    this.time.delayedCall(1260, () => {
      this.tweens.add({ targets: [platform, glow], alpha: 0, duration: 220, onComplete: destroyFx });
    });
  },

  // #269 §8: "every base's docked units (dormant or awakened, doesn't matter) are destroyed" —
  // kept as its own distinct concept (still exercised directly by dormantWake.test.js) even
  // though it's no longer what decides the run's win/lose. Dead enemies are pruned out of
  // `this.enemies` the same tick they die (#87 `_removeEnemy`), so "no enemy left with a baseId"
  // is already the exact right check for THIS concept — no separate per-base HP bookkeeping
  // needed. False if there are no bases at all (nothing to clear yet — guards a pre-`_buildWorld`
  // call).
  _allBasesCleared() {
    if (!this.bases || !this.bases.length) return false;
    return !this.enemies.some((e) => e.baseId != null);
  },

  // #269 playtest follow-up ("objectives aren't clearing until I kill all units at the base"):
  // the run's REAL win condition, consistent with the per-base mission check in mission.js
  // `_updateMission` — every base's own objective hex (or, for the rare base with no real
  // objective hex, its enemy-count fallback) must be destroyed, not just "every enemy
  // everywhere is dead". Reuses `isBaseObjectiveDestroyed` so both checks agree on the exact
  // same rule. False if there are no bases at all (nothing to clear yet — guards a
  // pre-`_buildWorld` call), same as `_allBasesCleared` above.
  _allObjectivesDestroyed() {
    if (!this.bases || !this.bases.length) return false;
    return this.bases.every((base) => isBaseObjectiveDestroyed(base, this.buildingHp, this.enemies));
  },

  // #356: THE run win condition now — every base FULLY cleared (its objective destroyed, then
  // every dock destroyed, then every remaining enemy of that base dead), not merely every
  // objective hex destroyed. Because the objective advances base-by-base only on a full clear,
  // by the time the player is at the last base every earlier one is already satisfied, so in
  // practice this is "finish the last base properly" — which is exactly the ask: the run does not
  // complete while enemies remain alive at the final objective.
  // `_allObjectivesDestroyed` is kept as the distinct, weaker concept it always was (it is what
  // #355's gates latch on, per base).
  _allBasesFullyCleared() {
    if (!this.bases || !this.bases.length) return false;
    return this.bases.every((base) => isBaseFullyCleared(base, this.buildingHp, this.enemies));
  },

  // #355: the set of base ids whose objective hex is destroyed — "this base is beaten", which is
  // the sole trigger for its gates latching open. Deliberately the OBJECTIVE alone, not "the base
  // is cleared": docks and garrison may still be alive and shooting, and the gates fail open
  // anyway. (Owner, confirmed: the objective hex being destroyed, ALONE.) A base with no real
  // objective hex — worldgen's safe-zone re-validation can clear one back to open ground — falls
  // through `isBaseObjectiveDestroyed` to its cleared-of-enemies fallback, which keeps this
  // consistent with the mission/win checks for that rare case rather than leaving such a base's
  // gates cycling forever.
  _failedOpenBases() {
    const set = new Set();
    for (const base of this.bases ?? []) {
      if (isBaseObjectiveDestroyed(base, this.buildingHp, this.enemies)) set.add(base.id);
    }
    return set;
  },

  // ── #309: WALL GATES / the sally port ───────────────────────────────────────────────────
  // Build one cycle state per gate span. Called from `_buildWorld` (world.js) once the wall-edge
  // set exists. A ring's gates each get a slightly different starting offset so they don't crank
  // in perfect lockstep — the same de-synchronisation reasoning #311 applied to docks, and it
  // matters more here: gates opening on the same frame read as one scripted event, while gates
  // opening a beat apart read as a base reacting. (#354 made the count per-ring — 2 to 5 — so
  // this loop is over however many spans `gateEdges` reports, never a fixed pair.)
  _initGates() {
    this._gateStates = new Map();
    this._gateDemand = makeGateDemand();
    this._gateDemandCursor = 0;
    this._nextGateDemandAt = 0;
    this._gateClockMs = 0;
    this._gateDemandStats = makeGateDemandStats();
    const rng = mulberry32(0x9e3779b9 ^ (this.runSeed ?? 1));
    for (const edge of gateEdges(this.wallEdges)) {
      this._gateStates.set(edge.key, makeGateState(rng() * GATE_STAGGER_MAX_MS));
      edge.open = false;
      edge.openFrac = 0;
    }
  },

  // ── The DEMAND scan (#309 playtest) ────────────────────────────────────────────────────
  // Ask a few garrison units at a time "what is your way out", and record which gate span each one
  // is asking for. This is the signal that replaced the first pass's clock; the reasoning for the
  // counterfactual predicate, the first-crossing rule, and the sealed-in case is all in
  // data/gateDemand.js's header, which is worth reading before changing anything here.
  //
  // The predicate below is the ONE thing that differs from ordinary enemy routing: it treats every
  // standing gate span as passable regardless of its current phase, so a unit can discover a way
  // out through a door that is currently shut. Movement still routes against `_canEnemyStep`, where
  // a shut gate is solid — nothing walks through a closed door, it only learns that it would like
  // to.
  _canEnemyStepGatesOpen(from, to, toKey) {
    if (!isPassable(this.terrain.get(toKey ?? axialKey(to.q, to.r)))) return false;
    const set = this.wallEdges;
    if (!set || set.edges.size === 0) return true;
    const spans = set.byHex.get(from.key ?? axialKey(from.q, from.r));
    if (!spans) return true;
    for (const e of spans) {
      const onThisEdge = (e.a.q === to.q && e.a.r === to.r) || (e.b.q === to.q && e.b.r === to.r);
      if (!onThisEdge) continue;
      if (e.destroyed) continue;                       // a breach — open to everyone, permanently
      if (e.role === 'gate') continue;                 // the counterfactual: assume this door opens
      return false;                                    // a solid span, and no door can change that
    }
    return true;
  },

  // Is this enemy one whose opinion about gates counts? A garrison unit that is awake, alive, on
  // the ground, and able to move. Flyers go over the wall and never need a door; wall turrets are
  // bolted to the parapet and are never going anywhere; a dormant unit has not noticed the player
  // and so wants nothing. Excluding all three is what stops a base from opening its gates for units
  // that could not use them.
  _isGateDemandUnit(e) {
    return e.baseId != null
      && !e.flying
      && e.behavior !== 'turret'
      && e.awareness !== DORMANT
      && !e.mech?.isDestroyed?.();
  },

  _updateGateDemand(nowMs) {
    if (!this._gateDemand || !this._gateStates?.size) return;
    if (nowMs < this._nextGateDemandAt) return;
    this._nextGateDemandAt = nowMs + GATE_DEMAND_SCAN_MS;
    if (!this.terrain?.get || !this.wallEdges) return;

    const units = (this.enemies ?? []).filter(
      (e) => this._isGateDemandUnit(e) && this._wokenBases.has(e.baseId),
    );
    if (units.length === 0) return;

    // #347: the sortie goal is the primary player's hex. This is a coarse, whole-garrison
    // "which way is out" scan shared by every unit in the base (not a per-unit route), so it
    // deliberately takes ONE goal rather than resolving nearest per unit — phase 2 should
    // revisit whether a base splits its sortie between two players, which is a design
    // question (#335), not a mechanical one.
    const focus = primaryPlayerOf(this);
    const goal = pixelToHex(focus.x, focus.y);
    const canStep = (a, b, k) => this._canEnemyStepGatesOpen(a, b, k);
    // Round-robin from wherever the last scan stopped, so a garrison larger than the per-scan cap
    // is covered evenly instead of the same first four units being asked forever.
    const n = Math.min(GATE_DEMAND_UNITS_PER_SCAN, units.length);
    const st = (this._gateDemandStats ??= makeGateDemandStats());
    st.eligible = units.length;
    st.scans++;
    for (let i = 0; i < n; i++) {
      const e = units[(this._gateDemandCursor + i) % units.length];
      const from = pixelToHex(e.x, e.y);
      const res = findHexPath(from, goal, canStep, GATE_DEMAND_MAX_NODES);
      const kind = e.kind ?? 'unknown';
      const byKind = (st.byKind[kind] ??= { searches: 0, complete: 0, noted: 0, nullGate: 0 });
      st.searches++; byKind.searches++;
      st.expandedTotal += res.expanded;
      if (res.expanded > st.expandedMax) st.expandedMax = res.expanded;
      // ONLY a complete route counts. hexRoute returns a best-effort partial route when it cannot
      // reach the goal, and a partial route that happens to end beside a gate must not be read as
      // wanting it — that is precisely the sealed-in garrison case, which has to register no demand
      // rather than opening a door that cannot help. See gateDemand.js.
      if (!res.complete) { st.incomplete++; e._gateIntent = null; continue; }
      st.complete++; byKind.complete++;
      // #309 playtest 3: the scan no longer registers demand directly. It establishes INTENT —
      // which door this unit wants and how far it still has to walk to reach it — and the cheap
      // per-frame pass below decides when that intent has come close enough to be a request. The
      // expensive question (which door) is asked on the throttle; the cheap one (how close am I)
      // is asked every frame, which is what makes the timing tight rather than sampled.
      const req = gateRequestOnRoute(from, res.path, this.wallEdges.byHex);
      if (req == null) { st.nullGate++; byKind.nullGate++; e._gateIntent = null; continue; }
      st.noted++; byKind.noted++;
      e._gateIntent = { key: req.key, pathPx: req.pathPx, x: e.x, y: e.y };
    }
    this._gateDemandCursor = (this._gateDemandCursor + n) % units.length;
  },

  // The per-frame half of demand: turn standing INTENT into an actual request, but only for units
  // that are nearly there. Cheap by construction — a hypot per unit that has an intent, no graph
  // search — which is what lets it run every frame instead of on the scan's throttle. That matters:
  // if the "am I close yet" test were sampled at the scan rate, a unit could cross the threshold
  // just after being asked and not register until a second later, and the door would open late.
  _noteGateDemandInRange(nowMs) {
    const st = this._gateDemandStats;
    if (st) st.inRange = 0;
    for (const e of this.enemies ?? []) {
      const intent = e._gateIntent;
      if (!intent) continue;
      if (!this._isGateDemandUnit(e)) { e._gateIntent = null; continue; }
      const edge = this.wallEdges?.edges?.get(intent.key);
      if (!edge || edge.destroyed) { e._gateIntent = null; continue; }
      const mouthX = (edge.x0 + edge.x1) / 2, mouthY = (edge.y0 + edge.y1) / 2;
      const remaining = remainingToGate(e.x, e.y, intent, mouthX, mouthY);
      // Two different distances, deliberately, because they answer different questions.
      //
      // The RATE is tracked on the straight-line distance to the mouth, which changes smoothly with
      // the unit's actual motion. `remaining` cannot be used for it: that value is partly derived
      // from the cached route, so every time the throttled scan refreshes a unit's intent it steps
      // discontinuously, and differentiating a step produces a large spurious closing rate that
      // pops the door open early. (Measured: it inflated the test corridor's lead from ~1.1s to
      // 3.7s.) Straight-line distance has no such seams.
      //
      // The DISTANCE test still uses `remaining`, which accounts for a winding route and is never
      // smaller than the straight line — so where the two differ, the door opens earlier rather
      // than later, which is the direction to be wrong in.
      const direct = Math.hypot(mouthX - e.x, mouthY - e.y);
      // Track how fast that distance is SHRINKING, not how big it is. A garrison holding its
      // standoff position near its own wall sits at a constant distance from the doorway and does
      // not want it; a unit that has committed to coming out closes on it steadily and does. Those
      // two are indistinguishable by position and obvious by motion — see gateDemand.js.
      e._gateApproach = trackApproach(e._gateApproach, direct, nowMs);
      if (!requestsGate(remaining, e._gateApproach.rate)) continue;
      if (st) st.inRange++;
      this._gateDemand.note(intent.key, nowMs);
    }
  },

  // Per-frame tick, called from ArenaScene.update() alongside `_updateDockResupply`. Drives every
  // gate's cycle from its base's `awake` flag, mirrors the resulting phase onto the span's live
  // `open` / `openFrac` fields (which is what world.js's queries and wallArt.js's renderer read),
  // and plays the door FX on each transition.
  //
  // A DESTROYED gate is dropped from the map entirely: the player shot it down, it is now an
  // ordinary permanent breach in the ring, and there is nothing left to open or close. That is the
  // deliberate answer to "what happens if he destroys a closed gate" — a gate is a span with the
  // same 200hp pool as every other span, so blowing it open is exactly a breach, with the bonus
  // that he has also permanently denied the base one of its two sally ports.
  _updateGates(dt) {
    if (!this._gateStates || !this._gateStates.size) return;
    // ── One clock for the whole gate subsystem ──────────────────────────────────────────
    // Everything here — the demand ledger's grace window, the scan throttle, and the state
    // machine's own timers — advances on the SAME accumulated `dt` the scene gives us, rather than
    // some of it on `dt` and the rest on `this.time.now`.
    //
    // Those two clocks are not the same clock. ArenaScene clamps its delta
    // (`Math.min(0.05, delta / 1000)`) so a frame hitch cannot produce an enormous physics step,
    // while `time.now` keeps running in real time. At a healthy frame rate the difference is nil,
    // but on a struggling one they diverge badly: demand notes would expire on the real clock while
    // the doors reacted on the slowed one, so a gate could sit refusing to open while a unit stood
    // in front of it. Using the clamped clock throughout also means gate timings stay in step with
    // UNIT MOVEMENT, which is integrated from the very same `dt` — and "is the door open by the
    // time the unit arrives" is a question about those two things relative to each other, not about
    // wall time.
    this._gateClockMs = (this._gateClockMs ?? 0) + Math.max(0, dt) * 1000;
    const nowMs = this._gateClockMs;
    this._updateGateDemand(nowMs);        // throttled: WHICH door does each unit want
    this._noteGateDemandInRange(nowMs);   // every frame: is anyone close enough to ask for it yet
    // #355: which bases have lost their objective hex, and therefore have their gates latched
    // permanently open (gateCycle.js `tickFailOpen`). Computed ONCE per tick rather than per gate,
    // since #354 made a ring carry 2-5 of them and every gate on the same ring asks the same
    // question. Derived, not stored: `isBaseObjectiveDestroyed` is the same predicate the win
    // condition uses (`_allObjectivesDestroyed`), so the gates can never disagree with the mission
    // about whether a base is beaten — and it is already one-way, since a destroyed hex never
    // comes back into `buildingHp`. That is why this needs no `retired`-style flag of its own the
    // way #326's docks did: a dock's retirement had no such standing world fact behind it.
    const failedOpen = this._failedOpenBases();
    let redraw = false;
    for (const edge of gateEdges(this.wallEdges)) {
      const state = this._gateStates.get(edge.key);
      if (!state) continue;
      if (edge.destroyed) {
        this._gateStates.delete(edge.key);
        this._gateDemand?.forget(edge.key);   // a blown door's stale demand must not outlive it
        redraw = true;
        continue;
      }
      const next = tickGate(state, {
        awake: this._wokenBases.has(edge.baseId),
        demand: !!this._gateDemand?.wanted(edge.key, nowMs),
        failOpen: failedOpen.has(edge.baseId),
        // #369 ELEVATOR DOORS: is anything standing in the mouth? Only asked in the two phases
        // where the answer can change anything — the open gate deciding whether to shut, and the
        // closing gate deciding whether to relent. A shut, opening, or locked-open gate skips the
        // geometry entirely, which matters with #354's 2-5 gates per ring: the common case (every
        // gate on every dormant or shut ring, every frame) stays free.
        occupied: (state.phase === GATE_OPEN || state.phase === GATE_CLOSING) && !state.lockedOpen
          && this._gateMouthOccupied(edge),
        dt,
      });
      if (next === state) continue;
      this._gateStates.set(edge.key, next);
      // Passable ONLY in the fully-open phase — never mid-travel, so nothing can be caught in a
      // closing span. `setGateOpen` is the one place the flag is written.
      setGateOpen(this.wallEdges, edge, gatePassable(next));
      // The leaves' visible travel: 0 shut -> 1 open, ramped across the opening/closing phases so
      // the doors are seen to move rather than snapping between two states.
      edge.openFrac = next.phase === GATE_OPENING ? Math.min(1, next.phaseMs / GATE_OPENING_MS)
        : next.phase === GATE_CLOSING ? Math.max(0, 1 - next.phaseMs / GATE_CLOSING_MS)
          : gatePassable(next) ? 1 : 0;
      redraw = true;
      if (next.startedOpening) this._gateOpenFx(edge);
      if (next.justClosed) this._gateCloseFx(edge);
      // #369 fallback sweep. The doors are now fully shut, and with elevator doors in place nothing
      // that was in the mouth should have let them get here — so this normally finds nothing and
      // costs one distance test per body. It exists for the one path occupancy cannot see: a body
      // PLACED inside a shut span by a system that never asks the gate (a respawn or carrier drop,
      // a shove from #361's separation) between the last occupancy check and the leaves meeting.
      if (state.phase === GATE_CLOSING && next.phase === GATE_CLOSED) this._nudgeFromClosingGate(edge);
      // A gate opening or shutting changes what can be seen through it, so the cached field of
      // view is stale — same invalidation a breached span triggers (world.js `_damageWallEdge`).
      // #312: and what can be WALKED through it — a gate opening is a route appearing, a gate
      // shutting is one vanishing. This is a recurring invalidation (a gate cycles roughly every
      // 15s while its base is awake), which is exactly why it is a single counter bump and why
      // the resulting replans are spread across frames by the router's per-tick budget.
      if (next.justOpened || next.justClosed) { this._invalidateVisibility?.(); this._invalidateRoutes?.(); }
    }
    // Redraw every frame while any gate is mid-cycle, so the leaves animate; otherwise only on an
    // actual transition. (A fully-open gate is now static — no pulsing field left to animate — but
    // it is cheap to keep redrawing it and it keeps the leaves' rest position honest.)
    if (redraw || [...this._gateStates.values()].some(gatePassable)) this._redrawWallEdges();
  },

  // #369 — the live bodies a gate can be blocked by or can trap: every LIVE, non-flying player and
  // ground unit. The three exclusions are each load-bearing:
  //   • flyers pass over walls and were never in a mouth;
  //   • WRECKS, because an occupant that can never walk away would hold its gate open for the rest
  //     of the sortie — the one failure mode the elevator-door rule could actually produce, and the
  //     only place it needs closing off (see gateCycle.js `occupied`);
  //   • nothing else. Enemies count exactly as much as players do: a tank standing in the door
  //     holds it open, which is what Jackson's "applies to enemies as well" asks for.
  //
  // Returned as two GROUPS rather than one merged list, because the two body types answer "how big
  // am I to a wall" (#320) from different places — `wallCollideRadius(e)` per enemy kind, the flat
  // `PLAYER_WALL_COLLIDE_RADIUS` per player — and sniffing which is which from a merged array would
  // be a guess. Both consumers below iterate the groups the same way, so occupancy and the nudge
  // can never disagree about whether a given body fits through a given door.
  _gateBodyGroups() {
    return [
      { bodies: (this.enemies ?? []).filter((e) => !e.flying && !e.mech?.isDestroyed?.()), radiusOf: (e) => wallCollideRadius(e) },
      { bodies: livePlayersOf(this), radiusOf: () => PLAYER_WALL_COLLIDE_RADIUS },
    ];
  },

  // #369 ELEVATOR DOORS — is anything standing in this gate's mouth? The pure geometry is
  // data/gateClearance.js; this is only the "which bodies, at what radius" half. Called from
  // `_updateGates` for gates in the open/closing phases and fed to `tickGate` as `occupied`.
  _gateMouthOccupied(edge) {
    return this._gateBodyGroups().some((g) => gateMouthOccupied(g.bodies, edge, g.radiusOf));
  },

  // #369 — the FALLBACK sweep (see the header of data/gateClearance.js). Runs on the tick a gate
  // finishes shutting, for a body that was placed inside the span by a system that never asked the
  // gate. Pushes through the SAME swept wall test the bodies' own locomotion uses, at the body's
  // own radius, so a nudge can never end inside geometry.
  //
  // `edge.key` is handed to that test as the one span to ignore: the gate that just shut must not
  // veto the escape it caused (it now reads as solid across the very mouth the body is standing
  // in), while every other wall and all impassable terrain still block the push normally.
  _nudgeFromClosingGate(edge) {
    if (!this._blockedAlongSegment) return 0;
    let moved = 0;
    for (const { bodies, radiusOf } of this._gateBodyGroups()) {
      moved += nudgeFromGateMouth(bodies, edge, {
        radiusOf,
        canMove: (b, x, y) => !this._blockedAlongSegment(b.x, b.y, x, y, radiusOf(b), edge.key),
      });
    }
    return moved;
  },

  // A bright amber flare and ring across the gate's mouth as the leaves start to part — the
  // "something is coming out of there" cue, deliberately loud enough to pull the eye across the
  // field. Same throwaway-display-object/tween style as `_resupplyDock`'s platform-rise sequence,
  // which is the machinery #309 asked this to reuse.
  _gateOpenFx(edge) {
    const x = (edge.x0 + edge.x1) / 2, y = (edge.y0 + edge.y1) / 2;
    Audio.explosion(0.3, { x, y, ...listenerOf(this) });
    const flare = this.add.circle(x, y, 10, 0xffc65a, 0.75).setDepth(DEPTH.IMPACT_FX);
    const ring = this.add.circle(x, y).setStrokeStyle(3, 0xffc65a, 0.9).setRadius(12).setDepth(DEPTH.IMPACT_FX + 0.1);
    this.tweens.add({ targets: flare, scale: 2.4, alpha: 0, duration: 620, ease: 'Quad.easeOut', onComplete: () => flare.destroy() });
    this.tweens.add({ targets: ring, scale: 3.4, alpha: 0, duration: 760, ease: 'Quad.easeOut', onComplete: () => ring.destroy() });
  },

  // The gate slamming shut: a quiet mechanical thud and a quick inward flash, mirroring the dock
  // door-close cue's "nothing was destroyed, something just sealed" register (`_closeDock`, #395).
  _gateCloseFx(edge) {
    const x = (edge.x0 + edge.x1) / 2, y = (edge.y0 + edge.y1) / 2;
    Audio.explosion(0.2, { x, y, ...listenerOf(this) });
    const ring = this.add.circle(x, y).setStrokeStyle(2.5, 0x8a7645, 0.85).setRadius(26).setDepth(DEPTH.IMPACT_FX);
    this.tweens.add({ targets: ring, scale: 0.2, alpha: 0, duration: 420, ease: 'Quad.easeIn', onComplete: () => ring.destroy() });
  },
};
