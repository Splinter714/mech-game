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

// #269 playtest follow-up (hex legibility): a base/tower hex's dormant unit or small art icon
// alone doesn't read clearly as "this is a dock/alert tower/turret emplacement" during playtest
// — a persistent red text tag above the hex makes it unambiguous at a glance. Always-on for now
// (an explicit playtest/legibility aid Jackson asked for directly, not gated behind a debug
// flag). Deliberately plain/loud (bright red, monospace) rather than styled like the amber
// objective marker (mission.js `_makeObjectiveMarker`) — these are a debug-readable tag, not a
// wayfinding beacon, so they shouldn't compete visually with the real objective marker.
const HEX_LABEL_COLOR = '#ff4444';
const HEX_LABEL_TEXT = { dock: 'DOCK', alertTower: 'ALERT TOWER', turretEmplacement: 'TURRET' };

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
  _spawnDormantUnits() {
    for (const base of this.bases ?? []) {
      for (const dock of base.docks) {
        const { x, y } = hexToPixel(dock.q, dock.r);
        const count = dock.count ?? 1;
        const dockKey = axialKey(dock.q, dock.r);
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
    }
    for (const t of this.alertTowerHexes ?? []) this._addHexLabel(t.q, t.r, 'alertTower');
  },

  _addHexLabel(q, r, kindId) {
    const { x, y } = hexToPixel(q, r);
    const label = this.add.text(x, y - 34, HEX_LABEL_TEXT[kindId], {
      fontFamily: 'monospace', fontSize: '11px', color: HEX_LABEL_COLOR, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(DEPTH.WORLD_UI);
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
  },

  // §5: per-frame tick for every standing alert tower — called from ArenaScene.update(). A
  // destroyed tower (its hex has collapsed to rubble, `_damageBuildingAt`) is dropped from the
  // map the instant this notices, so an already-in-progress countdown can never complete after
  // the tower is gone; that's the whole "destroy it before the call completes" stealth window.
  _updateAlertTowers(dt) {
    if (!this._alertTowerStates || !this._alertTowerStates.size) return;
    for (const [key, state] of [...this._alertTowerStates]) {
      if (this.terrain.get(key) !== 'alertTower') { this._alertTowerStates.delete(key); continue; }
      const [q, r] = key.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      const inRange = Math.hypot(this.px - x, this.py - y) <= ALERT_DETECT_RADIUS;
      const next = tickAlertTower(state, { inRange, dt });
      if (next.triggered) {
        this._alertTowerStates.delete(key);   // one-shot — nothing left to tick once it fires
        this._triggerAlert(x, y);
      } else {
        this._alertTowerStates.set(key, next);
      }
    }
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
