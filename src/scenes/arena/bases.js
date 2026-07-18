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
import { DORMANT, AWARE, shouldBecomeAware } from '../../data/awareness.js';
import { makeAlertState, tickAlertTower, ALERT_DETECT_RADIUS } from '../../data/alertTower.js';
import { nearestBaseTo, isFastWakeKind } from '../../data/bases.js';
import { isEnemyKind } from '../../data/enemyKinds.js';
import { DEPTH, strokeHexRing } from './shared.js';
import { Audio } from '../../audio/index.js';
import { nearestValidPixel } from '../../data/spawnPlacement.js';
import { makeDockResupplyState, tickDockResupply, spendDockResupply } from '../../data/dockResupply.js';
import { HEX_LABEL_COLOR, HEX_LABEL_FONT_SIZE, HEX_LABEL_FONT_STYLE } from './hexLabelStyle.js';
import { isBaseObjectiveDestroyed } from './mission.js';
import { getTerrain, buildingHp as terrainBuildingHp } from '../../data/terrain.js';

// #269 playtest follow-up ("sensor towers need a visual AND a noise to indicate they are
// spooling up") — the live escalating ring drawn over a counting-down alert tower. Colour
// mirrors the baked beacon light itself (hexArt.js `hex_alertTower`'s 0xff6a3a beacon), so the
// live FX reads as "the same light, now agitated" rather than an unrelated UI colour.
const ALERT_RING_COLOR = 0xff6a3a;
// Ring radius/alpha at fraction 0 (just started) and fraction 1 (about to trigger) — grows and
// brightens as the countdown nears completion, same "escalating" idea the issue asks for.
const ALERT_RING_RADIUS_MIN = 14;
const ALERT_RING_RADIUS_MAX = 34;
const ALERT_RING_ALPHA_MIN = 0.35;
const ALERT_RING_ALPHA_MAX = 0.95;

// #269 playtest follow-up — the audio pulse's re-trigger interval (ms) shrinks from
// ALERT_PULSE_INTERVAL_MIN..MAX as `fraction` climbs, so the BEEP RATE itself quickens on top
// of alertPulse's own per-call pitch/brightness rise (audio/sfx.js). 520ms at fraction 0 reads
// as a slow, deliberate "something is scanning"; 120ms near fraction 1 reads as a frantic
// about-to-happen alarm.
const ALERT_PULSE_INTERVAL_MAX_MS = 520;
const ALERT_PULSE_INTERVAL_MIN_MS = 120;

// #269 playtest follow-up (patrol units): kind + headcount for the roaming units stationed near
// each alert tower. Deliberately modest — a light escort/defense presence for the tower, not
// another base-sized encounter — so a single cheap `infantry` trooper per tower (the smallest,
// weakest kind in the game, see enemyKinds.js) rather than a tank/drone squad. Infantry's own
// idle-wander already has an existing avoidWater/lumbering-mob feel tuned for exactly this "a
// trooper loiters near a fixed point" behavior, so it reuses that machinery for free.
export const TOWER_PATROL_KIND_ID = 'infantry';
export const TOWER_PATROL_COUNT = 1;

// #269 playtest follow-up (hex legibility): a base/tower hex's dormant unit or small art icon
// alone doesn't read clearly as "this is a dock/alert tower/turret emplacement" during playtest
// — a persistent red text tag above the hex makes it unambiguous at a glance. Deliberately
// plain/loud (bright red, monospace) rather than styled like the amber objective marker
// (mission.js `_makeObjectiveMarker`) — these are a debug-readable tag, not a wayfinding beacon,
// so they shouldn't compete visually with the real objective marker. #270 playtest follow-up:
// dev-only (see ArenaScene.js's `import.meta.env.DEV` gate around `_spawnHexLabels()`) — this
// was always a playtest legibility aid, never meant to ship in production. Color/size/weight
// come from hexLabelStyle.js, shared with terrainLabels.js so the two label systems can't
// drift into two different looks again.
const HEX_LABEL_TEXT = { dock: 'DOCK', alertTower: 'ALERT TOWER', turretEmplacement: 'TURRET', objective: 'OBJECTIVE' };

// #269 playtest follow-up (dock composition): how far apart a multi-unit dock's units (2-3
// tanks, 2 helicopters — see data/worldgen.js `dockCountFor`) are scattered around their shared
// dock hex's centre pixel, so they don't all render exactly on top of one another. Mirrors
// enemies.js's `TURRET_HUDDLE_OFFSET` (10px) for the same "huddle, don't stack" idea, just a
// bit wider — tank/helicopter sprites (scale 0.4/0.6, both shrunk for this exact reason, see
// enemyKinds.js) read bigger on screen than a turret (scale 0.42), so they need more room to
// stay visually distinct as several units rather than reading as one blob.
const DOCK_HUDDLE_OFFSET = 16;

// #269 Part 2 ("dock open/closed states"): how close a dock's own live unit(s) (matched by
// `dockKey`) must stay to the dock's own pixel centre for the hex to still read as OCCUPIED. A
// DORMANT cluster sits within `DOCK_HUDDLE_OFFSET` (16px) of centre, well inside this; the
// moment a woken unit's hold-ground leash (`HOLD_GROUND_LEASH_PX`, shared.js — 320px) carries it
// meaningfully away to fight, or it dies, the dock reads as VACATED and closes. Deliberately
// bigger than the huddle scatter (so idle jitter never falsely triggers a close) but much
// smaller than the leash radius (so engaging the player reliably closes the dock almost
// immediately, matching the issue's "the dock closes once its units leave" framing). Owner:
// tunable via playtest.
const DOCK_VACATE_RADIUS_PX = 60;

export const BasesMixin = {
  // §4: spawn every base's docked units NOW, at deploy time, dormant — not lazily, not via the
  // old off-camera `_offscreenSpawnPoint`/squad system. Called once from ArenaScene.create(),
  // in place of the old `_spawnSquad()` opening-squad call.
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
  // Turret emplacements (`base.turrets`, their own dedicated `turretEmplacement` terrain hex —
  // never drawn from the dock kind pools) are spawned the same DORMANT way, one `turret` per
  // emplacement hex, tagged with the SAME base's `baseId` so they wake alongside that base's
  // docks and count toward the win condition (`_allBasesCleared`) exactly like a dock unit does.
  //
  // #269 §3 "rare multi-spawn exception" (playtest follow-up): also records, per DOCK hex only
  // (never a turret emplacement — see data/dockResupply.js's file header for why), the metadata
  // `_updateDockResupply` needs later — the dock's kind/position/owning base and a fresh
  // resupply state — in `this._dockResupplyMeta`/`this._dockResupplyStates`. Built here rather
  // than a separate pass since this loop already visits every dock exactly once.
  _spawnDormantUnits() {
    this._dockResupplyMeta = new Map();
    this._dockResupplyStates = new Map();
    for (const base of this.bases ?? []) {
      for (const dock of base.docks) {
        const { x, y } = hexToPixel(dock.q, dock.r);
        const count = dock.count ?? 1;
        const dockKey = axialKey(dock.q, dock.r);
        this._dockResupplyMeta.set(dockKey, { baseId: base.id, kindId: dock.kindId, x, y });
        this._dockResupplyStates.set(dockKey, makeDockResupplyState());
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2 + Math.PI / 4;
          const px = count > 1 ? x + Math.cos(a) * DOCK_HUDDLE_OFFSET : x;
          const py = count > 1 ? y + Math.sin(a) * DOCK_HUDDLE_OFFSET : y;
          // #269 playtest follow-up: a mech-kind dock (dockCountFor always returns 1 for a mech
          // id — the default branch, since mechs aren't tank/helicopter) goes through
          // `_spawnMech`; every other kind keeps using `_spawnKind` exactly as before.
          const e = isEnemyKind(dock.kindId) ? this._spawnKind(px, py, dock.kindId) : this._spawnMech(px, py, dock.kindId);
          // A DORMANT unit is genuinely inert (see enemies.js `_updateEnemy`'s early return on
          // this state) — never through UNAWARE's idle-wander first. `baseId`/`dockKey` are
          // how `_wakeBase` finds "every unit belonging to this base/dock" and are otherwise
          // unused.
          e.awareness = DORMANT;
          e.baseId = base.id;
          e.dockKey = dockKey;
          // #269 Part 1 (hold-ground leash): the dock's own centre pixel is this unit's home
          // anchor — see `leashIntent` (scenes/arena/shared.js) for how a woken hold-ground unit
          // uses this to stay near its dock instead of freezing OR chasing the player unbounded.
          // Stashed on every unit in the cluster (not just one), same as `dockKey`.
          e.homeX = x; e.homeY = y;
        }
      }
      for (const turret of base.turrets ?? []) {
        const { x, y } = hexToPixel(turret.q, turret.r);
        const e = this._spawnKind(x, y, 'turret');
        e.awareness = DORMANT;
        e.baseId = base.id;
        e.dockKey = axialKey(turret.q, turret.r);
        e.homeX = x; e.homeY = y;
      }
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
  // behavior for the patrol feel — no new patrol-route code needed — by simply setting the
  // unit's own spawn point to (a hex near) the tower's position. The alert tower hex itself is
  // `passable: false` (data/terrain.js), so units can't stand ON the tower's own hex; snapping
  // through `nearestValidPixel` (the same nearest-passable-hex primitive turret clusters/powerup
  // drops already use, data/spawnPlacement.js) finds the nearest passable ground hex next to it
  // instead. Called once from ArenaScene.create(), alongside `_spawnDormantUnits`.
  _spawnTowerPatrols() {
    for (const t of this.alertTowerHexes ?? []) {
      const { x: tx, y: ty } = hexToPixel(t.q, t.r);
      const { x, y } = nearestValidPixel(this.terrain, this.worldRadius, tx, ty);
      for (let i = 0; i < TOWER_PATROL_COUNT; i++) {
        this._spawnKind(x, y, TOWER_PATROL_KIND_ID);
      }
    }
  },

  // #269 playtest follow-up (hex legibility): one persistent red text tag per dock/alertTower/
  // turretEmplacement hex, positioned via `hexToPixel` — a STATIC world-space label (unlike
  // combat.js's `_floatText`, which fades/floats for hit numbers; this stays up the whole run,
  // same "persistent world-space thing pinned over a fixed hex" shape as mission.js's
  // `_makeObjectiveMarker`, just far simpler — no ring/tween, just the text). Called once from
  // ArenaScene.create(), alongside `_spawnDormantUnits`/`_initAlertTowers` above — all three run
  // right after `_buildWorld()` has populated `this.bases`/`this.alertTowerHexes`.
  _spawnHexLabels() {
    this._hexLabels = [];
    for (const base of this.bases ?? []) {
      for (const dock of base.docks) this._addHexLabel(dock.q, dock.r, 'dock');
      for (const turret of base.turrets ?? []) this._addHexLabel(turret.q, turret.r, 'turretEmplacement');
      // #269 playtest follow-up ("objectives are picking an arbitrary hex, not a real target"):
      // tag the base's dedicated objective hex too, same red-text legibility treatment as the
      // other base-population hex types.
      if (base.objectiveHex) this._addHexLabel(base.objectiveHex.q, base.objectiveHex.r, 'objective');
    }
    for (const t of this.alertTowerHexes ?? []) this._addHexLabel(t.q, t.r, 'alertTower');
  },

  _addHexLabel(q, r, kindId) {
    const { x, y } = hexToPixel(q, r);
    const label = this.add.text(x, y - 34, HEX_LABEL_TEXT[kindId], {
      fontFamily: 'monospace', fontSize: HEX_LABEL_FONT_SIZE, color: HEX_LABEL_COLOR, fontStyle: HEX_LABEL_FONT_STYLE,
    }).setOrigin(0.5).setDepth(DEPTH.WORLD_UI);
    // #270 playtest follow-up: honour the live L-key toggle (ArenaScene `_hexLabelsVisible`,
    // default true) — `?? true` so this stays correct in a test harness that never set the flag.
    label.setVisible(this._hexLabelsVisible ?? true);
    this._hexLabels.push(label);
  },

  // §5: one alert-tower countdown state per standing `alertTower` hex, keyed by hex key.
  // Called once from ArenaScene.create(), alongside `_spawnDormantUnits` above.
  _initAlertTowers() {
    this._alertTowerStates = new Map();
    for (const t of this.alertTowerHexes ?? []) {
      this._alertTowerStates.set(axialKey(t.q, t.r), makeAlertState());
    }
    // §6: which bases have already been woken — a base wakes AT MOST once (waking an
    // already-awake base's units again is a harmless no-op, but tracking this avoids re-scanning
    // `this.enemies` for a base that has nothing left to wake).
    this._wokenBases = new Set();
    // #269 playtest follow-up: live escalating-ring FX + periodic warning-beep state, one entry
    // per tower key, created lazily the instant a countdown actually starts and torn down the
    // instant it cancels/completes — see `_updateAlertTowers` below. Never pre-populated here
    // (an idle tower has nothing to show yet).
    this._alertTowerFx = new Map();
  },

  // §5: per-frame tick for every standing alert tower — called from ArenaScene.update(). A
  // destroyed tower (its hex has collapsed to rubble, `_damageBuildingAt`) is dropped from the
  // map the instant this notices, so an already-in-progress countdown can never complete after
  // the tower is gone; that's the whole "destroy it before the call completes" stealth window.
  _updateAlertTowers(dt) {
    if (!this._alertTowerStates || !this._alertTowerStates.size) return;
    for (const [key, state] of [...this._alertTowerStates]) {
      if (this.terrain.get(key) !== 'alertTower') {
        this._alertTowerStates.delete(key);
        this._freeAlertFx(key);   // #269 playtest follow-up: tower destroyed mid-countdown — kill its FX too
        continue;
      }
      const [q, r] = key.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      const inRange = Math.hypot(this.px - x, this.py - y) <= ALERT_DETECT_RADIUS;
      const next = tickAlertTower(state, { inRange, dt });
      if (next.triggered) {
        this._alertTowerStates.delete(key);   // one-shot — nothing left to tick once it fires
        this._freeAlertFx(key);               // #269 playtest follow-up: countdown complete — swap FX for the real alert
        this._triggerAlert(x, y);
      } else {
        this._alertTowerStates.set(key, next);
        this._updateAlertFx(key, x, y, next, dt);
      }
    }
  },

  // #269 playtest follow-up ("sensor towers need a visual AND a noise to indicate they are
  // spooling up") — per-frame escalating ring + periodic warning beep for one tower's live
  // countdown state. `next.countingDown` is the sole authority on whether FX should exist right
  // now: true while `inRange` has been held long enough to start counting, false the instant the
  // player leaves range (tickAlertTower's cancel path) — so simply mirroring it here (create on
  // the rising edge, free on the falling edge) keeps the FX's lifetime exactly matched to the
  // countdown's own, no separate tracking needed.
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
      fx = { ring, pulseTimerMs: 0 };
      this._alertTowerFx.set(key, fx);
    }
    const f = next.fraction ?? 0;
    strokeHexRing(
      fx.ring,
      ALERT_RING_RADIUS_MIN + (ALERT_RING_RADIUS_MAX - ALERT_RING_RADIUS_MIN) * f,
      3,
      ALERT_RING_COLOR,
      ALERT_RING_ALPHA_MIN + (ALERT_RING_ALPHA_MAX - ALERT_RING_ALPHA_MIN) * f,
    );
    // Periodic warning beep, re-triggered on an interval that shrinks as `f` climbs (see
    // ALERT_PULSE_INTERVAL_MIN/MAX_MS above) — a simple countdown timer accumulated in ms,
    // fired the frame it reaches zero and reset to the (now-shorter) interval for `f`.
    fx.pulseTimerMs -= Math.max(0, dt) * 1000;
    if (fx.pulseTimerMs <= 0) {
      Audio.alertPulse(f, { x, y, listenerX: this.px, listenerY: this.py });
      fx.pulseTimerMs = ALERT_PULSE_INTERVAL_MAX_MS - (ALERT_PULSE_INTERVAL_MAX_MS - ALERT_PULSE_INTERVAL_MIN_MS) * f;
    }
  },

  // Tear down one tower's live FX immediately — countdown cancelled (player left range / tower
  // destroyed) or completed (alert fired). No held/looping sound to explicitly stop (alertPulse
  // is a one-shot cue re-triggered by `_updateAlertFx`'s own timer above, not a sustained node —
  // simply no longer being called IS it stopping cleanly); the only live object is the ring,
  // destroyed here rather than left for scene shutdown to sweep up.
  _freeAlertFx(key) {
    const fx = this._alertTowerFx.get(key);
    if (!fx) return;
    fx.ring.destroy();
    this._alertTowerFx.delete(key);
  },

  // §6: the countdown completed — resolve the SINGLE nearest base (by straight-line distance
  // from the tower's own position, data/bases.js `nearestBaseTo`) and wake only that one.
  _triggerAlert(x, y) {
    const base = nearestBaseTo({ x, y }, this.bases);
    if (base) this._wakeBase(base.id);
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
    const dist = Math.hypot(this.px - e.x, this.py - e.y);
    if (shouldBecomeAware(e.awareness, { dist, detectRange: e.detectRange })) this._wakeBase(e.baseId);
  },

  // §6/§7: wake every still-dormant unit belonging to `baseId`. Idempotent — waking an
  // already-woken base is a no-op. §7 wake-response split: a fast/mobile kind (data/bases.js
  // `isFastWakeKind`, keyed off the kind's own `move.maxSpeed`) needs no special handling at
  // all — every non-mech behavior fn (enemyBehaviors.js) already computes its movement relative
  // to the player's LIVE position each frame once aware, so it starts sortieing the instant it
  // wakes. A slow/defensive kind gets `e.holdGround = true` instead — a light flag
  // tank/quadruped/infantry's behavior fns check to skip their normal "advance to standoff"
  // movement and just fight from where they're standing (turret already has maxSpeed 0, so it
  // needs no flag at all to "hold ground").
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
  // you across the map." This also sidesteps wiring `holdGround` support into all four mech
  // roles individually — the mech tactical AI (enemies.js `_updateEnemy`) checks this ONE flag
  // and skips its whole PRESS/KITE/FLANK/COVER/HOLD decision machine outright when set (forcing
  // state 'hold', see the comment there), so every archetype — brawler, skirmisher, sniper, and
  // even the normally cover-seeking all-indirect artillery — uniformly just stands its ground and
  // fights, no per-role special-casing needed.
  _wakeBase(baseId) {
    if (this._wokenBases.has(baseId)) return;
    this._wokenBases.add(baseId);
    for (const e of this.enemies) {
      if (e.baseId !== baseId || e.awareness !== DORMANT) continue;
      e.awareness = AWARE;
      if (e.kind === 'mech' || (e.kindDef && !isFastWakeKind(e.kindDef))) e.holdGround = true;
    }
  },

  // #269 §3 "rare multi-spawn exception" (playtest follow-up) — per-frame tick for every dock's
  // resupply cooldown, called from ArenaScene.update() alongside `_updateAlertTowers`. A dock is
  // ELIGIBLE (the cooldown counts down) only once BOTH hold: its base has actually been woken
  // (`this._wokenBases` — §2 of the mechanic: a still-fully-dormant base's cleared dock must
  // never resupply, this is tied to "under active assault," not a background timer) AND the
  // dock is currently CLEARED (no live enemy — original assignment or an earlier resupply —
  // still carries its `dockKey`; #87's "a killed enemy is pruned from `this.enemies` the same
  // tick it dies" convention, already relied on by `_allBasesCleared` above, makes that a plain
  // `.some()` scan). `tickDockResupply` (data/dockResupply.js) is the pure state machine; this
  // is just the glue feeding it real per-frame eligibility and reacting to `ready: true`.
  _updateDockResupply(dt) {
    if (!this._dockResupplyStates || !this._dockResupplyStates.size) return;
    for (const [dockKey, meta] of this._dockResupplyMeta) {
      const state = this._dockResupplyStates.get(dockKey);
      if (!state) continue;
      const awake = this._wokenBases.has(meta.baseId);
      const cleared = !this.enemies.some((e) => e.dockKey === dockKey);
      const next = tickDockResupply(state, { eligible: awake && cleared, dt });
      this._dockResupplyStates.set(dockKey, next);
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
  // DOCK hexes (never `turretEmplacement` — see that map's own header comment in
  // `_spawnDormantUnits`), and this game has at most a handful of docks, so a plain per-dock
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
    if (img) img.setTexture(getTerrain('dockClosed').tex);
    this.buildingHp.set(dockKey, terrainBuildingHp('dockClosed'));
    this._closeDockFx(meta.x, meta.y);
  },

  // The inverse of `_closeDock` — swap a still-intact closed dock back to the open `dock`
  // terrain and drop it out of `buildingHp` (an open dock, like the original design, carries no
  // HP of its own — see terrain.js `dock`'s comment). Called from `_resupplyDock` below, right
  // as the resupply elevator sequence starts, so the "doors open / platform rises" FX already
  // built there doubles as the dome's own reopening beat — no separate reopen animation needed.
  _openDock(dockKey) {
    this.terrain.set(dockKey, 'dock');
    const img = this.tileImages.get(dockKey);
    if (img) img.setTexture(getTerrain('dock').tex);
    this.buildingHp.delete(dockKey);
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
  },

  // A steel dome sealing shut over a vacated dock hex: a dark plate scales in from nothing to
  // cover the pad, with a bright metallic rim ring flashing as it seals, then both fade — same
  // throwaway-display-object/tween style as `_outpostCollapseFx`/`_resupplyDock`'s door FX
  // (nothing here is baked into the static hex art, which `_closeDock` already swapped above).
  _closeDockFx(x, y) {
    // A small, quiet mechanical thud (not a full destruction boom) reusing the existing
    // explosion cue at a low scale — same precedent as `_outpostCollapseFx`'s softer soft-cover
    // variant, just even quieter since nothing is actually being destroyed here.
    Audio.explosion(0.25, { x, y, listenerX: this.px, listenerY: this.py });
    const plate = this.add.circle(x, y, 15, 0x1c1f24, 0.94).setScale(0.05).setDepth(DEPTH.IMPACT_FX);
    const rim = this.add.circle(x, y).setStrokeStyle(2.5, 0x9098a3, 0).setRadius(15).setScale(1.4).setDepth(DEPTH.IMPACT_FX + 0.1);
    this.tweens.add({ targets: plate, scale: 1, duration: 380, ease: 'Quad.easeOut' });
    this.tweens.add({
      targets: rim, scale: 1, alpha: 0.9, duration: 380, ease: 'Quad.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: [plate, rim], alpha: 0, duration: 260, delay: 140,
          onComplete: () => { plate.destroy(); rim.destroy(); },
        });
      },
    });
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
  _resupplyDock(dockKey, meta) {
    const { x, y, kindId } = meta;
    // #269 Part 2 ("dock open/closed states"): a dock that's currently CLOSED (the normal case —
    // its original unit(s) walked off/died and `_updateDockOpenClose` already sealed it, see
    // above) reopens right here, at the same moment this elevator sequence kicks off — the
    // doors-open/platform-rise FX below already IS the "dome reopening" beat the issue asks for,
    // so no separate reopen animation is needed. If the dock never actually closed (e.g. its
    // original unit died right on the pad before ever moving — see `_updateDockOpenClose`'s own
    // comment), this is a harmless no-op: the hex is already the open `dock` terrain.
    if (this.terrain.get(dockKey) === 'dockClosed') this._openDock(dockKey);
    const doorHalfW = 15, doorH = 4, shaftHalfW = 15, riseFrom = 22;

    // The dark shaft the platform rises through — stays visible for the whole sequence, so the
    // doors read as sliding open OVER a real gap rather than just two bars moving apart.
    const shaft = this.add.rectangle(x, y, shaftHalfW * 2, doorH * 2.4, 0x0a0b0d, 0.85).setDepth(DEPTH.IMPACT_FX);
    // Two door leaves, starting CLOSED (meeting at centre, fully covering the shaft).
    const doorL = this.add.rectangle(x - doorHalfW / 2, y, doorHalfW, doorH * 3, 0x2c3038, 1).setDepth(DEPTH.IMPACT_FX + 0.1);
    const doorR = this.add.rectangle(x + doorHalfW / 2, y, doorHalfW, doorH * 3, 0x2c3038, 1).setDepth(DEPTH.IMPACT_FX + 0.1);
    // The rising platform itself — starts below the deck (hidden), rises to deck level.
    const platform = this.add.rectangle(x, y + riseFrom, doorHalfW * 1.6, doorH * 1.6, 0x565d66, 1).setDepth(DEPTH.IMPACT_FX + 0.2);
    const glow = this.add.circle(x, y + riseFrom, 4, 0xd8cba0, 0.9).setDepth(DEPTH.IMPACT_FX + 0.3);
    const fx = [shaft, doorL, doorR, platform, glow];
    const destroyFx = () => { for (const obj of fx) obj.destroy(); };

    // Stage 1: doors open (slide apart to reveal the shaft).
    this.tweens.add({
      targets: doorL, x: x - doorHalfW * 1.6, duration: 500, ease: 'Quad.easeOut',
    });
    this.tweens.add({
      targets: doorR, x: x + doorHalfW * 1.6, duration: 500, ease: 'Quad.easeOut',
      onComplete: () => {
        // Stage 2: the platform rises out of the shaft. The unit itself is spawned partway
        // through the rise (roughly when the platform would first crest the deck), directly
        // ACTIVE — no dormant/wake step, matching "the base is already fighting."
        this.tweens.add({ targets: [platform, glow], y: `-=${riseFrom}`, duration: 450, ease: 'Sine.easeOut' });
        this.time.delayedCall(220, () => {
          const e = isEnemyKind(kindId) ? this._spawnKind(x, y, kindId) : this._spawnMech(x, y, kindId);
          e.awareness = AWARE;
          e.baseId = meta.baseId;
          e.dockKey = dockKey;
          e.homeX = x; e.homeY = y;   // #269 Part 1: same leash anchor as an original dock spawn
        });
        // Stage 3: once the platform has surfaced, doors close back over the (now empty) shaft.
        this.time.delayedCall(500, () => {
          this.tweens.add({ targets: doorL, x: x - doorHalfW / 2, duration: 500, ease: 'Quad.easeIn' });
          this.tweens.add({
            targets: doorR, x: x + doorHalfW / 2, duration: 500, ease: 'Quad.easeIn',
            onComplete: () => {
              this.tweens.add({ targets: fx, alpha: 0, duration: 200, onComplete: destroyFx });
            },
          });
        });
      },
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
};
