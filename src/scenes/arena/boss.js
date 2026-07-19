// Arena boss mixin (#240) — the live wiring for the boss battle. The RULES all live in
// data/boss.js and the arena SHAPE in data/bossArena.js (both pure + unit-tested); this file
// only stamps that layout into the scene, spawns the boss, feeds the escalation profile onto
// the live enemy object each frame, runs the summon cadence, and draws the readability overlay.
//
// The boss deliberately reuses the ORDINARY enemy-mech path (`_updateEnemy` in enemies.js), not
// a bespoke brain: it's a Mech, so hit mapping, per-part damage, destroyed-part stumps, vanished
// weapons, ammo, LOS and firing all already work on it unchanged. What makes it a slow SIEGE
// PLATFORM rather than a chaser is pure data — the colossus chassis' crawl of a maxSpeed and its
// glacial turnRate (data/chassis/colossus.js) — so the standard tactical AI can want to
// reposition all it likes and still barely move. It dominates by reach, not pursuit.
//
// ── The 10x-scale readability problem, and how it's solved ────────────────────────────────
// At ~10x a medium mech the boss is bigger than the viewport, which breaks two things:
//   1. LIMBS AS TARGETS. Every existing "which part did this hit?" computation assumed one
//      global mech scale. That's now a per-unit number (`mechDispUnit`, arena/shared.js) so the
//      boss's four plates map to hit points at ITS size — shooting its left arm damages its
//      left arm, not whatever happened to be nearest its centre. On top of that, this file
//      draws a live MARKER over each surviving plate (a ring + a health arc) and a separate
//      core marker, so the player can always read "four things to break, then the middle"
//      even when the silhouette fills the screen.
//   2. THE CAMERA. The arena's gameplay zoom is multiplied down by BOSS_ARENA_ZOOM for this
//      fight only, so the whole boss plus a useful amount of the pit around it fits on screen.
//      Combined with the pit being a closed disc (rather than the usual long corridor), the
//      framing holds without any dynamic zoom logic that could fight the player for control.

import Phaser from 'phaser';
import { hexToPixel } from '../../data/hexgrid.js';
import { getTerrain, buildingHp as terrainHpFor } from '../../data/terrain.js';
import { terrainFillColor, isBoundaryTerrainId, isCoverCanopyId, canopyTexKey } from '../../art/hexArt.js';
import { buildMechTextures, partSpriteTransform, ART_SCALE } from '../../art/index.js';
import { AWARE } from '../../data/awareness.js';
import { Audio } from '../../audio/index.js';
import {
  bossArenaLayout, BOSS_ARENA_TERRAIN, BOSS_ARENA_RADIUS,
} from '../../data/bossArena.js';
import {
  BossMech, BOSS_SCALE, BOSS_PLATING, BOSS_SUMMON_WAVE, shouldSummon,
} from '../../data/boss.js';
import { ARENA_MECH_SCALE, DEPTH, DEATH_SCALE_MAX, unitDepth, mechDispUnit } from './shared.js';

// Camera framing multiplier for the boss arena ONLY (applied on top of the arena's normal
// GAMEPLAY_ZOOM). Pulled back far enough that the boss reads as a whole machine with room to
// circle it, rather than an anonymous wall of plating filling the viewport.
export const BOSS_ARENA_ZOOM = 0.42;

// Super-sampling grid the boss's textures are drawn on. Much finer than the global ART_SCALE (4)
// because these sprites are displayed ~10x larger — at the default grid the plating would read
// as a blown-up 4x texture. 12 keeps every design unit backed by 12 texture pixels (3x the
// fidelity an ordinary mech gets) at a one-off cost of nine 768x768 textures.
export const BOSS_ART_SCALE = 12;

// The boss's sprite scale. Derived, never hand-tuned: `mechDispUnit` (world px per design unit)
// must come out to exactly BOSS_SCALE x an ordinary mech's, whatever grid the textures use.
export const BOSS_VIEW_SCALE = (ARENA_MECH_SCALE * ART_SCALE * BOSS_SCALE) / BOSS_ART_SCALE;

// Readability overlay tuning, expressed in DESIGN units and scaled by the unit's own size at
// draw time — so the markers stay correctly proportioned to the boss if BOSS_SCALE is ever
// retuned, instead of being hand-fitted world-pixel constants that silently stop bracketing the
// limbs. Sized to visibly ring each plate rather than sit as a dot in the middle of it.
const MARKER_R_DU = 7.4;          // design units: radius of a plate marker ring
const MARKER_ARC_DU = 1.1;        // design units: thickness of its health arc
const CORE_MARKER_R_DU = 12.5;

export const BossMixin = {
  // ── World ───────────────────────────────────────────────────────────────────────────────
  // Stamp the hand-authored pit (data/bossArena.js) instead of generating a corridor. Produces
  // exactly the same scene fields `_buildWorld` does, so every other mixin (collision, LOS,
  // culling, terrain damage, projectiles) works on it with no boss-specific branching at all.
  _buildBossArena() {
    const L = bossArenaLayout();
    const T = BOSS_ARENA_TERRAIN;
    this.worldRadius = BOSS_ARENA_RADIUS + 2;

    this.cameras.main.setBackgroundColor(terrainFillColor(T.boundary) ?? '#0d1014');

    this.terrain = new Map();
    this.buildingHp = new Map();   // hexKey → HP for destructible SOLID hexes (deliberately empty:
                                   // the hard pillars are permanent, see BOSS_ARENA_TERRAIN)
    this.coverHp = new Map();      // hexKey → HP for destructible SOFT cover (the outer ring)
    this.tileImages = new Map();
    this.canopyImages = new Map();

    for (const k of L.floorKeys) {
      const [q, r] = k.split(',').map(Number);
      // Checkerboard the floor the same way every biome's groundA/groundB pair does, so the pit
      // has visible texture to judge your own movement against instead of a flat plate.
      let id = ((q + r) % 2 === 0) ? T.groundA : T.groundB;
      if (L.hardKeys.has(k)) id = T.hard;
      else if (L.softKeys.has(k)) { id = T.soft; this.coverHp.set(k, terrainHpFor(T.soft)); }
      this.terrain.set(k, id);
    }
    for (const k of L.boundaryKeys) this.terrain.set(k, T.boundary);
    this._boundaryRing = L.boundaryKeys;

    // Tiles + cover canopies, mirroring `_buildWorld`: boundary hexes get NO tile at all (the
    // camera background colour IS the rim, #222), everything else gets one image plus, for
    // cover, its foliage/plume overlay.
    for (const [k, id] of this.terrain) {
      const tex = getTerrain(id).tex;
      if (isBoundaryTerrainId(tex)) continue;
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      this.tileImages.set(k, this.add.image(x, y, tex).setScale(1 / ART_SCALE).setDepth(DEPTH.TERRAIN));
      if (isCoverCanopyId(tex)) {
        this.canopyImages.set(k, this.add.image(x, y, canopyTexKey(tex))
          .setScale(1 / ART_SCALE).setDepth(DEPTH.COVER_CANOPY));
      }
    }
    this._visibleTiles = new Set(this.terrain.keys());
    this._cullCenterX = null;
    this._cullCenterY = null;

    // No bases, no alert towers, no objective — this is a duel, not a run through a corridor.
    // The fields still exist (empty) so any shared code that iterates them is a harmless no-op.
    this.bases = [];
    this.alertTowerHexes = [];
    this._spine = null;
    this.registry.set('spineWorld', []);
    this.objectiveHex = null;
    this.registry.set('objectiveWorld', null);
    // A Mission-SHAPED record purely so the HUD's objective line reads sensibly (HudScene just
    // renders `mission.objective` and checks `mission.status`). Nothing evaluates it — the boss
    // mixin owns the win/lose transitions directly — but publishing null instead would leave the
    // previous run's objective text stranded on screen.
    this.registry.set('mission', {
      typeId: null, name: 'Boss', objective: 'Dismantle the Colossus', status: 'active',
    });

    this._spawnHex = L.spawnHex;
    this._spawnPoint = hexToPixel(L.spawnHex.q, L.spawnHex.r);
    this._bossHex = L.bossHex;
  },

  // ── The boss ────────────────────────────────────────────────────────────────────────────
  // Spawn it as an ordinary mech-kind enemy so every existing system treats it normally — it's
  // only unusual in three data fields: a BossMech instead of a Mech, and its own viewScale/
  // artScale (see the header comment for why those are two numbers, not one).
  _spawnBoss() {
    const key = 'bossMech';
    const mech = new BossMech();
    mech.repairAll();
    buildMechTextures(this, key, mech, { theme: 'enemy', artScale: BOSS_ART_SCALE });
    const { x, y } = hexToPixel(this._bossHex.q, this._bossHex.r);
    const angle = Math.PI / 2;   // facing "down" the pit, i.e. toward the player's entrance
    const view = this._makeMechView(key, x, y, angle, false, BOSS_VIEW_SCALE);
    // It towers over everything, including the cover canopy — same depth tier a large ground
    // unit uses, so it never renders under a plume of smoke.
    view.setDepth(unitDepth(false, false, false));

    const e = {
      key, mech, view, x, y, vx: 0, vy: 0, angle, turret: angle, fireCd: {},
      spawnX: x, spawnY: y, typeId: 'boss', kind: 'mech',
      viewScale: BOSS_VIEW_SCALE, artScale: BOSS_ART_SCALE,
      // Role/standoff feed the shared tactical AI. `sniper` + a wide standoff keeps it from
      // trying to walk into the player's face; it barely moves either way (chassis maxSpeed 26).
      role: 'sniper', standoff: 520, handed: 1, allIndirect: false,
      detectRange: 4000,
      // It notices you the moment you walk in — no dormancy, no stagger. Walking into the arena
      // and having it open up IS the set-piece.
      awareness: AWARE, reactDelayMs: null,
      // Stands its ground and faces the player when stationary, like a woken base defender.
      holdGround: true,
      // Escalation channels, read by enemies.js's shared firing code. Start at the neutral
      // defaults so an undamaged boss fires exactly at its weapons' own tuning.
      cadenceScale: 1, aimSpread: 0.12, extraShots: 0,
    };
    this._resetAiState(e);
    e.awareness = AWARE;         // _resetAiState re-arms UNAWARE; the boss is never asleep
    e.holdGround = true;
    this.enemies.push(e);
    this._enemiesSpawnedThisStage = (this._enemiesSpawnedThisStage ?? 0) + 1;
    this.boss = e;
    this.registry.set('dummyMech', mech);

    // Fight-scoped state for the summon cadence + the victory transition.
    this._bossSummonWaves = 0;
    this._bossLastSummonAt = this.time.now;
    this._bossBeaten = false;
    this._bossFx = this.add.graphics().setDepth(DEPTH.IMPACT_FX);
    return e;
  },

  // Per-frame boss logic. Called from ArenaScene.update() INSTEAD of the mission/run/base ticks
  // (there are no missions or bases here) — it owns both terminal transitions itself.
  _updateBoss(dt, delta) {
    const b = this.boss;
    if (!b) return;

    // Player death still ends the run as a loss, same as any other sortie.
    if (this.mech.isDestroyed()) { this._endRun('dead'); return; }

    if (b.mech.isDestroyed()) { this._onBossBeaten(b); return; }

    // Rule 2 — losing a plate escalates what survives. Recomputed from the LIVE mech every
    // frame, so it steps up the instant a limb comes off with no event plumbing.
    const esc = b.mech.escalation();
    b.cadenceScale = esc.cadenceScale;
    b.aimSpread = 0.12 + esc.aimJitter * 2;
    b.extraShots = esc.extraCount;

    this._updateBossSummons(b);
    this._drawBossMarkers(b);
  },

  // Rare relief waves. Deliberately sparse and capped (data/boss.js owns the cadence rules) —
  // the fight's interest has to come from the boss, so these exist only to break the rhythm of
  // the duel a couple of times. Dropped at the pit's rim, away from the player, so a wave reads
  // as "something just came in behind you" rather than an ambush on top of you.
  _updateBossSummons(b) {
    const ok = shouldSummon({
      elapsedSinceLastMs: this.time.now - this._bossLastSummonAt,
      wavesSoFar: this._bossSummonWaves,
      destroyedCount: b.mech.limbsDestroyed(),
    });
    if (!ok) return;
    this._bossLastSummonAt = this.time.now;
    this._bossSummonWaves += 1;
    const rimR = (BOSS_ARENA_RADIUS - 1.5) * 48 * Math.sqrt(3);
    const base = Math.atan2(this.py - b.y, this.px - b.x) + Math.PI;   // opposite the player
    BOSS_SUMMON_WAVE.forEach((kindId, i) => {
      const a = base + (i - (BOSS_SUMMON_WAVE.length - 1) / 2) * 0.35;
      this._spawnEnemy(b.x + Math.cos(a) * rimR, b.y + Math.sin(a) * rimR, kindId);
    });
    this._floatText(this.px, this.py - 40, 'REINFORCEMENTS', '#e2a03a');
  },

  // The readability overlay (see the header comment). One marker per SURVIVING plate — a ring
  // with a health arc, drawn at that plate's real joint position so it tracks the limb as the
  // boss turns — plus a core marker in the middle that is dim and sealed until enough plating
  // is gone, then pulses as the live kill window.
  _drawBossMarkers(b) {
    const g = this._bossFx;
    if (!g) return;
    g.clear();
    // Design units -> world px for THIS unit (10x an ordinary mech for the boss).
    const du = mechDispUnit(b);
    const markerR = MARKER_R_DU * du;
    const arcW = MARKER_ARC_DU * du;
    const coreR = CORE_MARKER_R_DU * du;
    for (const loc of BOSS_PLATING) {
      if (b.mech.isPartDestroyed(loc)) continue;
      const t = partSpriteTransform(b.mech, loc, b.turret, b.viewScale, b.artScale);
      const mx = b.x + t.dx, my = b.y + t.dy;
      const f = Phaser.Math.Clamp(b.mech.partHealthFraction(loc), 0, 1);
      // Ring: white when healthy, hot amber as the plate is chewed down.
      const col = f > 0.5 ? 0xf4f1e6 : 0xe2a03a;
      g.lineStyle(Math.max(2, arcW * 0.3), col, 0.5);
      g.strokeCircle(mx, my, markerR);
      // Health arc — a partial ring, so "how much is left on THIS limb" is readable at a glance
      // from across the pit without any HUD lookup.
      g.lineStyle(arcW, col, 0.95);
      g.beginPath();
      g.arc(mx, my, markerR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f, false);
      g.strokePath();
    }
    // Core.
    const exposed = b.mech.coreExposed();
    const cf = Phaser.Math.Clamp(b.mech.coreFraction(), 0, 1);
    if (!exposed) {
      // Sealed: a dim, closed shutter. Present from the first frame so the player knows there's
      // something in the middle to get to, long before it opens.
      g.lineStyle(arcW * 0.8, 0x8b97a4, 0.55);
      g.strokeCircle(b.x, b.y, coreR);
    } else {
      const pulse = 0.65 + 0.35 * Math.sin(this.time.now / 160);
      g.lineStyle(arcW * 0.8, 0xe2533a, pulse);
      g.strokeCircle(b.x, b.y, coreR);
      g.lineStyle(arcW * 1.8, 0xe2533a, 0.95);
      g.beginPath();
      g.arc(b.x, b.y, coreR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cf, false);
      g.strokePath();
    }
  },

  // Victory. Per #240 the aftermath is deliberately minimal for now — no unlock, no reward
  // (meta-progression is #297's job) — just a suitably enormous death and the ordinary
  // run-over transition back to the garage.
  _onBossBeaten(b) {
    if (this._bossBeaten) return;
    this._bossBeaten = true;
    this._bossFx?.clear();
    // Several overlapping maximum-scale explosions across its whole footprint, so a machine this
    // size doesn't die with the same single puff a drone does.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const r = i === 0 ? 0 : 90;
      this.time.delayedCall(i * 110, () => {
        this._deathFx(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r, DEATH_SCALE_MAX, 'massive');
      });
    }
    Audio.ui('mechDestroyed');
    this._removeEnemy(b);
    this.boss = null;
    this._endRun('won');
  },
};
