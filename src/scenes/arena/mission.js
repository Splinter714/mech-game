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
import { isBaseCleared, baseClearState, CLEAR_DONE } from '../../data/bases.js';
import { DEPTH, UI_HIGHLIGHT_COLOR, strokeHexRing } from './shared.js';

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

// #356: the full clear state of one base — objective, then docks, then the (now finite) garrison.
// See data/bases.js `baseClearState` for why the requirement is ordered this way. This is the
// scene-side adapter that supplies the two `buildingHp` facts the pure model can't know: whether
// the objective hex is gone (`isBaseObjectiveDestroyed`, unchanged) and whether each dock hex is
// still standing. Both are the same one-way "still in `buildingHp`" convention, so nothing here
// needs its own destroyed-flag bookkeeping.
//
// Deliberately a standalone function rather than a mixin method: mission.js, bases.js and run.js
// all need it, and the arena's hand-built test doubles never compose every mixin.
export function baseClearStateOf(base, buildingHp, enemies) {
  const hp = buildingHp ?? new Map();
  return baseClearState(base, {
    objectiveDestroyed: isBaseObjectiveDestroyed(base, hp, enemies),
    isDockStanding: (d) => hp.has(axialKey(d.q, d.r)),
    enemies,
  });
}

// #356: the completion rule the mission and the run win check now BOTH use, replacing bare
// `isBaseObjectiveDestroyed`. Note this composes deliberately with #355: gates still latch open on
// the OBJECTIVE alone (owner's explicit call), which is now strictly a help rather than a
// contradiction — the base opens up at step 1 and stays open for the dock/garrison sweep that
// steps 2 and 3 ask for, instead of the player having to re-breach a sealed ring to finish it.
export function isBaseFullyCleared(base, buildingHp, enemies) {
  return baseClearStateOf(base, buildingHp, enemies).step === CLEAR_DONE;
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
    // #356: drop any stale clear-step line when there's no base left to target, so the HUD can't
    // keep showing the last base's requirement after the run has run off the end.
    if (!base) this.registry.set('baseClear', null);
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
    // — same three radii/stroke widths/colors/alpha as before. #280 playtest follow-up: drawn
    // with `Graphics` + `strokeHexRing` (shared.js), not a `Polygon` shape — `Polygon`'s
    // display-origin math renders an already-centered point set (what `hexCorners` returns)
    // offset up-left by its own radius (see `strokeHexRing`'s comment for the full mechanism).
    // Each ring is a plain `Graphics` object left at its local (0,0) — the marker `container`
    // below (positioned at the real world (x,y)) supplies the actual placement, exactly like the
    // `Polygon` shapes did before.
    const haloRing = strokeHexRing(this.add.graphics(), 33, 3, 0xfbfdff, 0.9);
    const outlineRing = strokeHexRing(this.add.graphics(), 31.5, 2, 0x0b0e14, 0.9);
    const ring = strokeHexRing(this.add.graphics(), 30, 3, UI_HIGHLIGHT_COLOR, 0.9);
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
    // #356: completion is no longer "the objective hex fell" — it is the full ordered clear
    // (objective → every dock → every remaining enemy of this base). `objectiveDestroyed` keeps
    // its name because it is still what `evaluateMission` calls the completion signal; what
    // changed is how much has to be true for it to be set.
    const clear = baseClearStateOf(this._objectiveBase, this.buildingHp, this.enemies);
    const objectiveDestroyed = clear.step === CLEAR_DONE;
    // Publish the live step so HudScene can show the player exactly ONE requirement at a time —
    // crucially, no enemy count until the last dock is down (see data/bases.js for why).
    this.registry.set('baseClear', clear);
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
      strokeHexRing(ring, 30, 3, 0x7bd17b, 0.9);
      const label = this._objectiveMarker.list[3];
      label.setText('CLEARED').setColor('#7bd17b');
    }
  },
};
