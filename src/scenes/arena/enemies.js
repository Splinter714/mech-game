// Arena enemies mixin — enemy lifecycle (spawn/debug-spawn/reset) and the per-enemy AI.
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign. Enemy
// loadouts are data (data/enemies.js).
//
// ── #44 tactical AI ────────────────────────────────────────────────────────────────────
// The old model computed ONE preferred distance and perturbed a single orbit (advance if far,
// retreat if close, strafe otherwise, plus sine/pressure/commit timers). It always read as
// "circle-strafe at radius R." This rewrite replaces the orbit with a small STATE MACHINE
// whose states are readable tactical intents, chosen by a short decision timer (not per frame,
// so a choice is committed long enough to look deliberate):
//
//   PRESS    — close the distance; get inside optimal range (brawlers, or player fleeing).
//   KITE     — back away while keeping LOS; hold standoff (snipers, or player too close).
//   FLANK    — travel to a concrete off-axis destination at good range (varying approach
//              vectors instead of a constant-radius circle). This is the default "fighting".
//   COVER    — break line-of-sight behind a real wall (taking damage / low health), then peek.
//   HOLD     — sit at good range with LOS and shoot (healthy, well-positioned).
//
// A weapon-range-derived ROLE (brawler / skirmisher / sniper) biases the standoff distance and
// which states are favoured. Real terrain drives COVER (via _isWall / _wallDistance). Firing
// (LOS-gated, with lead) is preserved. Everything is gated by this.enemyMove / this.enemyFire.
import Phaser from 'phaser';
import { Mech } from '../../data/Mech.js';
import { ENEMIES, ENEMY_ROTATION, DEFAULT_SQUAD } from '../../data/enemies.js';
import { ENEMY_KINDS, isEnemyKind, SWARM_SIZE, TURRET_CLUSTER_SIZE, INFANTRY_MOB_SIZE } from '../../data/enemyKinds.js';
import { HpBody } from '../../data/HpBody.js';
import { resolveWeapon } from '../../data/weapons.js';
import { buildMechTextures, reskinMech, buildVehicleTextures, mechLayout, ART_SCALE } from '../../art/index.js';
import { hexToPixel, range, HEX_SIZE } from '../../data/hexgrid.js';
import { nearestValidPixel, turretClusterHexes, minSafeSpawnDist, spawnDistance } from '../../data/spawnPlacement.js';
import { pickWanderGoal } from '../../data/wander.js';
import { isWaterTerrain } from '../../data/terrain.js';
import { LETHAL_GROUPS } from '../../data/anatomy.js';
import { approach, backwardSpeedScale, ARENA_MECH_SCALE, mechMuzzleTipOffset, partMuzzle, rotateToward, unitDepth, isSmallUnit } from './shared.js';
import { makeLock, stepLock, hasLock } from '../../data/targetlock.js';
import { trackCoverSpot, coverLeashExpired, COVER_SPOT_RADIUS } from '../../data/coverLeash.js';
import { biasedSpawnAngle } from '../../data/spawnBias.js';
import { UNAWARE, AWARE, DORMANT, detectionRangeFor, shouldBecomeAware, NOISE_WINDOW_MS } from '../../data/awareness.js';
import { ENEMY_BEHAVIORS } from './enemyBehaviors.js';
import { planEmissions } from '../../data/delivery.js';
import { scheduleFireCues } from '../../audio/fireCues.js';
import { SOUND_THROTTLE_MS } from '../../data/hitFx.js';

const SQRT3 = Math.sqrt(3);   // pointy-top hex horizontal spacing factor (matches hexgrid.js)

// ── #44 tactical-AI tuning (owner: review/tune) ─────────────────────────────────────────
// Grouped so the feel can be re-tuned without hunting through _updateEnemy.

// Role thresholds: an enemy whose weapons' mean optimum range is below BRAWLER_OPT is a
// close-quarters brawler (presses in); above SNIPER_OPT it's a sniper (kites); between, a
// mid-range skirmisher (flanks). Standoff distance is derived from that mean opt, clamped.
const BRAWLER_OPT = 170;            // mean weapon opt (px) below this ⇒ brawler role
const SNIPER_OPT = 360;             // mean weapon opt (px) above this ⇒ sniper role
const STANDOFF_MIN = 90;            // never try to fight closer than this
const STANDOFF_MAX = 520;           // never try to fight farther than this
const STANDOFF_FRAC = 0.85;         // standoff = STANDOFF_FRAC × mean weapon opt (sit just inside opt)
const DEFAULT_OPT = 220;            // fallback mean opt for a weaponless mech

// Distance bands, expressed as multiples of the enemy's standoff distance. Inside TOO_CLOSE
// it wants to back off; beyond TOO_FAR it wants to close; the sweet spot is the ring between.
const TOO_CLOSE_FRAC = 0.55;        // dist < standoff×this ⇒ "player is in my face"
const TOO_FAR_FRAC = 1.45;          // dist > standoff×this ⇒ "player is out of my fight"

// Decision cadence: how long a chosen state is held before the AI re-decides. A range, so N
// enemies don't re-plan in lockstep. Kept > ~0.5s so moves read as intent, not twitch.
const DECIDE_MIN = 750;
const DECIDE_MAX = 1500;

// FLANK: when the AI decides to reposition it picks a destination at standoff range, offset
// from the current player-bearing by a flank angle. The angle is re-picked per flank decision
// (from this spread) and its sign is the enemy's persistent orbit handedness (spaces enemies
// out — some go left, some right). Larger angle ⇒ wider, less orbit-like arcs.
const FLANK_ANGLE_MIN = 0.55;       // rad — min off-axis flank angle (~31°)
const FLANK_ANGLE_MAX = 1.35;       // rad — max off-axis flank angle (~77°)
const FLANK_REACH = 0.45;           // fraction of the flank leg that counts as "arrived"

// COVER: how far to probe for a wall that breaks LOS, and how close to the cover edge to sit.
const COVER_SEARCH_STEP = 40;       // px between sampled cover candidate points
const COVER_SEARCH_RING = 3;        // how many rings of hexes out to search for cover
const COVER_HEALTH_TRIGGER = 0.45;  // lethal-part health fraction below which COVER is favoured
const COVER_DAMAGE_WINDOW = 1400;   // ms after taking a hit that the enemy prefers cover
const PEEK_DIST = 26;               // px past a cover edge the enemy leans out to shoot

// Artillery posture (#44 follow-up): a mech whose weapons are ALL indirect-fire (every one is
// homing or arcing, so it never needs line-of-sight to hit) camps behind cover as its PRIMARY
// state — it bombards over walls and never willingly exposes itself. When it can't find cover
// it falls back to holding at standoff. These bound how far it ranges and how often it hunts a
// fresh camp spot even while safely behind a wall (so it isn't perfectly static).
const ARTY_RECAMP_MIN = 2600;       // ms — min interval an all-indirect mech holds one camp spot
const ARTY_RECAMP_MAX = 5200;       // ms — max before it looks for a fresh cover position

// Off-screen spawn (#44 follow-up): enemies appear OUTSIDE the camera viewport and walk in.
// The spawn point is the visible-world rectangle's edge pushed out by this margin (px), placed
// on a random bearing from the player, then clamped inside the world disc so it stays on the map.
const OFFSCREEN_MARGIN = 120;       // px beyond the visible edge to drop a spawning enemy
const SPAWN_WORLD_INSET = 1.5;      // hexes of inset from the world edge kept clear for spawns

// #145: a turret-nest cluster's TURRET_CLUSTER_SIZE turrets all share ONE validated hex — this is
// just enough of a px nudge, spread evenly around that hex's centre, that the overlapping sprites
// still read as distinct turrets rather than rendering as one indistinguishable blob. Small
// relative to the hex radius (48px) so the emplacement still reads as tightly "centered on this
// one hex."
const TURRET_HUDDLE_OFFSET = 10;

// Movement feel.
const MOVE_SPEED_FRAC = 0.85;       // fraction of chassis maxSpeed the AI drives at
const ARRIVE_SLOW = 70;             // px from a destination where the enemy eases to a stop
const REPICK_ON_ARRIVE = true;      // arriving at a FLANK/COVER goal forces an early re-decide

// #103 awareness: while UNAWARE, a mech loiters near its own spawn point instead of engaging —
// a light idle wander so a "sleeping" squad still reads as alive, not frozen. Small radius/slow
// re-pick cadence so it stays a subtle patrol, not a distraction from the aware enemies nearby.
const IDLE_WANDER_RADIUS = 90;      // px around spawnX/spawnY the idle waypoint may land
const IDLE_REPICK_MIN = 2200;       // ms — min hold before picking a fresh idle waypoint
const IDLE_REPICK_MAX = 4200;       // ms — max hold before picking a fresh idle waypoint
const IDLE_SPEED_FRAC = 0.35;       // fraction of MOVE_SPEED_FRAC used while idle (slow patrol)

// Reactivity: bias state choice on what the player is doing.
const PLAYER_FLEE_DOT = 0.35;       // player velocity·(away from enemy) above this ⇒ "fleeing"
const PLAYER_VULN_HEALTH = 0.4;     // player lethal-part health below this ⇒ press the kill
const TRACKED_DOT = 0.965;          // player aim·(toward enemy) above this ⇒ "being tracked" (~15°)
const TRACKED_BREAK_CHANCE = 0.7;   // odds a tracked enemy juke-breaks its current plan on a decide

// #161: a non-mech KIND's textures depend only on its art builder + accent colour (def.art +
// def.themeColor), both fixed per ENEMY_KINDS entry — never varied per spawned instance (no
// reskin/theme-swap mechanic exists for vehicles; see the comment on _resetEnemies). So every
// live unit of the same kind+theme is pixel-identical and can safely share ONE texture set,
// keyed off that visual identity instead of the old per-spawn `enemy${seq}` key. Distinct kinds
// with the same themeColor still get distinct keys (the art id is part of the key), and a kind
// reused with a different themeColor (none today, but data-driven) would also get its own set.
function vehicleTextureKey(def) {
  return `vehicle_${def.art}_${(def.themeColor ?? 0).toString(16)}`;
}

// #68/#75: on-screen scale of a non-mech unit's sprites is now PER-KIND (data-driven): each
// ENEMY_KINDS entry carries a `scale` MULTIPLE of the arena mech scale, so adding/retuning a
// unit is a data edit. VEHICLE_SCALE_MULT is the fallback multiplier for a kind with no
// `scale` (the old global 1.15× mech); `vehicleScale(def)` resolves the display scale.
const VEHICLE_SCALE_MULT = 1.15;
const vehicleScale = (def) => ARENA_MECH_SCALE * (def.scale ?? VEHICLE_SCALE_MULT);

// Small helpers ---------------------------------------------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Mean optimum range of a mech's mounted weapons → drives role + standoff. Approximation.
function meanOpt(mech) {
  const ws = mech.weapons().map((w) => w.weapon).filter(Boolean);
  if (!ws.length) return DEFAULT_OPT;
  return ws.reduce((a, w) => a + (w.range?.opt ?? DEFAULT_OPT), 0) / ws.length;
}
function roleFor(opt) {
  if (opt < BRAWLER_OPT) return 'brawler';
  if (opt > SNIPER_OPT) return 'sniper';
  return 'skirmisher';
}

// Is one weapon indirect-fire — homing or arcing, so it hits WITHOUT line-of-sight? Mirrors the
// direct/indirect split in targeting.js `_fireAngle` (guidance 'homing' or path 'arcing').
function isIndirectWeapon(weapon) {
  const d = weapon?.delivery;
  return !!d && (d.guidance === 'homing' || d.path === 'arcing');
}

// Does a mech's ENTIRE loadout fire indirectly (every mounted weapon is homing/arcing)? Such a
// mech never needs LOS to hit, so it can camp behind cover as a primary posture and bombard over
// walls. A mech with any direct weapon must expose/peek to shoot. False if it has no weapons.
function isAllIndirect(mech) {
  const ws = mech.weapons().map((w) => w.weapon).filter(Boolean);
  return ws.length > 0 && ws.every(isIndirectWeapon);
}

// Lowest health fraction among the enemy's lethal parts — #128: both side torsos, since
// losing both is now the kill condition (LETHAL_GROUPS) — the AI reads "am I hurt?" off
// this to decide whether to seek cover / disengage.
function lethalHealth(mech) {
  let lo = 1;
  for (const group of LETHAL_GROUPS) {
    for (const loc of group) {
      const f = mech.partHealthFraction(loc);
      if (f < lo) lo = f;
    }
  }
  return lo;
}

export const EnemiesMixin = {
  // ── Enemy lifecycle (#39 debug controls) ──────────────────────────────────────────
  // Build a fresh enemy with its own textures + view + AI state and track it. `typeId`
  // selects EITHER a non-mech KIND (data/enemyKinds.js — turret/tank/drone/helicopter) or a
  // mech loadout (data/enemies.js, the default). Dispatched on isEnemyKind so the mech path
  // stays byte-for-byte unchanged; non-mech kinds go through _spawnKind. Returns the enemy (or
  // the last unit for a 'swarm'/'turretNest' request, which each expand into several).
  _spawnEnemy(x, y, typeId = 'raider') {
    if (typeId === 'swarm') return this._spawnSwarm(x, y);
    if (typeId === 'turretNest') return this._spawnTurretCluster(x, y);
    if (typeId === 'infantryMob') return this._spawnInfantryMob(x, y);
    if (isEnemyKind(typeId)) return this._spawnKind(x, y, typeId);
    return this._spawnMech(x, y, typeId);
  },

  // A MECH enemy (the original path): a Mech + mech textures + the six-sprite view + the #44
  // tactical AI state. Unchanged from the pre-#68 _spawnEnemy body.
  _spawnMech(x, y, typeId = 'raider') {
    const key = `enemy${this._enemySeq++}`;
    const def = ENEMIES[typeId] ?? ENEMIES.raider;
    const mech = new Mech(def);
    mech.repairAll();
    buildMechTextures(this, key, mech, { theme: 'enemy' });
    const angle = Math.PI / 2;
    const view = this._makeMechView(key, x, y, angle);
    const opt = meanOpt(mech);
    const e = {
      key, mech, view, x, y, vx: 0, vy: 0, angle, turret: angle, fireCd: {},
      spawnX: x, spawnY: y, typeId, kind: 'mech',
      // #44 tactical-AI state.
      role: roleFor(opt),
      standoff: clamp(opt * STANDOFF_FRAC, STANDOFF_MIN, STANDOFF_MAX),
      handed: Math.random() < 0.5 ? 1 : -1,   // persistent flank handedness (spaces enemies out)
      // #44 follow-up: an all-indirect (homing/arcing) loadout camps cover as its primary posture.
      allIndirect: isAllIndirect(mech),
      // #103: detection range derives from the same standoff/weapon-range concept the tactical
      // AI already computed above, widened a touch (see data/awareness.js).
      detectRange: detectionRangeFor(clamp(opt * STANDOFF_FRAC, STANDOFF_MIN, STANDOFF_MAX)),
    };
    this._resetAiState(e);
    this.enemies.push(e);
    this._enemiesSpawnedThisStage = (this._enemiesSpawnedThisStage ?? 0) + 1;
    this.registry.set('dummyMech', this.enemies[0].mech);
    return e;
  },

  // A NON-MECH KIND (#68): an HpBody + vehicle textures + a simple two-sprite (hull/turret) view
  // + a per-kind behavior (enemyBehaviors.js, dispatched by def.behavior). `flying` units skip
  // wall collision and draw a drop shadow. The body satisfies the same interface the arena uses
  // (isDestroyed/applyDamage/partHealthFraction/name/parts), so combat/hit/HUD code is uniform.
  // #161: `key` is now the CANONICAL (kind+theme) texture key, not a fresh per-spawn key — every
  // unit of the same visual identity points at the same texture set. `buildVehicleTextures` only
  // actually runs the first time a given key is seen (checked via `_turret`, which every art
  // builder always generates, walk-cycle or not); every subsequent unit of that kind+theme just
  // reuses what's already in the texture manager, skipping the (measured 11.4ms on an 80-unit
  // infantry mob) redundant canvas-raster work entirely. `e.key` still only feeds texture lookups
  // for non-mech kinds (verified: no shooter/beam-identity or reskin code path reads it — those
  // are mech-only), so sharing it is safe.
  _spawnKind(x, y, typeId) {
    this._enemySeq++;   // keep the debug spawn-rotation counter advancing (unchanged behavior)
    const def = ENEMY_KINDS[typeId];
    const key = vehicleTextureKey(def);
    if (!this.textures.exists(`${key}_turret`)) buildVehicleTextures(this, key, def);
    const body = new HpBody(def);
    const angle = Math.PI / 2;
    const view = this._makeVehicleView(key, x, y, angle, def);
    const e = {
      key, mech: body, view, x, y, vx: 0, vy: 0, angle, turret: angle, fireCd: 0,
      spawnX: x, spawnY: y, typeId, kind: def.kind, kindDef: def, flying: !!def.flying,
      behavior: def.behavior, handed: Math.random() < 0.5 ? 1 : -1,
      rotorSpin: 0,           // flyers spin their rotor overlay
      // #103: starts UNAWARE — idles near spawn until it detects the player. Detection range
      // reuses the kind's own engagement range (fireRange), widened a touch.
      awareness: UNAWARE,
      detectRange: detectionRangeFor(def.fireRange),
      idleGoal: null, idleAt: 0,
      // #152: walk-cycle animation state for a kind whose art builds multiple hull frames (see
      // def.legFrames / _updateVehicle below) — harmless/unused for kinds without it.
      stepMs: 0, hullFrame: 0,
    };
    this.enemies.push(e);
    this._enemiesSpawnedThisStage = (this._enemiesSpawnedThisStage ?? 0) + 1;
    this.registry.set('dummyMech', this.enemies[0].mech);
    return e;
  },

  // Expand a 'swarm' request into SWARM_SIZE drones dropped in a tight cluster around (x,y), so
  // the pack arrives together and reads as numbers. Returns the last drone spawned.
  _spawnSwarm(x, y) {
    let last = null;
    for (let i = 0; i < SWARM_SIZE; i++) {
      const a = (i / SWARM_SIZE) * Math.PI * 2;
      last = this._spawnKind(x + Math.cos(a) * 40, y + Math.sin(a) * 40, 'drone');
    }
    return last;
  },

  // #89 (fixed per #114 — playtest 2026-07-10: clusters spawning off-map / on forest/water),
  // tightened per #145 (playtest 2026-07-11: "turrets are in 3 separate hexes, but they should be
  // in 1 hex centered on that hex's center"): expand a 'turretNest' request into
  // TURRET_CLUSTER_SIZE turrets dropped together on a SINGLE VALIDATED hex, rather than blindly
  // grid-offsetting from the raw (x, y) spawn point (the old fixed 2-per-row pixel-offset grid
  // never checked terrain/bounds) or spreading across a neighborhood of distinct hexes (#114's
  // fix, which #145 walks back). `turretClusterHexes` (data/spawnPlacement.js, pure + unit-tested)
  // finds the nearest passable/in-bounds hex to the raw point (mirrors the `_reachableDropPos`
  // primitive powerups.js/#73 uses for drop placement) — every turret lands on that one hex, just
  // nudged a few px apart around its centre (`TURRET_HUDDLE_OFFSET`) so the overlapping sprites
  // still read as distinct turrets rather than one blob. Returns the last turret spawned.
  _spawnTurretCluster(x, y) {
    const hexes = turretClusterHexes(this.terrain, this.worldRadius, x, y, TURRET_CLUSTER_SIZE);
    const { x: cx, y: cy } = hexToPixel(hexes[0].q, hexes[0].r);
    let last = null;
    for (let i = 0; i < hexes.length; i++) {
      // #145 (playtest 2026-07-15: liked the cluster, but wants it rotated 45° from an
      // upright NSEW plus-shape to a diagonal NE/SE/SW/NW X-shape) — constant Math.PI / 4
      // offset rotates every turret's placement angle by 45°.
      const a = (i / hexes.length) * Math.PI * 2 + Math.PI / 4;
      const px = cx + Math.cos(a) * TURRET_HUDDLE_OFFSET;
      const py = cy + Math.sin(a) * TURRET_HUDDLE_OFFSET;
      last = this._spawnKind(px, py, 'turret');
    }
    return last;
  },

  // #97: expand an 'infantryMob' request into INFANTRY_MOB_SIZE troopers dropped in a cluster
  // around (x,y) — bigger volume than the drone swarm (SWARM_SIZE) so it reads as an
  // overwhelming crowd. Ground units, so they're placed on a few concentric rings (not one
  // ring like the drone swarm) to avoid dropping dozens of them exactly on top of each other
  // right before terrain/collision resolves them apart. #104 (playtest: "they should be more
  // clustered together") — the rings were originally spread wide (30 + ring*34, i.e. successive
  // rings at 30/64/98/...px out), which read as the mob spread across a broad disc rather than a
  // huddle. Tightened to a much smaller base radius and per-ring step so the whole mob packs
  // into a dense knot the player has to plow through, not a wide spread.
  // #115 (playtest 2026-07-10: "infantry movement seems to let them off the map sometimes?"):
  // these ring offsets, like the old turret-cluster grid (#114), were never checked against
  // terrain/bounds — a trooper on an outer ring could land off the playable map or on forest/
  // water. Each computed ring point is now snapped through `nearestValidPixel` (data/
  // spawnPlacement.js, pure + unit-tested) before spawning, so no trooper is ever placed
  // somewhere invalid to begin with (movement-time bounds-checking is handled separately, see
  // `_updateVehicle`'s off-map recovery). Returns the last trooper spawned.
  _spawnInfantryMob(x, y) {
    let last = null;
    const perRing = 10;
    for (let i = 0; i < INFANTRY_MOB_SIZE; i++) {
      const ring = Math.floor(i / perRing);
      const idxInRing = i % perRing;
      const ringCount = Math.min(perRing, INFANTRY_MOB_SIZE - ring * perRing);
      const a = (idxInRing / ringCount) * Math.PI * 2 + ring * 0.4;
      const r = 14 + ring * 16;
      const pos = nearestValidPixel(this.terrain, this.worldRadius, x + Math.cos(a) * r, y + Math.sin(a) * r);
      last = this._spawnKind(pos.x, pos.y, 'infantry');
    }
    return last;
  },

  // A non-mech unit's view: a hull sprite (base/airframe, faces travel) + a turret sprite (gun /
  // rotor, faces aim or spins), optionally over a drop shadow for flyers so they read elevated.
  _makeVehicleView(key, x, y, angle, def) {
    const parts = [];
    let shadow = null;
    const vs = vehicleScale(def);
    if (def.flying) {
      // #93: the shadow's own footprint scales with the unit's display scale (vs) — it was
      // previously a fixed 26x14 regardless of body size, so it read as oversized once drones
      // were shrunk repeatedly (#75/#89/#91). Sized off the same `vs` the hull/turret sprites use.
      // #98: #93's base 26x14 undershot — after the same scale multiply it read too SMALL next
      // to the drone/helicopter art's actual footprint. Bumped the base ellipse up to 34x18 (the
      // scale-multiply behaviour from #93 is unchanged, only these two base numbers moved).
      shadow = this.add.ellipse(0, 0, 34 * vs, 18 * vs, 0x000000, 0.28);
      parts.push(shadow);
    }
    // #152: a kind whose art builds a walk-cycle (def.legFrames — currently just the
    // Broodwalker/quadruped) starts on frame 0 of `${key}_hull_0..N`; every other kind keeps the
    // single static `${key}_hull` texture, unchanged.
    const hullKey = def.legFrames ? `${key}_hull_0` : `${key}_hull`;
    const hull = this.add.sprite(0, 0, hullKey).setScale(vs);
    const turret = this.add.sprite(0, 0, `${key}_turret`).setScale(vs);
    hull.rotation = angle + Math.PI / 2;
    turret.rotation = angle + Math.PI / 2;
    parts.push(hull, turret);
    const c = this.add.container(x, y, parts);
    // #99/#113/#289: a flying kind (helicopter/drone — narratively elevated, no "who's closer to
    // the ground" ambiguity) shares the player's DEPTH.UNITS tier. A GROUND kind renders below the
    // player, split by SIZE tier (#289): a SMALL kind (tank/infantry, `def.size === 'small'`) sits
    // at DEPTH.GROUND_UNITS, below the cover canopy so it peeks out from under foliage; a LARGE kind
    // (turret/quadruped) sits at DEPTH.LARGE_GROUND_UNITS, above the canopy so it towers over tree
    // tops. `def.size` mirrors `unitSize`'s default-to-large when absent — see shared.js.
    c.setDepth(unitDepth(false, def.flying, def.size === 'small'));
    c.hull = hull; c.turret = turret; c.shadow = shadow;
    return c;
  },

  // Zero an enemy's transient AI decision state (state machine + timers + memory). Split out
  // so spawn and reset share it and can't drift; guarantees no stale carry-over / NaN.
  _resetAiState(e) {
    e.state = 'flank';
    e.decideAt = 0;               // ms until the next decision (0 ⇒ decide next frame)
    e.goal = null;                // {x, y} destination for flank/cover moves
    e.lastHealth = lethalHealth(e.mech);
    e.hurtUntil = 0;              // scene-time until which recent damage biases toward cover
    e.recampAt = 0;               // ms until an all-indirect mech hunts a fresh camp spot
    e.coverSpot = null;           // #72 leash: {x, y, since} — the cover spot it's camped at
    e.lock = makeLock();          // #62: this enemy's indirect-fire lock ON THE PLAYER
    // #103: fresh spawn (or a debug reset) starts UNAWARE again — idle near spawn until it
    // detects the player. One-way per encounter, so a reset is the only thing that re-arms it.
    e.awareness = UNAWARE;
    e.idleGoal = null;            // {x, y} current idle-wander waypoint near spawnX/spawnY
    e.idleAt = 0;                 // ms until the idle waypoint is re-picked
    // #269: a docked mech's wake-response flag (scenes/arena/bases.js `_wakeBase`) is transient
    // AI state same as everything else here — clear it so a debug reset doesn't leave a
    // previously-woken mech permanently pinned to 'hold' with no dock/base left to explain why.
    e.holdGround = false;
    e.reactDelayMs = null;        // #285: any pending post-wake stagger is transient AI state too
  },

  // #44 follow-up: the default opening squad — one of each mech type — dropped OFF-SCREEN so
  // they walk into view and engage per their AI (the bombardier heads for cover, the brawler
  // closes, etc.). Called once from ArenaScene.create() in place of the old single fixed spawn.
  _spawnSquad(types = DEFAULT_SQUAD) {
    for (const typeId of types) {
      const p = this._offscreenSpawnPoint(typeId);
      this._spawnEnemy(p.x, p.y, typeId);
    }
  },

  // A spawn point OUTSIDE the current camera viewport but inside the world disc, on a random
  // bearing from the player — so the enemy starts unseen and walks in. The camera follows the
  // player, so "off-view" is a radius from the player: half the visible world rect's diagonal,
  // plus OFFSCREEN_MARGIN. The viewport size in world units is the canvas size (game.scale)
  // divided by the camera's actual zoom. We read `cameras.main.zoom` (set synchronously in
  // ArenaScene.create() before `_spawnSquad()` runs, so it's valid here) rather than the raw
  // `dpr`: #149 gave the arena its own `zoomFactor` on top of dpr (GAMEPLAY_ZOOM, arena/shared.js)
  // — before that, dpr and the camera's zoom were always the same number, so reading either
  // worked, but they can now diverge, and this math needs the REAL effective zoom to size the
  // world-space viewport correctly (using the stale dpr alone would overestimate the true
  // viewport and spawn enemies farther out than actually necessary to stay off-screen). `dpr` is
  // kept only as the fallback for the (never-hit-in-practice) case zoom isn't set yet.
  //
  // #203 (playtest report: enemies near the deploy point already actively engaging the instant
  // the player drops in): being off-VIEW was never the same guarantee as being outside the
  // enemy's own detection range — a turret nest's 2400px fireRange (2880px detect range, distance
  // -only, no LOS needed) dwarfs the ~700-1000px this viewport math normally produces, so a
  // turret nest was AWARE and shelling the player within the first second of every deploy
  // regardless of window size (and a narrow/small browser window could shrink the off-view
  // distance below even an ordinary mech's detection range too). `typeId` (optional — omitted
  // for the debug free-spawn, which is meant to walk into view fast) looks up that enemy's own
  // detection-range floor (`minSafeSpawnDist`, data/spawnPlacement.js) and the actual distance
  // never lands inside it (`spawnDistance`, same file).
  _offscreenSpawnPoint(typeId = null) {
    const zoom = this.cameras.main.zoom || this.registry.get('dpr') || 1;
    const vw = this.scale.width / zoom;   // world-space viewport width
    const vh = this.scale.height / zoom;  // world-space viewport height
    const viewR = 0.5 * Math.hypot(vw, vh) + OFFSCREEN_MARGIN;
    const maxR = (this.worldRadius - SPAWN_WORLD_INSET) * HEX_SIZE * SQRT3;   // ~world edge in px
    const minSafeDist = typeId != null ? minSafeSpawnDist(typeId) : 0;
    // #102: bias the spawn bearing toward the objective's direction — enemies read as coming
    // from what you're attacking rather than scattering uniformly around the player. Falls back
    // to a uniform bearing (biasedSpawnAngle's own null handling) if there's no live objective.
    const objAngle = this._objectiveAngle();
    for (let tries = 0; tries < 24; tries++) {
      const ang = biasedSpawnAngle(objAngle);
      // Distance from the player: just off-view (and never inside this enemy's own detection
      // range), but never past the world edge.
      const d = spawnDistance({ viewR, minSafeDist, maxR, jitter: Math.random() * 120 });
      let x = this.px + Math.cos(ang) * d, y = this.py + Math.sin(ang) * d;
      // Clamp inside the world disc, then nudge off any blocked terrain toward the centre.
      const fromC = Math.hypot(x, y);
      if (fromC > maxR) { x *= maxR / fromC; y *= maxR / fromC; }
      for (let n = 0; n < 6 && this._blocked(x, y); n++) { x *= 0.85; y *= 0.85; }
      if (!this._blocked(x, y)) return { x, y };
    }
    return { x: 0, y: -maxR * 0.8 };   // last-resort clear-ish fallback (map is open near centre)
  },

  // The bearing (radians, player → objective) spawn points are biased toward (#102), or null
  // when there's no live objective this stage (spawns then fall back to a uniform bearing).
  _objectiveAngle() {
    if (!this.objectiveHex) return null;
    const [q, r] = this.objectiveHex.split(',').map(Number);
    const { x: ox, y: oy } = hexToPixel(q, r);
    return Math.atan2(oy - this.py, ox - this.px);
  },

  // Drop an extra enemy from OFF-SCREEN so it walks into view (#44 follow-up), cycling the
  // loadout rotation so successive spawns differ in role instead of stacking identical orbits.
  _spawnEnemyDebug() {
    const typeId = ENEMY_ROTATION[this._enemySeq % ENEMY_ROTATION.length];
    const p = this._offscreenSpawnPoint();
    this._spawnEnemy(p.x, p.y, typeId);
  },

  // Restore every enemy to full health at its spawn point (in place, no re-deploy). Mech and
  // non-mech units share the same repair/reposition; only the fireCd shape (map vs. number) and
  // the texture reskin (mechs re-draw damage stumps; vehicles have static textures) differ.
  _resetEnemies() {
    for (const e of this.enemies) {
      e.mech.repairAll();
      e.x = e.spawnX; e.y = e.spawnY; e.vx = 0; e.vy = 0;
      e.angle = Math.PI / 2; e.turret = Math.PI / 2;
      e.view.setAlpha(1).setPosition(e.x, e.y);
      if (e.kind === 'mech') {
        e.fireCd = {};
        this._resetAiState(e);   // #44: fresh decision state, no mid-plan carry-over
        reskinMech(this, e.key, e.mech, { theme: 'enemy' });
      } else {
        e.fireCd = 0;            // vehicles use a single numeric cooldown
        e.burstShotsFired = 0;   // #243: fresh burst window (trigger discipline, _fireVehicleWeapon)
      }
    }
  },

  // #71: tear down one enemy's scene-side resources — its sprite container and the procedural
  // textures generated under its key. Called when a stage's squad is replaced wholesale
  // (run.js _startNextStage): without this, every stage's corpses left their multi-sprite views
  // on the display list (and their textures in the texture manager) for the rest of the arena
  // session, so the frame cost grew stage over stage — the measured cause of late-run combat lag.
  _destroyEnemy(e) {
    if (e._tornDown) return;   // guard against a double-teardown race (see _removeEnemy)
    e._tornDown = true;
    e.view.destroy();
    // A MECH enemy still owns a unique per-instance texture set (buildMechTextures/reskinMech key
    // off `e.key`, one per spawned mech, since damage-state reskins are per-instance) — cleaned up
    // here exactly as before, including #152's `hull_0..3` walk-cycle frames.
    //
    // #161: a non-mech KIND's textures are now SHARED across every live unit of the same
    // (art, themeColor) — see `vehicleTextureKey`/`_spawnKind` above — so `e.key` here names a
    // texture set that other still-living siblings may be actively rendering from. Removing it on
    // this one enemy's death would break (or texture-glitch) every sibling still pointing at it.
    // The set of distinct (kind, theme) combinations is small and bounded by ENEMY_KINDS (not by
    // spawn count), so — same as `buildBaseTextures`'s boot-time textures, which are also never
    // removed — the correct fix is to just let these persist for the scene's lifetime rather than
    // try to reference-count them. (Checked: there's no per-instance reskin/theme-swap mechanic
    // for vehicles — `_resetEnemies` explicitly skips a texture rebuild for non-mech kinds — so
    // there's no legitimate case where a live vehicle's shared texture ever needs to be replaced
    // out from under it.)
    if (e.kind !== 'mech') return;
    const suffixes = ['hull_0', 'hull_1', 'hull_2', 'hull_3', 'turret', 'leftTorso', 'rightTorso', 'leftArm', 'rightArm'];
    for (const s of suffixes) {
      const key = `${e.key}_${s}`;
      if (this.textures.exists(key)) this.textures.remove(key);
    }
  },

  // #87 (corrected per playtest 2026-07-10): remove a destroyed enemy IMMEDIATELY, in the same
  // tick its kill registers — a frozen corpse sitting around for a beat before cleanup read as
  // "horrible and looks dumb." combat.js `_damageEnemyAt` now calls this synchronously (no
  // `delayedCall`) right after firing the size-scaled death explosion, so the corpse vanishes
  // the instant the explosion reads. Reuses #71's `_destroyEnemy` teardown (view + generated
  // textures), then prunes the entry out of `this.enemies` so nothing keeps iterating a dead
  // unit. Still guarded by an indexOf lookup in case of a stray double-call.
  _removeEnemy(e) {
    const idx = this.enemies.indexOf(e);
    if (idx === -1) return;
    this._destroyEnemy(e);
    this.enemies.splice(idx, 1);
  },

  // Debug (#28): flip enemy movement or firing on/off and toast the new state.
  _toggleAi(which) {
    if (which === 'move') this.enemyMove = !this.enemyMove;
    else this.enemyFire = !this.enemyFire;
  },

  // ── Enemy AI update loop ────────────────────────────────────────────────────────────
  _updateEnemies(dt, delta) {
    this.registry.set('aiMove', this.enemyMove);
    this.registry.set('aiFire', this.enemyFire);
    for (const e of this.enemies) this._updateEnemy(e, dt, delta);
    const alive = this.enemies.filter((e) => !e.mech.isDestroyed()).length;
    // #87: dead enemies are pruned out of `this.enemies` the SAME tick they die, so the array
    // length alone no longer reflects the stage's squad size — use the running spawn counter for
    // the HUD's "total" side (`_enemiesSpawnedThisStage`, reset per stage in ArenaScene.create /
    // run.js _startNextStage) and fall back to the array length if it's somehow unset.
    this.registry.set('enemyCount', this._enemiesSpawnedThisStage ?? this.enemies.length);
    this.registry.set('enemiesAlive', alive);
  },

  // ── Fire-cue throttle (#200, extended by its reopen follow-up) ────────────────────────
  // Per-weapon-id gate shared by both enemy fire paths below (the mech loop's readyWeapons
  // firing + _fireVehicleWeapon). Keyed by weapon id, not per-enemy, so a turret cluster
  // (#145) or drone swarm sharing one weapon collapses to a single fire-cue train instead of
  // stacking simultaneous cues.
  //
  // The original #200 fix only gated how often a NEW cue schedule could START (SOUND_THROTTLE_MS
  // apart) — it said nothing about how long that schedule's own tail of sub-shot retriggers
  // keeps emitting cues afterward (scheduleFireCues/fireCues.js: a burst weapon like Pulse Laser
  // retriggers Audio.fire for each of its 5 pulses, ~300ms total). Jackson's playtest report
  // ("especially with drones... eventually sounds stop and never resume") traces to exactly
  // this gap: 18 drones (enemyKinds.js SWARM_SIZE) all mount pulseLaser and fire on their own
  // 260ms cadence, desynced — comfortably far enough apart to each pass the old 50ms gate, but
  // close enough together that their ~300ms retrigger tails overlap and stack. That multiplies
  // the ACTUAL audio-node creation rate for one weapon id several times past the one-cue-per-
  // window the throttle promised, which is what was overwhelming the Web Audio graph under
  // sustained swarm fire.
  //
  // Fix: fold the weapon's OWN burst span into the busy window — a fresh trigger is only
  // accepted once the PREVIOUS one's last sub-shot would have finished playing, plus the usual
  // gap, so at most one burst train per weapon id is ever in flight system-wide.
  _allowEnemyFireCue(weaponId, plan) {
    const at = (this._enemyFireSoundAt ??= {});
    const now = this.time.now;
    if ((at[weaponId] ?? -Infinity) > now) return false;
    let span = 0;
    for (const s of plan.shots) if (s.delay > span) span = s.delay;
    at[weaponId] = now + span + SOUND_THROTTLE_MS;
    return true;
  },

  // #285 ("units at a base shouldn't all snap to AWARE in the same frame"): whether `e` should
  // run its full tactical engagement (movement brain, turret tracking, locking, firing) THIS
  // frame. `e.awareness` itself still flips to AWARE synchronously the instant `_wakeBase`
  // processes it (bases.js) — that part is unchanged and stays a clean one-way transition other
  // systems (win condition, HUD, tests) can key off immediately. What's new is `e.reactDelayMs`:
  // a short randomized "still noticing" delay `_wakeBase` also stamps onto the unit alongside
  // the awareness flip (see its comment for the exact range + reasoning), counted down here
  // every frame the unit is AWARE, the same delta-countdown convention `e.decideAt`/`e.deployCd`
  // already use elsewhere in this file. While it's still counting down the unit is AWARE but not
  // yet "reacting" — every call site below that used to gate real engagement on `aware` now
  // gates on `reacting` instead, so the unit spends that brief window doing exactly what an
  // UNAWARE unit does (idle-loiter, no turret tracking, no firing) before its tactical brain
  // actually kicks in. Units with no `reactDelayMs` at all (patrol spawns, `_resupplyDock`'s
  // direct-to-AWARE units, or any unit that was already AWARE before this system existed) react
  // immediately, same as before this change.
  _isReacting(e, delta) {
    if (e.awareness !== AWARE) return false;
    if (e.reactDelayMs == null) return true;
    e.reactDelayMs -= delta;
    if (e.reactDelayMs > 0) return false;
    e.reactDelayMs = null;
    return true;
  },

  _updateEnemy(e, dt, delta) {
    // #87: a dead enemy is torn down and pruned out of `this.enemies` the same tick it dies (see
    // `_removeEnemy`), so in practice this guard is now belt-and-suspenders — nothing in
    // `this.enemies` should ever be destroyed-but-still-present. Kept for safety against any
    // caller that damages an enemy without going through the standard kill path.
    if (e.mech.isDestroyed()) return;
    // #269 §4: a DORMANT docked unit (scenes/arena/bases.js `_spawnDormantUnits`) is genuinely
    // inert until its base is woken (`_wakeBase`) — skip ALL per-frame AI/movement/firing, for
    // both mech and non-mech kinds alike. Unlike UNAWARE (below), which still runs idle-wander,
    // a dormant unit does nothing at all: no movement, no turret slew, no firing. #269 playtest
    // follow-up ("enemies should also wake on player proximity"): it STILL gets one cheap
    // distance-only check (`_maybeProximityWake`, bases.js) so a unit the player walks right up
    // to wakes even with no alert tower involved — not full AI ticking, just a `Math.hypot`.
    if (e.awareness === DORMANT) { this._maybeProximityWake(e); return; }
    // #68: non-mech kinds run their own simple per-kind brain + integrate/render path.
    if (e.kind !== 'mech') { this._updateVehicle(e, dt, delta); return; }
    const mv = e.mech.movement;
    const dxp = this.px - e.x, dyp = this.py - e.y;
    const dist = Math.hypot(dxp, dyp) || 1;
    const bearing = Math.atan2(dyp, dxp);           // from enemy → player
    const ux = dxp / dist, uy = dyp / dist;

    // Line-of-sight to the player (needed both for awareness detection below and the firing gate
    // further down). #72: each endpoint's own soft-cover hex is transparent — a player standing
    // in forest is seen (and hittable), and an enemy inside forest can see/shoot out. #167: this
    // was the top game-logic CPU cost run raw per mech per frame — now a STAGGERED CACHE
    // (`_cachedLosToPlayer`, ~120ms per-enemy refresh) so the expensive raycast runs ~8x less
    // often; the value is exact at each refresh and feeds awareness, the lock, and firing alike.
    const los = this._cachedLosToPlayer(e, delta, e.x, e.y, bearing, dist, this.px, this.py, isSmallUnit(e));

    // #103 awareness: an UNAWARE enemy hasn't noticed the player yet — it idles near its spawn
    // point rather than engaging. It flips to AWARE (permanently, for the rest of the encounter)
    // the moment it's seen (in detection range + LOS) or hears the player fire nearby.
    if (e.awareness !== AWARE) {
      const noiseLive = this._lastFireAt != null && this.time.now - this._lastFireAt < NOISE_WINDOW_MS;
      const noiseDist = noiseLive ? Math.hypot(this._lastFireX - e.x, this._lastFireY - e.y) : null;
      if (shouldBecomeAware(e.awareness, { dist, detectRange: e.detectRange, hasLos: los, noiseDist })) {
        e.awareness = AWARE;
      }
    }
    const aware = e.awareness === AWARE;
    // #285: `reacting` is `aware` PLUS "the short post-wake noticing delay has elapsed" — see
    // `_isReacting` for the stagger mechanism. Every gate below that used to key off `aware` for
    // actual engagement (movement brain, turret tracking, locking, firing) now keys off
    // `reacting` instead, so a freshly-woken unit briefly still idles (same as a genuinely
    // UNAWARE one) before its tactical brain actually kicks in — `aware` itself still flips the
    // instant the unit is detected, unchanged.
    const reacting = this._isReacting(e, delta);

    if (this.enemyMove) {
      // Track incoming damage: any drop in lethal health opens a "prefer cover" window.
      const hp = lethalHealth(e.mech);
      if (hp < e.lastHealth - 0.001) e.hurtUntil = this.time.now + COVER_DAMAGE_WINDOW;
      e.lastHealth = hp;

      let mx, my;
      if (!reacting) {
        // Idle/patrol (also covers the brief post-wake stagger window, #285): loiter near the
        // spawn point instead of running the tactical brain.
        ({ mx, my } = this._idleMoveIntent(e, delta));
      } else {
        // Re-decide on a cadence timer (or immediately after arriving at a goal). Between
        // decisions the enemy commits to its current state, so behaviour reads deliberately.
        // #269 Part 1 / #285: a woken docked mech (`e.holdGround`, see scenes/arena/bases.js
        // `_wakeBase`'s comment on why EVERY mech defaults to holdGround, regardless of
        // chassis/role) runs this exact SAME decision machine and movement intent as a
        // non-held mech — it actively presses/flanks/kites like normal, fully committing to the
        // player with no distance clamp (the leash that used to sit here was removed per #285).
        e.decideAt -= delta;
        e.recampAt -= delta;   // all-indirect camp-hold timer (see _decideEnemyState)
        const arrived = e.goal && Math.hypot(e.goal.x - e.x, e.goal.y - e.y) < ARRIVE_SLOW;
        if (e.decideAt <= 0 || (REPICK_ON_ARRIVE && arrived && (e.state === 'flank' || e.state === 'cover'))) {
          this._decideEnemyState(e, dist, bearing, hp);
          // #72 leash bookkeeping: only a COVER commitment keeps its camp timer; anything else
          // clears it so the next stint behind cover starts a fresh leash.
          if (e.state !== 'cover') e.coverSpot = null;
          e.decideAt = rand(DECIDE_MIN, DECIDE_MAX);
        }
        // Resolve the current state into a movement-intent vector (mx, my), roughly unit length.
        ({ mx, my } = this._enemyMoveIntent(e, dist, bearing, ux, uy));
      }

      // #45: backing away (relative to turret facing) is slower.
      const backScale = backwardSpeedScale(mx, my, e.turret);
      // Ease to a stop near a point goal so the enemy doesn't jitter on top of it.
      let speedFrac = reacting ? MOVE_SPEED_FRAC : MOVE_SPEED_FRAC * IDLE_SPEED_FRAC;
      const goal = reacting ? e.goal : e.idleGoal;
      if (goal) {
        const gd = Math.hypot(goal.x - e.x, goal.y - e.y);
        if (gd < ARRIVE_SLOW) speedFrac *= clamp(gd / ARRIVE_SLOW, 0, 1);
      }
      // #41: rough terrain (river/forest/rubble) under the enemy slows it too, same data-driven factor.
      const terrainScale = this._speedFactorAt(e.x, e.y);
      const spd = mv.maxSpeed * speedFrac * backScale * terrainScale;
      e.vx = approach(e.vx, mx * spd, mv.accel * dt);
      e.vy = approach(e.vy, my * spd, mv.accel * dt);
      let nx = e.x + e.vx * dt, ny = e.y + e.vy * dt;
      // #282: an enemy mech is always a LARGE ground unit (isSmallUnit(e) is false for the
      // 'mech' kind — see #269's unitSize), so it always also respects the mutual ground-unit
      // collision check below, alongside the existing terrain `_blocked` check — an enemy mech
      // can no longer walk through another large enemy (mech/quadruped/turret) or the player.
      // (Small units still never block a large one — see `_blockedByOtherGroundUnit`'s comment.)
      const blocked = (x, y) => this._blocked(x, y) || this._blockedByOtherGroundUnit(e, x, y);
      if (blocked(nx, ny)) {
        if (!blocked(e.x + e.vx * dt, e.y)) { ny = e.y; e.vy = 0; }
        else if (!blocked(e.x, e.y + e.vy * dt)) { nx = e.x; e.vx = 0; }
        else { nx = e.x; ny = e.y; e.vx = e.vy = 0; }
        // Bumped a wall (or another unit) while pathing to a goal — abandon it so we re-plan promptly.
        if (reacting && e.goal) e.decideAt = Math.min(e.decideAt, 200);
      }
      e.x = nx; e.y = ny;
    } else {
      e.vx = approach(e.vx, 0, mv.accel * dt); e.vy = approach(e.vy, 0, mv.accel * dt);
    }

    // Aim turret + face travel. While UNAWARE (or still in the brief post-wake stagger window,
    // #285) the turret doesn't track the player — it just follows the idle travel direction, so
    // the enemy reads as patrolling/still-noticing rather than watching a player it hasn't
    // (yet) reacted to.
    if (reacting) e.turret = rotateToward(e.turret, bearing, mv.turretSlew, dt);
    else if (Math.hypot(e.vx, e.vy) > 5) e.turret = rotateToward(e.turret, Math.atan2(e.vy, e.vx), mv.turretSlew, dt);
    // #269 Part 1: a held-ground mech runs the same movement brain as a normal one so it's
    // usually in motion and the ordinary "turn to face travel direction" rule below already
    // applies fine. It can still occasionally sit still while holding (e.g. 'hold'/camped-
    // 'cover' states resolve to a zero intent) — in exactly that stationary case, once it's
    // actually reacting, face the player directly rather than holding whatever heading it
    // happened to stop at, same "don't read as dead while stopped" fix the tank kind's own
    // holdGround branch established.
    if (e.holdGround && reacting && Math.hypot(e.vx, e.vy) <= 5) e.angle = rotateToward(e.angle, bearing, mv.turnRate, dt);
    else if (Math.hypot(e.vx, e.vy) > 5) e.angle = rotateToward(e.angle, Math.atan2(e.vy, e.vx), mv.turnRate, dt);

    // This enemy's indirect-fire lock ON the player (#62, rework #252) — only meaningful once
    // it's actually reacting; a not-yet-reacting (or unaware) enemy has no business tracking the
    // player at all.
    if (reacting) this._updateEnemyLock(e, dist, bearing);

    // Fire ready weapons at the player (gated by #28, and by #103/#285 reacting — an unaware or
    // still-noticing enemy never fires). Direct-fire weapons need current LOS. An indirect-fire
    // weapon (homing/arcing) fires straight through cover (#62/#44, rework #252; playtest
    // follow-up #252 dropped the old dead-reckoned "blind fire" — it now just tracks the
    // player's LIVE position, no LOS needed) whenever this enemy has a target at all (no
    // charge-up wait, no maintain-timer expiry — see `_updateEnemyLock` below).
    if (this.enemyFire && reacting) for (const w of e.mech.readyWeapons()) {
      let cd = (e.fireCd[w.location] ?? 0) - delta;
      const inRange = dist < (w.weapon.range.max || 300) * 1.05;
      const indirect = isIndirectWeapon(w.weapon);
      const canFire = inRange && (los || (indirect && hasLock(e.lock)));
      // #153: fire along the turret's actual current rendered angle (`e.turret`), NOT the
      // idealized lead-the-player line `_enemyFireAngle` computes. `e.turret` only slews
      // toward the player's bearing (or the plain idle-travel direction, see above) at
      // `turretSlew` rad/s regardless of LOS, so a shot fired while it's still mid-rotation now
      // travels where the gun art is actually pointing — matching the muzzle position math below
      // (`partMuzzle` also keys off `e.turret`) — and can genuinely miss a target that out-turned
      // it. `_enemyFireAngle`'s lead-prediction math is intentionally left uncalled here now; it
      // no longer influences the fired shot.
      const aim = e.turret;
      if (cd <= 0 && canFire) {
        e.mech.consumeAmmo(w.location, w.index, 1);
        const aimErr = (Math.random() - 0.5) * 0.12;
        // #109: a real per-location muzzle (same math as the player's `_muzzle`), keyed off
        // which body location actually mounts this weapon — not a fixed near-centre offset.
        const disp = ARENA_MECH_SCALE * ART_SCALE;
        const part = mechLayout(e.mech)[w.location];
        // #233: spawn from the weapon art's actual muzzle tip, not the part's bare front edge.
        const tipOffset = mechMuzzleTipOffset(e.mech, w.location, part);
        const { x: mx2, y: my2 } = partMuzzle(part, e.x, e.y, e.turret, disp, tipOffset);
        const fireAngle = aim + aimErr;
        // #117: route through the SAME delivery-type decision the player's fireWeapon makes
        // (planEmissions), instead of unconditionally spawning a travelling projectile — a
        // hitscan weapon (Beam Laser) now resolves as an instant beam via _fireHitscan, and a
        // contact/melee weapon via _melee, both with owner: 'enemy' so damage lands on the
        // player. Only genuinely projectile weapons still spawn a travelling round.
        const plan = planEmissions(w.weapon);
        // #200: enemies landed hits with an impact sound (combat.js, owner-agnostic) but never
        // played a FIRE cue of their own — scheduleFireCues was only ever called from the
        // player's fireWeapon (firing.js). Reuse the same shared scheduler here so enemy shots
        // get the same t=0 fire cue + burst retriggers + trajectory beat. Throttled per weapon
        // id via _allowEnemyFireCue (see its comment above — folds the weapon's own burst span
        // into the busy window) so a turret cluster or drone swarm sharing a weapon never stacks
        // overlapping fire-cue trails.
        if (this._allowEnemyFireCue(w.weapon.id, plan)) {
          // #264: real positional audio — the firer's actual muzzle position vs. the
          // player's (the listener) drives distance falloff + stereo pan, replacing the old
          // flat ENEMY_FIRE_GAIN_SCALE approximation (see fireCues.js's header comment).
          scheduleFireCues(this, w.weapon, plan, true, 1, { x: mx2, y: my2, listenerX: this.px, listenerY: this.py });
        }
        // #269 playtest follow-up (helicopter Repeater streams bug): dispatch EVERY emission in
        // `plan.shots`, not just one — see `_fireEnemyShots`'s header comment for the root cause
        // this fixes (this call site used to fire only shots[0], silently dropping a multi-
        // stream/spread/burst weapon's other lanes for every enemy mech kind).
        this._fireEnemyShots(w, plan, mx2, my2, fireAngle, e);
        cd = this._fireInterval(w.weapon, {});   // #60: enemies don't get player buffs (identity mods)
      }
      e.fireCd[w.location] = Math.max(0, cd);
    }
    e.mech.regenAmmo(dt);
    // #246: mech-kind enemies with no `shield` config in data/enemies.js are a no-op tick
    // (shield.max stays 0) — same as the vehicle path above.
    e.mech.tickShield(dt);

    e.view.setPosition(e.x, e.y);
    e.view.hull.rotation = e.angle + Math.PI / 2;
    e.view.turret.rotation = e.turret + Math.PI / 2;
    // Place + rotate all four pivoting parts each frame at the enemy's turret facing, tilt 0.
    this._syncTilts(e.view, e.mech, e.turret, ARENA_MECH_SCALE, 0, 0, {}, dt);
  },

  // ── Non-mech unit update (#68) ────────────────────────────────────────────────────────
  // Run one non-mech enemy: compute the per-frame basics, call its kind behavior (which sets
  // vx/vy + angle/turret and may fire), integrate position (with wall collision UNLESS it flies),
  // then sync the hull/turret/shadow sprites. The behavior registry keeps this free of any
  // `=== 'tank'` branching — the brain is chosen by def.behavior.
  _updateVehicle(e, dt, delta) {
    // #246: passive shield regen (with its brief post-hit pause) for kinds configured with one
    // (enemyKinds.js `shield`) — a no-op for the majority that have none (shield.max stays 0).
    e.mech.tickShield(dt);
    // #115: a ground unit (infantry/tank/turret) should never be sitting on off-map/impassable
    // terrain to begin with — the per-frame integration below already blocks it from MOVING
    // there, but this recovers one that somehow ended up there anyway (a bad spawn placement
    // predating the #114/#115 spawn-time validation, or terrain that shrank/shifted under it),
    // snapping it back onto the nearest valid ground rather than leaving it permanently stranded
    // outside the playable area. Flyers are exempt — they narratively ignore ground terrain.
    if (!e.flying && this._blocked(e.x, e.y)) {
      const p = nearestValidPixel(this.terrain, this.worldRadius, e.x, e.y);
      e.x = p.x; e.y = p.y; e.vx = 0; e.vy = 0;
    }
    const dxp = this.px - e.x, dyp = this.py - e.y;
    const dist = Math.hypot(dxp, dyp) || 1;
    const bearing = Math.atan2(dyp, dxp);
    const ux = dxp / dist, uy = dyp / dist;
    const ctx = { dt, delta, dxp, dyp, dist, bearing, ux, uy };

    // #103 awareness: distance-only detection (+ noise) for non-mech kinds — deliberately
    // simpler than the mech path's LOS check, since these often spawn in numbers (drone swarms,
    // turret nests) and a per-unit wall raycast every frame for all of them would add up.
    if (e.awareness !== AWARE) {
      const noiseLive = this._lastFireAt != null && this.time.now - this._lastFireAt < NOISE_WINDOW_MS;
      const noiseDist = noiseLive ? Math.hypot(this._lastFireX - e.x, this._lastFireY - e.y) : null;
      if (shouldBecomeAware(e.awareness, { dist, detectRange: e.detectRange, noiseDist })) {
        e.awareness = AWARE;
      }
    }
    // #285: same `reacting` stagger gate as the mech path (_updateEnemy) — see `_isReacting`'s
    // comment for the mechanism. `aware` flips the instant the unit is detected; `reacting`
    // additionally waits out the unit's short post-wake "still noticing" delay, if any.
    const reacting = this._isReacting(e, delta);

    const behavior = ENEMY_BEHAVIORS[e.behavior];
    if (!reacting) {
      // Idle (also covers the brief post-wake stagger window, #285): loiter near spawn rather
      // than running the kind's tactical brain (which also gates firing, since aimAndFire lives
      // inside each behavior fn — a not-yet-reacting unit never fires).
      const mv = e.kindDef.move;
      if (mv.maxSpeed > 0) {
        const { mx, my } = this._idleMoveIntent(e, delta);
        e.vx = approach(e.vx, mx * mv.maxSpeed * IDLE_SPEED_FRAC, mv.accel * dt);
        e.vy = approach(e.vy, my * mv.maxSpeed * IDLE_SPEED_FRAC, mv.accel * dt);
        if (Math.hypot(e.vx, e.vy) > 5) e.angle = Math.atan2(e.vy, e.vx);
      } else {
        e.vx = approach(e.vx, 0, (mv.accel || 200) * dt); e.vy = approach(e.vy, 0, (mv.accel || 200) * dt);
      }
    } else if (this.enemyMove || e.behavior === 'turret') {
      behavior(this, e, ctx);
    } else { e.vx = approach(e.vx, 0, (e.kindDef.move.accel || 200) * dt); e.vy = approach(e.vy, 0, (e.kindDef.move.accel || 200) * dt); }

    // Integrate. Flyers pass over walls/water/forest/ground-units (unchanged, #92); ground units
    // collide + slide like a mech. #282: mutual ground-unit collision layers on top of the
    // existing terrain `_blocked` check for BOTH size tiers now — a LARGE ground unit
    // (isSmallUnit(e) false: quadruped/turret) can't walk into another large enemy or the
    // player (unchanged); a SMALL unit (tank/infantry) now ALSO can't walk into another small
    // unit, or into a large one/the player — see `_blockedByOtherGroundUnit`'s comment (world.js)
    // for the full tier rule and the playtest report ("tanks nearly on top of one another") that
    // prompted extending small-vs-small collision. A flyer has NO movement gate at all: it moves
    // freely (ignoring terrain and ground units exactly as before), and flyer-vs-flyer overlap is
    // now handled as SOFT separation inside the flyer behaviours (enemyBehaviors.js
    // `flyerSeparation`) instead of a hard positional block — the old `_blockedByOtherFlyer` gate
    // gridlocked dense swarms, see #282's follow-up and that method's removed-comment in world.js.
    let nx = e.x + e.vx * dt, ny = e.y + e.vy * dt;
    if (!e.flying) {
      const blocked = (x, y) => this._blocked(x, y) || this._blockedByOtherGroundUnit(e, x, y);
      if (blocked(nx, ny)) {
        if (!blocked(e.x + e.vx * dt, e.y)) { ny = e.y; e.vy = 0; }
        else if (!blocked(e.x, e.y + e.vy * dt)) { nx = e.x; e.vx = 0; }
        else { nx = e.x; ny = e.y; e.vx = e.vy = 0; }
      }
    }
    // #41: ground units are slowed by rough terrain underfoot (same data-driven factor as mechs).
    if (!e.flying) {
      const tScale = this._speedFactorAt(e.x, e.y);
      nx = e.x + (nx - e.x) * tScale; ny = e.y + (ny - e.y) * tScale;
    }
    e.x = nx; e.y = ny;

    // Tick the weapon cooldown (a single per-unit timer; the kind's cadence lives in data).
    if (e.fireCd > 0) e.fireCd = Math.max(0, e.fireCd - delta);

    // #152: legged walk-cycle for a kind whose art builds multiple hull frames (def.legFrames —
    // currently just the Broodwalker/quadruped) — mirrors the player mech's stompy stepGait
    // (locomotion.js _stepGait): advance a per-enemy stepMs by actual ground speed (not a fixed
    // timer), and swap to the next hull frame each time it crosses the kind's own stepInterval,
    // so the gait speeds up/slows down with real motion and stops cycling when stationary.
    if (e.kindDef.legFrames) {
      const mv = e.kindDef.move;
      const speed = Math.hypot(e.vx, e.vy);
      if (speed > 5 && mv.stepInterval) {
        e.stepMs += dt * 1000 * (speed / mv.maxSpeed);
        if (e.stepMs >= mv.stepInterval) {
          e.stepMs -= mv.stepInterval;
          e.hullFrame = (e.hullFrame + 1) % e.kindDef.legFrames;
        }
      }
      e.view.hull.setTexture(`${e.key}_hull_${e.hullFrame}`);
    }

    // Render. Hull faces travel/hull-facing; turret faces its gun; flyers spin their rotor overlay
    // and float their shadow slightly offset so they read as airborne.
    e.view.setPosition(e.x, e.y);
    e.view.hull.rotation = e.angle + Math.PI / 2;
    if (e.kindDef.art === 'drone' || e.kindDef.art === 'helicopter') {
      e.rotorSpin += dt * (e.kindDef.art === 'drone' ? 40 : 26);
      e.view.turret.rotation = e.rotorSpin;                 // rotor overlay spins fast
    } else {
      e.view.turret.rotation = e.turret + Math.PI / 2;      // gun tracks the player
    }
    if (e.view.shadow) { e.view.shadow.x = 10; e.view.shadow.y = 16; }   // offset = "height" read
  },

  // #269 playtest follow-up: root cause of "helicopter Repeater fires a single stream even
  // though `weaponOverride.delivery.count: 2` (and, since #256, machineGun's own BASE delivery)
  // is set." Both enemy fire call sites (the mech-enemy loop above and `_fireVehicleWeapon`
  // below) resolved the weapon and called `planEmissions(weapon)` — same shared sim the PLAYER's
  // own `fireWeapon` (firing.js) uses — but then only ever spawned ONE round/beam/melee swing
  // from `plan`, ignoring every entry in `plan.shots` past the first. `planEmissions` returns one
  // shot object per parallel-stream lane (or spread-fan shot, or burst pulse); the player's
  // `fireWeapon` loops `for (const s of plan.shots)` and fires each one with its own
  // lateral/angleOffset/delay (firing.js) — the enemy paths never did, so a "2-stream" weapon
  // always visually read as a single stream/shot no matter what the data said, for EVERY multi-
  // shot enemy weapon, not just the helicopter. This helper mirrors firing.js's loop for an
  // enemy-owned shot: same lateral-offset perpendicular math, same delayed sub-shots for a
  // staggered spread/burst, dispatched to melee/hitscan/projectile by `plan.mode` exactly like
  // the single-shot call sites used to.
  _fireEnemyShots(w, plan, mx, my, fireAngle, e) {
    for (const s of plan.shots) {
      const go = () => {
        const baseAngle = fireAngle + s.angleOffset;
        const perp = baseAngle + Math.PI / 2;
        const ox = mx + Math.cos(perp) * s.lateral, oy = my + Math.sin(perp) * s.lateral;
        if (plan.mode === 'contact') {
          this._melee(w, ox, oy, baseAngle, 'enemy');
        } else if (plan.mode === 'hitscan') {
          // #245: a FLYING kind (drone/helicopter — enemyKinds.js `flying: true`) shoots from
          // above, so its shots ignore terrain cover entirely: the hitscan trace skips the wall
          // check and a spawned round is stamped `ignoresCover` (see firing.js/projectiles.js).
          // Ground kinds pass false and are blocked by cover exactly as before.
          this._fireHitscan(w, ox, oy, baseAngle, 'enemy', e.key, !!e.flying, isSmallUnit(e));
        } else {
          // No explicit seek target needed here (playtest follow-up #252 dropped the old
          // dead-reckoned blind-fire point): an enemy round with no seekOverride keeps its
          // intrinsic chase-the-player behaviour in _updateProjectiles (it re-reads the player's
          // LIVE position every frame), so it tracks straight through cover exactly the same
          // whether this shot had LOS or not. #245: a flying shooter's rounds also ignore terrain
          // cover in flight. `aimAngle` (the un-offset centre bearing, matching firing.js's own
          // `aimAngle` param) stays `fireAngle` for every sub-shot so a fanned/streamed weapon's
          // arcing maxDist test (see `_spawnProjectile`) reads the same centre line the player
          // path uses.
          this._spawnProjectile(w, ox, oy, baseAngle, 'enemy', s.angleOffset, null, fireAngle, !!e.flying, isSmallUnit(e));
        }
      };
      if (s.delay > 0) this.time.delayedCall(s.delay, go); else go();
    }
  },

  // Fire a non-mech unit's weapon at `aim` (its turret angle). The weapon comes from data
  // (resolveWeapon(def.weaponId, def.weaponOverride), #243) — NO weapon-id literal in this
  // file — wrapped as the {weapon,
  // location} shape _spawnProjectile expects. Enemy-owned round; cadence is the resolved
  // weapon's own fire interval (#241/#243 — no per-kind timer field).
  _fireVehicleWeapon(e, ctx, aim) {
    if (e.fireCd > 0) return;
    const def = e.kindDef;
    // #243: the kind's weapon is the shared base entry with its optional per-kind
    // `weaponOverride` delta merged on top (see resolveWeapon in data/weapons.js and the
    // field doc in enemyKinds.js) — the helicopter's single-lane Repeater is the live example. The
    // resolved weapon flows through EVERYTHING below: the emission plan, the fire-cue key,
    // the damage the spawned round carries, and #241's `_fireInterval` cadence fallback.
    const weapon = resolveWeapon(def.weaponId, def.weaponOverride);
    if (!weapon) return;
    const w = { weapon, location: e.kind, index: 0 };
    const aimErr = (Math.random() - 0.5) * 0.1;
    // #109: spawn from the kind's actual gun/barrel part (enemyKinds.js `muzzlePart`), not a
    // fixed 18px offset from the unit's centre — same real-muzzle math as mechs (partMuzzle).
    const part = def.parts[def.muzzlePart] ?? Object.values(def.parts)[0];
    const disp = vehicleScale(def) * ART_SCALE;
    // #233: `muzzleForward` (enemyKinds.js, design units) corrects for the gap between the
    // muzzle PART's own box edge and where that kind's hand-drawn gun/barrel art actually
    // ends, same fix as the mech mount art below.
    const { x: mx, y: my } = partMuzzle(part, e.x, e.y, aim, disp, def.muzzleForward ?? 0);
    const fireAngle = aim + aimErr;
    // #123: route through the SAME delivery-type decision the mech fire loop uses (#117), rather
    // than unconditionally spawning a travelling projectile — a hitscan weapon resolves as an
    // instant beam via _fireHitscan, a contact/melee weapon via _melee, both owner: 'enemy' so
    // damage lands on the player; only genuinely projectile weapons still spawn a travelling
    // round. No visible change today (every live kind loadout is hit: 'projectile') — proactive
    // hardening so a future hitscan/melee kind loadout renders correctly.
    const plan = planEmissions(weapon);
    // #200: same fire-cue gap as the mech enemy loop above — vehicle/non-mech kinds (turrets,
    // tanks, drones) never called scheduleFireCues, so they fired silently. Reuse the plan
    // already computed here, throttled per weapon id via _allowEnemyFireCue (see its comment
    // above the mech fire loop) so a turret cluster (#145) or drone swarm sharing a weapon id
    // never stacks overlapping fire-cue trails.
    if (this._allowEnemyFireCue(weapon.id, plan)) {
      // #264: same real positional audio as the mech enemy loop above.
      scheduleFireCues(this, weapon, plan, true, 1, { x: mx, y: my, listenerX: this.px, listenerY: this.py });
    }
    // #269 playtest follow-up (helicopter Repeater streams bug): dispatch EVERY emission in
    // `plan.shots`, not just one — see `_fireEnemyShots`'s header comment for the root cause
    // this fixes. #245: a FLYING kind (drone/helicopter — enemyKinds.js `flying: true`) still
    // shoots from above, ignoring terrain cover, exactly as before (threaded through the helper).
    this._fireEnemyShots(w, plan, mx, my, fireAngle, e);
    // Cadence is ALWAYS the RESOLVED weapon's own `_fireInterval` (the same resolution the
    // player/mech-enemy path uses; `{}` mods since vehicles have no player buffs/Overdrive) —
    // #241 introduced this as the fallback behind a per-kind `fireEveryMs` timer, and #243
    // removed that field entirely: a kind that wants a slower/faster cadence now tunes it in
    // the weapon's own terms through `weaponOverride` (cycleTime for single-shot weapons,
    // delivery.fireRate for streams — see enemyKinds.js's field docs), so one cadence concept
    // serves every fire path.
    e.fireCd = this._fireInterval(weapon, {});
    // #243 trigger discipline: a kind with `burstShots` fires N shots at the cadence above,
    // then RESTS — the shot that completes the burst swaps its cooldown for the (longer)
    // `burstRestMs` instead of the per-shot cadence, and the counter re-arms for the next
    // burst. Orthogonal to the cadence resolution above, which spaces the shots WITHIN a
    // burst; burstShots/burstRestMs bound how long a burst runs. Both fields absent (every
    // kind except helicopter today) ⇒ this whole block is a no-op and the unit fires
    // continuously exactly as before.
    if (def.burstShots > 0) {
      e.burstShotsFired = (e.burstShotsFired ?? 0) + 1;
      if (e.burstShotsFired >= def.burstShots) {
        e.burstShotsFired = 0;
        e.fireCd = def.burstRestMs ?? 1000;
      }
    }
  },

  // ── State selection ─────────────────────────────────────────────────────────────────
  // Choose the enemy's next tactical state from the situation: role, distance band, health,
  // LOS, and what the player is doing. This is the "brain"; _enemyMoveIntent then realises it.
  _decideEnemyState(e, dist, bearing, hp) {
    const tooClose = dist < e.standoff * TOO_CLOSE_FRAC;
    const tooFar = dist > e.standoff * TOO_FAR_FRAC;
    // #167: fresh (not cached) — state decisions run on the slow DECIDE_MIN/MAX cadence, not per
    // frame, so this wants a current read; still routed through the allocation-free raycast.
    const hasLos = this._wallDistanceLos(e.x, e.y, bearing, dist, this.px, this.py, isSmallUnit(e)) === Infinity;
    const hurt = hp < COVER_HEALTH_TRIGGER || this.time.now < e.hurtUntil;
    const now = this.time.now;

    // Player-reaction signals.
    const pspeed = Math.hypot(this.vx || 0, this.vy || 0);
    const fleeDot = pspeed > 8 ? (-(this.vx * Math.cos(bearing) + this.vy * Math.sin(bearing)) / pspeed) : 0;
    const playerFleeing = fleeDot > PLAYER_FLEE_DOT;         // moving away from this enemy
    const playerVulnerable = lethalHealth(this.mech) < PLAYER_VULN_HEALTH;
    // "Is the player aiming at me?" — player turret facing vs bearing from player to enemy.
    const toEnemy = Math.atan2(e.y - this.py, e.x - this.px);
    const trackDot = Math.cos(this.turretAngle - toEnemy);
    const beingTracked = trackDot > TRACKED_DOT && dist < e.standoff * 1.3;

    // 0) ARTILLERY posture (#44 follow-up): a mech whose whole loadout is indirect-fire never
    //    needs LOS to hit, so it CAMPS behind cover as its default — bombarding over walls and
    //    never willingly exposing itself. It holds one camp spot for a spell (recampAt), then
    //    hunts a fresh covered position; if no cover is reachable it just holds at standoff. It
    //    still opens the distance if the player crowds it (tooClose), staying an area denier.
    if (e.allIndirect) {
      if (tooClose) { e.state = 'kite'; e.goal = null; return; }
      // Already safely behind cover and its hold-timer hasn't elapsed → sit tight and shell —
      // #72 leash permitting: after COVER_LEASH_MS parked at the same camp, it MUST relocate.
      const behindCover = !hasLos;
      if (behindCover) e.coverSpot = trackCoverSpot(e.coverSpot, e.goal ?? { x: e.x, y: e.y }, now);
      const mustMove = coverLeashExpired(e.coverSpot, now);
      if (behindCover && e.recampAt > 0 && !mustMove) { e.state = 'cover'; return; }
      const cover = this._findCoverSpot(e, bearing, mustMove ? e.coverSpot : null);
      if (cover) {
        e.state = 'cover'; e.goal = cover; e.recampAt = rand(ARTY_RECAMP_MIN, ARTY_RECAMP_MAX);
        e.coverSpot = trackCoverSpot(e.coverSpot, cover, now);
        return;
      }
      // No (fresh) cover in reach → hold at standoff and keep lobbing (or advance if far out).
      e.state = tooFar ? 'press' : 'hold'; e.goal = null; return;
    }

    // 1) Hurt / under fire → break contact behind cover if any exists; else kite out. #72 leash:
    //    once it's sat at the same cover spot past COVER_LEASH_MS, that spot is excluded — it
    //    must displace to a DIFFERENT spot (or kite/advance if none is reachable).
    //    #212: but only while still IN the fight. Hp doesn't regenerate, so once an enemy is
    //    hurt it's hurt for the rest of the encounter — without this override it would commit
    //    to cover/kite forever and never re-close, so a hurt-but-still-AWARE enemy would look
    //    like it gave up pursuing the player entirely the moment the player moved on to
    //    something else. Cover/kite is the right call at engagement range; once the player has
    //    actually left it behind (tooFar), it needs to catch back up first, same as a healthy
    //    enemy would — it'll resume being cautious the next time it's back in range and hurt.
    if (hurt && !tooFar) {
      const mustMove = coverLeashExpired(e.coverSpot, now);
      const cover = this._findCoverSpot(e, bearing, mustMove ? e.coverSpot : null);
      if (cover) {
        e.state = 'cover'; e.goal = cover;
        e.coverSpot = trackCoverSpot(e.coverSpot, cover, now);
        return;
      }
      e.state = 'kite'; e.goal = null; return;
    }

    // 2) Distance-band overrides — get back into the fight ring first.
    if (tooClose && e.role !== 'brawler') { e.state = 'kite'; e.goal = null; return; }
    if (tooFar) { e.state = 'press'; e.goal = null; return; }

    // 3) Opportunistic press: a fleeing or wounded player invites a committed push (brawlers
    //    always lean this way). Don't over-close a sniper, though.
    if ((playerFleeing || playerVulnerable || e.role === 'brawler') && !tooClose && e.role !== 'sniper') {
      e.state = 'press'; e.goal = null; return;
    }

    // 4) Being visibly tracked → juke: pick a fresh flank goal (often flipping side) to spoil
    //    the player's aim rather than holding a predictable line.
    if (beingTracked && Math.random() < TRACKED_BREAK_CHANCE) {
      if (Math.random() < 0.5) e.handed *= -1;   // sometimes reverse orbit direction
      e.state = 'flank'; e.goal = this._flankGoal(e, bearing); return;
    }

    // 5) No LOS on the player → reposition to a spot that has a firing lane.
    if (!hasLos) { e.state = 'flank'; e.goal = this._flankGoal(e, bearing); return; }

    // 6) Default: mostly FLANK (travel a new approach vector), occasionally HOLD and shoot
    //    from a good position. Snipers hold more (they want a stable firing line).
    const holdChance = e.role === 'sniper' ? 0.45 : 0.28;
    if (Math.random() < holdChance) { e.state = 'hold'; e.goal = null; }
    else { e.state = 'flank'; e.goal = this._flankGoal(e, bearing); }
  },

  // Pick a FLANK destination: a point at standoff range from the player, offset around the
  // player by a flank angle on the enemy's handedness. This makes enemies travel to distinct
  // off-axis spots (varying approach vectors) instead of holding a constant-radius orbit.
  _flankGoal(e, bearing) {
    const ang = rand(FLANK_ANGLE_MIN, FLANK_ANGLE_MAX) * e.handed;
    // Angle from the PLAYER out to the desired spot = (player→enemy bearing) rotated by `ang`.
    const outAng = bearing + Math.PI + ang;
    let gx = this.px + Math.cos(outAng) * e.standoff;
    let gy = this.py + Math.sin(outAng) * e.standoff;
    // Nudge the goal off blocked terrain by pulling it back toward the player until clear.
    for (let t = 0; t < 5 && this._blocked(gx, gy); t++) {
      gx = (gx + this.px) / 2; gy = (gy + this.py) / 2;
    }
    return { x: gx, y: gy };
  },

  // Search nearby hexes for a point that (a) is passable, (b) breaks LOS from the player to
  // that point (so the enemy is behind cover there), and (c) isn't absurdly far. Returns the
  // nearest such point, or null if no cover is reachable — real terrain reasoning via _isWall.
  // #72: a leash-expired camp spot is passed as `exclude` so the pick MUST differ; and the LOS
  // probe uses own-hex transparency, so standing INSIDE a soft-cover hex no longer counts as
  // cover (the hex wouldn't protect its occupant) — the spot must be BEHIND a blocking hex.
  _findCoverSpot(e, bearing, exclude = null) {
    const here = { q: 0, r: 0 };
    // Candidate hex centres within a few rings of the enemy.
    const cand = range(here, COVER_SEARCH_RING)
      .map((h) => {
        const c = hexToPixel(h.q, h.r);
        return { x: e.x + c.x, y: e.y + c.y };
      })
      .filter((p) => !this._blocked(p.x, p.y));
    let best = null, bestScore = Infinity;
    for (const p of cand) {
      if (exclude && Math.hypot(p.x - exclude.x, p.y - exclude.y) <= COVER_SPOT_RADIUS) continue;
      const d = Math.hypot(p.x - this.px, p.y - this.py);
      const ang = Math.atan2(p.y - this.py, p.x - this.px);
      // A spot is cover if the player's line of sight to it is broken by a wall before it
      // (own-hex transparency applied: neither endpoint's soft-cover hex counts, #72).
      const losBlocked = this._wallDistanceLos(this.px, this.py, ang, d, p.x, p.y, isSmallUnit(e)) < d - COVER_SEARCH_STEP;
      if (!losBlocked) continue;
      // Prefer near cover that keeps us in the fight (not driven to the map edge).
      const travel = Math.hypot(p.x - e.x, p.y - e.y);
      const rangePenalty = Math.abs(d - e.standoff) * 0.25;
      const score = travel + rangePenalty;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    return best;
  },

  // ── Movement realisation ────────────────────────────────────────────────────────────
  // Turn the current state into a movement-intent vector (mx, my), roughly unit length.
  _enemyMoveIntent(e, dist, bearing, ux, uy) {
    switch (e.state) {
      case 'press':  // close the gap; stop pressing once inside optimal so we don't faceplant.
        if (dist <= e.standoff * 0.8) return this._strafeIntent(e, ux, uy);
        return { mx: ux, my: uy };

      case 'kite':   // back away from the player while keeping LOS; sidestep a touch so it
                     // isn't a dead-straight retreat the player can walk down.
        return { mx: -ux * 0.85 - uy * 0.3 * e.handed, my: -uy * 0.85 + ux * 0.3 * e.handed };

      case 'flank':  // steer toward the flank/cover destination.
      case 'cover': {
        // An all-indirect bombardier with no goal is already camped — hold dead still and shell
        // over the wall (it never needs to expose). A direct-fire mech without a goal drifts.
        if (!e.goal) return e.allIndirect ? { mx: 0, my: 0 } : this._strafeIntent(e, ux, uy);
        const gx = e.goal.x - e.x, gy = e.goal.y - e.y;
        const gm = Math.hypot(gx, gy) || 1;
        // Near a COVER goal: a direct-fire mech peeks (leans toward the player to shoot); an
        // all-indirect bombardier stays tucked (no peek — it lobs/locks over the wall).
        if (e.state === 'cover' && gm < PEEK_DIST * 2) {
          return e.allIndirect ? { mx: 0, my: 0 } : { mx: ux * 0.4, my: uy * 0.4 };
        }
        return { mx: gx / gm, my: gy / gm };
      }

      case 'hold':   // hold position, a gentle strafe so we're not a static target.
      default:
        return this._strafeIntent(e, ux, uy);
    }
  },

  // A light lateral drift perpendicular to the player bearing (handedness = orbit side). Used
  // by HOLD / in-band PRESS so the enemy isn't a sitting duck without committing to a full orbit.
  _strafeIntent(e, ux, uy) {
    return { mx: -uy * e.handed * 0.6, my: ux * e.handed * 0.6 };
  },

  // #103: movement intent for an UNAWARE enemy — a light idle wander/loiter near its own spawn
  // point (not the player), so it reads as patrolling rather than frozen while it hasn't noticed
  // anything yet. Picks a fresh nearby waypoint on a slow cadence; holds still once it arrives
  // until the next re-pick.
  // #151: a unit whose kindDef marks `avoidWater` (currently infantry only — see enemyKinds.js)
  // never CHOOSES a water hex as this waypoint, on top of the existing impassable-terrain check.
  // It's still free to stand in/cross water if AWARE-state chase/advance drives it there directly
  // (that's not goal-picking — see _enemyMoveIntent/infantryBehavior); this only stops it from
  // voluntarily loitering in a river while patrolling.
  _idleMoveIntent(e, delta) {
    e.idleAt -= delta;
    const arrived = e.idleGoal && Math.hypot(e.idleGoal.x - e.x, e.idleGoal.y - e.y) < ARRIVE_SLOW;
    if (!e.idleGoal || e.idleAt <= 0 || arrived) {
      const avoidsWater = !!e.kindDef?.avoidWater;
      const isInvalid = (x, y) => this._blocked(x, y) || (avoidsWater && isWaterTerrain(this._terrainAt(x, y)));
      e.idleGoal = pickWanderGoal(e.spawnX, e.spawnY, IDLE_WANDER_RADIUS, isInvalid);
      e.idleAt = rand(IDLE_REPICK_MIN, IDLE_REPICK_MAX);
    }
    const gx = e.idleGoal.x - e.x, gy = e.idleGoal.y - e.y;
    const gm = Math.hypot(gx, gy);
    if (gm < 2) return { mx: 0, my: 0 };
    return { mx: gx / gm, my: gy / gm };
  },

  // Advance an enemy's indirect-fire lock ON the player (#62/#44, rework #252). Mirrors the
  // player's lock, which is simply whatever weapon convergence currently has selected — for an
  // enemy there's only ever one possible target (the player), so its "convergence" is trivial:
  // the player IS the target whenever in range, with no charge-up wait and no maintain-timer
  // expiry (matching the player's own convergence, which has no LOS gate or decay in its
  // selection either — see targeting.js `_updateLock`). Playtest follow-up (#252): LOS no longer
  // gates anything here either — an all-indirect mech can camp behind cover and bombard the
  // player's LIVE position indefinitely (as long as it stays in range), no need to peek for a
  // fix first; the old dead-reckoned "blind fire" fallback is gone (see targetlock.js).
  _updateEnemyLock(e, dist, bearing) {
    const LOCK_RANGE = 700;   // px within which an enemy can target the player at all
    // The player as a STABLE target handle for the shared state machine (one per enemy, mutated
    // in place so `target !== lock.target` correctly reads "no change" across frames rather than
    // "a fresh acquisition" every frame). Carries `.mech` (destroyed check) + live position/velocity.
    const player = e.playerTarget ??= { mech: this.mech, x: 0, y: 0, vx: 0, vy: 0 };
    player.mech = this.mech; player.x = this.px; player.y = this.py;
    player.vx = this.vx || 0; player.vy = this.vy || 0;
    const target = dist <= LOCK_RANGE ? player : null;
    stepLock(e.lock, { target });
  },

  // Firing aim with a simple lead: aim where the player will be by the time a projectile
  // arrives (hitscan/contact → no lead, since both now actually resolve instantly via
  // _fireHitscan/_melee — see #117). Keeps the existing small aim error at the call site.
  _enemyFireAngle(e, w, dxp, dyp, dist) {
    const d = w.weapon.delivery;
    const vel = (d.hit === 'hitscan' || d.hit === 'contact') ? 0 : (d.velocity || 0);
    if (vel <= 0) return Math.atan2(dyp, dxp);
    const t = dist / vel;
    const lx = this.px + (this.vx || 0) * t, ly = this.py + (this.vy || 0) * t;
    return Math.atan2(ly - e.y, lx - e.x);
  },
};
