// #269 §3-§7 (issue: base population rework — dormant docks + alert towers) — scene-side wiring
// for the base population system. Methods use `this` (the ArenaScene); composed onto the
// prototype via Object.assign, same as the other mixins. The pure logic underneath lives in
// data/alertTower.js (countdown state machine) and data/bases.js (nearest-base routing +
// fast/slow wake-response split) — this file is just the thin per-frame glue: real world
// positions, the live `this.enemies` array, and `this.bases`/`this.alertTowerHexes` (both set
// by `_buildWorld`, world.js, from `generateTerrain`'s `placeBases` result).
import { hexToPixel, axialKey } from '../../data/hexgrid.js';
import { DORMANT, AWARE } from '../../data/awareness.js';
import { makeAlertState, tickAlertTower, ALERT_DETECT_RADIUS } from '../../data/alertTower.js';
import { nearestBaseTo, isFastWakeKind } from '../../data/bases.js';
import { DEPTH } from './shared.js';
import { Audio } from '../../audio/index.js';
import { nearestValidPixel } from '../../data/spawnPlacement.js';
import { makeDockResupplyState, tickDockResupply } from '../../data/dockResupply.js';

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

// #269 playtest follow-up (dock composition): how far apart a multi-unit dock's units (2-3
// tanks, 2 helicopters — see data/worldgen.js `dockCountFor`) are scattered around their shared
// dock hex's centre pixel, so they don't all render exactly on top of one another. Mirrors
// enemies.js's `TURRET_HUDDLE_OFFSET` (10px) for the same "huddle, don't stack" idea, just a
// bit wider — tank/helicopter sprites (scale 0.4/0.6, both shrunk for this exact reason, see
// enemyKinds.js) read bigger on screen than a turret (scale 0.42), so they need more room to
// stay visually distinct as several units rather than reading as one blob.
const DOCK_HUDDLE_OFFSET = 16;

export const BasesMixin = {
  // §4: spawn every base's docked units NOW, at deploy time, dormant — not lazily, not via the
  // old off-camera `_offscreenSpawnPoint`/squad system. Called once from ArenaScene.create(),
  // in place of the old `_spawnSquad()` opening-squad call. Restricted to non-mech kinds (see
  // data/worldgen.js's BASE_EARLY_KIND_POOL/BASE_LATE_KIND_POOL comment for why), so this calls
  // `_spawnKind` directly rather than the more general `_spawnEnemy` dispatcher.
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
          const e = this._spawnKind(px, py, dock.kindId);
          // A DORMANT unit is genuinely inert (see enemies.js `_updateEnemy`'s early return on
          // this state) — never through UNAWARE's idle-wander first. `baseId`/`dockKey` are
          // how `_wakeBase` finds "every unit belonging to this base/dock" and are otherwise
          // unused.
          e.awareness = DORMANT;
          e.baseId = base.id;
          e.dockKey = dockKey;
        }
      }
      for (const turret of base.turrets ?? []) {
        const { x, y } = hexToPixel(turret.q, turret.r);
        const e = this._spawnKind(x, y, 'turret');
        e.awareness = DORMANT;
        e.baseId = base.id;
        e.dockKey = axialKey(turret.q, turret.r);
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
      const ring = this.add.circle(x, y, ALERT_RING_RADIUS_MIN)
        .setStrokeStyle(3, ALERT_RING_COLOR, ALERT_RING_ALPHA_MIN)
        .setDepth(DEPTH.WORLD_UI);
      fx = { ring, pulseTimerMs: 0 };
      this._alertTowerFx.set(key, fx);
    }
    const f = next.fraction ?? 0;
    fx.ring.setRadius(ALERT_RING_RADIUS_MIN + (ALERT_RING_RADIUS_MAX - ALERT_RING_RADIUS_MIN) * f);
    fx.ring.setStrokeStyle(3, ALERT_RING_COLOR, ALERT_RING_ALPHA_MIN + (ALERT_RING_ALPHA_MAX - ALERT_RING_ALPHA_MIN) * f);
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

  // §6/§7: wake every still-dormant unit belonging to `baseId`. Idempotent — waking an
  // already-woken base is a no-op. §7 wake-response split: a fast/mobile kind (data/bases.js
  // `isFastWakeKind`, keyed off the kind's own `move.maxSpeed`) needs no special handling at
  // all — every non-mech behavior fn (enemyBehaviors.js) already computes its movement relative
  // to the player's LIVE position each frame once aware, so it starts sortieing the instant it
  // wakes. A slow/defensive kind gets `e.holdGround = true` instead — a light flag
  // tank/quadruped/infantry's behavior fns check to skip their normal "advance to standoff"
  // movement and just fight from where they're standing (turret already has maxSpeed 0, so it
  // needs no flag at all to "hold ground").
  _wakeBase(baseId) {
    if (this._wokenBases.has(baseId)) return;
    this._wokenBases.add(baseId);
    for (const e of this.enemies) {
      if (e.baseId !== baseId || e.awareness !== DORMANT) continue;
      e.awareness = AWARE;
      if (e.kindDef && !isFastWakeKind(e.kindDef)) e.holdGround = true;
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

  // Plays the doors-open → platform-rise → doors-close FX at a cleared dock's position, and
  // spawns the fresh unit mid-sequence (roughly when it would first be visible rising out of the
  // bay). All Phaser tweens on a temporary container (mirrors world.js `_outpostCollapseFx`'s
  // "build throwaway display objects, tween them, destroy on completion" style — nothing here is
  // baked into the static hex art, which stays untouched). The spawned unit goes DIRECTLY active
  // (AWARE, no `holdGround`/wake-response split needed — its base is already awake and fighting,
  // matched to the mechanic's design intent that a resupply unit doesn't sit inert like an
  // original dormant one) and is scattered like a fresh dock spawn.
  _resupplyDock(dockKey, meta) {
    const { x, y, kindId } = meta;
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
          const e = this._spawnKind(x, y, kindId);
          e.awareness = AWARE;
          e.baseId = meta.baseId;
          e.dockKey = dockKey;
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

  // #269 §8: the run's simplified win condition — every base's docked units (dormant or
  // awakened, doesn't matter) are destroyed. Dead enemies are pruned out of `this.enemies` the
  // same tick they die (#87 `_removeEnemy`), so "no enemy left with a baseId" is already the
  // exact right check — no separate per-base HP bookkeeping needed. False if there are no
  // bases at all (nothing to clear yet — guards a pre-`_buildWorld` call).
  _allBasesCleared() {
    if (!this.bases || !this.bases.length) return false;
    return !this.enemies.some((e) => e.baseId != null);
  },
};
