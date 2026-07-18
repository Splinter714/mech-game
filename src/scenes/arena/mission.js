// Arena mission mixin (#66, reworked #269 playtest follow-up: objective sequencing) — wires the
// pure Mission model (data/mission.js) into the live arena. The objective is no longer an
// arbitrary "farthest destructible outpost hex" (that system was totally disconnected from
// where the real bases/dormant-enemy fights actually are) — it now walks through `this.bases`
// IN ORDER: base 0 first, then base 1 once base 0's docked units are all dead, etc. Bases are
// already placed in index order by `placeBases` (data/worldgen.js), stratified along the
// corridor so index also correlates with distance-from-spawn AND difficulty
// (`baseLateFraction`) — so following index is automatically forward, non-backtracking
// progression with no separate "direction" logic needed. Methods use `this` (the ArenaScene);
// composed onto the prototype via Object.assign, same as the other mixins.
//
// #66 is objective-only: the arena never feeds `playerDead` (that's the run-loop's job,
// #64), so this mission can only ever go active → complete, never → failed, for now.
import { makeMission, evaluateMission } from '../../data/mission.js';
import { axialKey, hexToPixel } from '../../data/hexgrid.js';
import { isBaseCleared } from '../../data/bases.js';
import { DEPTH, UI_HIGHLIGHT_COLOR } from './shared.js';

export const MissionMixin = {
  // One-time init from ArenaScene.create(), AFTER _buildWorld() has populated `this.bases`.
  // Targets base 0 (the lowest-index/earliest base — see file header) as the very first
  // objective. `_targetCurrentBase` (below) does the actual work and is reused by run.js
  // `_pickNextObjective` for every later base-advance too.
  _initMission() {
    this._objectiveBaseIndex = 0;
    this._targetCurrentBase();
  },

  // Points the mission/marker/wayfinding at whatever base sits at `this._objectiveBaseIndex`,
  // or clears everything if that index has run past the end of `this.bases` (every base has
  // been cleared — see run.js `_pickNextObjective`, which only ever advances the index after a
  // base-clear). No new marker is made when there's nothing left to target — the run is about
  // to end as a win via `_allBasesCleared()` (run.js `_updateRun`) at that point anyway.
  _targetCurrentBase() {
    const base = (this.bases ?? [])[this._objectiveBaseIndex] ?? null;
    this._objectiveBase = base;
    this.objectiveHex = base ? axialKey(base.center.q, base.center.r) : null;
    this.mission = base ? makeMission('assault') : null;
    if (this._objectiveMarker) { this._objectiveMarker.destroy(); this._objectiveMarker = null; }
    if (this.objectiveHex) this._makeObjectiveMarker(this.objectiveHex);
    this.registry.set('mission', this.mission);
    this._publishObjectiveWorld();
  },

  // #80: the objective's world-space position, republished under its own registry key so
  // HudScene's edge-direction arrow (and, later, the minimap) has a single live source that
  // agrees with the world-space marker above — both read the SAME `this.objectiveHex`, just
  // converted once here via the same `hexToPixel` the marker itself uses. Called from
  // `_initMission` (immediate availability the very first frame) and every frame from
  // `_updateMission` below, so a stage-advance reassignment of `this.objectiveHex` (run.js
  // `_startNextStage`) is picked up with no extra wiring on that side.
  _publishObjectiveWorld() {
    if (!this.objectiveHex) { this.registry.set('objectiveWorld', null); return; }
    const [q, r] = this.objectiveHex.split(',').map(Number);
    this.registry.set('objectiveWorld', hexToPixel(q, r));
  },

  // A simple, readable beacon over the objective hex: a pulsing amber ring + a small
  // floating label, in the style of the powerup beacons (world-space container, tweened).
  // Kept far simpler than the powerup beacon since this only needs to be findable, not flashy.
  _makeObjectiveMarker(hexKey) {
    const [q, r] = hexKey.split(',').map(Number);
    const { x, y } = hexToPixel(q, r);
    // #129: the amber ring alone can blend into some biome palettes (e.g. desert sand, or
    // volcanic embers, are close to amber in hue). Add a fixed dark + light double outline
    // OUTSIDE the amber ring — same reasoning as the enemy legibility halo (mechPrims.js's
    // `HALO`): the dark ring reads against light terrain, the light ring reads against dark
    // terrain, so together they carry the marker's edge against every biome without touching
    // the amber "this is the objective" colour itself.
    const haloRing = this.add.circle(0, 0, 33).setStrokeStyle(3, 0xfbfdff, 0.9);
    const outlineRing = this.add.circle(0, 0, 31.5).setStrokeStyle(2, 0x0b0e14, 0.9);
    const ring = this.add.circle(0, 0, 30).setStrokeStyle(3, UI_HIGHLIGHT_COLOR, 0.9);
    const label = this.add.text(0, -46, 'OBJECTIVE', {
      fontFamily: 'monospace', fontSize: '12px', color: `#${UI_HIGHLIGHT_COLOR.toString(16).padStart(6, '0')}`,
    }).setOrigin(0.5);
    const marker = this.add.container(x, y, [haloRing, outlineRing, ring, label]);
    // #99: bumped from a bare 5 to the shared DEPTH.WORLD_UI tier — established alongside the
    // rest of the arena's depth scheme (shared.js), one step above impact/death FX (5) so the
    // objective stays legible even through an explosion happening on top of it.
    marker.setDepth(DEPTH.WORLD_UI);
    this.tweens.add({ targets: [ring, outlineRing, haloRing], scale: 1.35, alpha: 0.35, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this._objectiveMarker = marker;
  },

  // Per-frame: is the current objective base cleared (every enemy tagged with its baseId dead —
  // data/bases.js `isBaseCleared`)? Feed that into the pure `evaluateMission` and publish the
  // resulting mission to the registry so HudScene can read it. A terminal status is sticky (the
  // model itself won't re-open it), so once complete this just keeps republishing the same
  // status. No-ops once every base has been cleared (`this.mission` is null — see
  // `_targetCurrentBase`); `_allBasesCleared()` (run.js `_updateRun`) ends the run as a win at
  // that point regardless, so there's nothing left for this to watch.
  _updateMission() {
    if (!this.mission) return;
    const objectiveDestroyed = isBaseCleared(this._objectiveBase?.id, this.enemies);
    const wasActive = this.mission.status === 'active';
    // #66: fail path deferred to #64 (the run loop) — no real playerDead signal yet, so this
    // always passes false and the mission can only ever go active → complete for now.
    this.mission.status = evaluateMission(this.mission, { objectiveDestroyed, playerDead: false });
    this.registry.set('mission', this.mission);
    this._publishObjectiveWorld();   // #80: keep the HUD wayfinding source fresh every frame
    if (wasActive && this.mission.status === 'complete') this._onMissionComplete();
  },

  // Win reaction. Kept deliberately simple (owner's call, #66): no forced return to the
  // garage (that's a #64 run-loop concern) and enemies are left running — the arena just
  // keeps playing as a sandbox after the win, with the marker swapped to a "cleared" look
  // and a banner (drawn by HudScene, reading `mission.status`) announcing it. This avoids
  // any surprising freeze/stop behaviour before the run loop exists to make that call well.
  _onMissionComplete() {
    if (this._objectiveMarker) {
      // #129: index 2 — the amber ring is now the third child (after the halo + outline
      // legibility rings added around it; see `_makeObjectiveMarker`).
      const ring = this._objectiveMarker.list[2];
      this.tweens.killTweensOf(ring);
      ring.setStrokeStyle(3, 0x7bd17b, 0.9);
      const label = this._objectiveMarker.list[3];
      label.setText('CLEARED').setColor('#7bd17b');
    }
  },
};
