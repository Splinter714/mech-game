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
import { axialKey, hexToPixel, hexCorners } from '../../data/hexgrid.js';
import { isBaseCleared } from '../../data/bases.js';
import { DEPTH, UI_HIGHLIGHT_COLOR } from './shared.js';

// #269 playtest follow-up ("objectives aren't clearing until I kill all units at the base"): the
// previous round added a real, destructible `objective` hex per base and pointed the marker at
// it, but left the actual win-condition check keyed off `isBaseCleared` (every enemy tagged with
// the base's id dead) — completely unrelated to whether the objective hex itself was destroyed.
// Jackson's original framing was explicit: the objective hex's own destruction should BE the
// completion trigger, not a decoration next to a separate enemy-count check. `_damageBuildingAt`
// (world.js) deletes a destructible hex's key from `this.buildingHp` the instant it collapses to
// rubble — same "membership means still standing" convention `_isMissionObjective`'s neighbours
// already rely on (world.js #250) — so "no longer in `buildingHp`" is the idiomatic destroyed
// check, reused as-is rather than inventing a parallel signal.
//
// Falls back to `isBaseCleared` (all enemies tagged with this base dead) for the rare base whose
// `objectiveHex` is null (worldgen.js's safe-zone re-validation pass can clear it back to open
// ground) — every base still needs SOME way to be completed even without a real objective hex.
// `isBaseCleared` itself is kept as a distinct, still-meaningful concept ("all this base's
// enemies dead") rather than deleted — it remains the fallback here, and dormantWake.test.js's
// `_allBasesCleared` still legitimately means "all docked enemies across every base are dead".
export function isBaseObjectiveDestroyed(base, buildingHp, enemies) {
  if (!base) return true;
  const hex = base.objectiveHex;
  if (!hex) return isBaseCleared(base.id, enemies);
  return !(buildingHp ?? new Map()).has(axialKey(hex.q, hex.r));
}

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
    // #269 playtest follow-up ("objectives are picking an arbitrary hex, not a real target"): the
    // marker targets the base's dedicated, destructible `objective` hex (data/worldgen.js
    // `placeBases`) instead of `base.center` — the geometric centroid of the dock cluster, which
    // isn't necessarily even a real placed hex. Falls back to `base.center` on the rare case a
    // base's objective hex got invalidated (e.g. landed in the spawn safe zone and was cleared
    // back to open ground, see `generateTerrain`'s re-validation pass) so the marker always has
    // SOMETHING to point at.
    const targetHex = base ? (base.objectiveHex ?? base.center) : null;
    this.objectiveHex = targetHex ? axialKey(targetHex.q, targetHex.r) : null;
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
    // #280: hexagon outlines (matching the real hex grid's pointy-top orientation, via the
    // same `hexCorners` helper hexArt.js uses to draw actual terrain hexes) instead of circles
    // — stroke-only Polygon shapes, same three radii/stroke widths/colors/alpha as before.
    const haloRing = this.add.polygon(0, 0, hexCorners(33)).setStrokeStyle(3, 0xfbfdff, 0.9);
    const outlineRing = this.add.polygon(0, 0, hexCorners(31.5)).setStrokeStyle(2, 0x0b0e14, 0.9);
    const ring = this.add.polygon(0, 0, hexCorners(30)).setStrokeStyle(3, UI_HIGHLIGHT_COLOR, 0.9);
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

  // Per-frame: has the current objective base's real payoff — its own objective hex, or the
  // enemy-count fallback when it has none (see `isBaseObjectiveDestroyed` above) — been
  // destroyed? Feed that into the pure `evaluateMission` and publish the resulting mission to
  // the registry so HudScene can read it. A terminal status is sticky (the model itself won't
  // re-open it), so once complete this just keeps republishing the same status. No-ops once
  // every base has been cleared (`this.mission` is null — see `_targetCurrentBase`);
  // `_allObjectivesDestroyed()` (run.js `_updateRun`) ends the run as a win at that point
  // regardless, so there's nothing left for this to watch.
  _updateMission() {
    if (!this.mission) return;
    const objectiveDestroyed = isBaseObjectiveDestroyed(this._objectiveBase, this.buildingHp, this.enemies);
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
