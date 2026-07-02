// Arena mission mixin (#66) — wires the pure Mission model (data/mission.js) into the
// live arena: designates one of the world's destructible outposts as THE objective,
// watches for it leaving `this.buildingHp` (i.e. destroyed — see world.js
// `_damageBuildingAt`), and evaluates the mission each frame. Methods use `this` (the
// ArenaScene); composed onto the prototype via Object.assign, same as the other mixins.
//
// #66 is objective-only: the arena never feeds `playerDead` (that's the run-loop's job,
// #64), so this mission can only ever go active → complete, never → failed, for now.
import { makeMission, evaluateMission } from '../../data/mission.js';
import { axialKey, hexToPixel } from '../../data/hexgrid.js';

export const MissionMixin = {
  // One-time init from ArenaScene.create(), AFTER _buildWorld() has populated
  // `this.buildingHp`. Picks the objective DETERMINISTICALLY (not randomly) so the smoke
  // test can rely on it: the outpost hex whose map key sorts first. `this.buildingHp` is
  // a Map keyed by `axialKey`, built by iterating the world's hex range in a fixed order
  // (see world.js `_buildWorld`), so Map insertion order is already deterministic — just
  // take the first entry.
  _initMission() {
    const hexKeys = [...this.buildingHp.keys()].sort();
    this.objectiveHex = hexKeys[0] ?? null;
    this.mission = makeMission('assault');
    if (this.objectiveHex) this._makeObjectiveMarker(this.objectiveHex);
    this.registry.set('mission', this.mission);
  },

  // A simple, readable beacon over the objective hex: a pulsing amber ring + a small
  // floating label, in the style of the powerup beacons (world-space container, tweened).
  // Kept far simpler than the powerup beacon since this only needs to be findable, not flashy.
  _makeObjectiveMarker(hexKey) {
    const [q, r] = hexKey.split(',').map(Number);
    const { x, y } = hexToPixel(q, r);
    const ring = this.add.circle(0, 0, 30).setStrokeStyle(3, 0xffb84a, 0.9);
    const label = this.add.text(0, -46, 'OBJECTIVE', {
      fontFamily: 'monospace', fontSize: '12px', color: '#ffb84a',
    }).setOrigin(0.5);
    const marker = this.add.container(x, y, [ring, label]);
    marker.setDepth(5);
    this.tweens.add({ targets: ring, scale: 1.35, alpha: 0.35, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this._objectiveMarker = marker;
  },

  // Per-frame: has the objective hex left `buildingHp` (destroyed, per `_damageBuildingAt`)?
  // Feed that into the pure `evaluateMission` and publish the resulting mission to the
  // registry so HudScene can read it. A terminal status is sticky (the model itself won't
  // re-open it), so once complete this just keeps republishing the same status.
  _updateMission() {
    if (!this.mission) return;
    const objectiveDestroyed = this.objectiveHex ? !this.buildingHp.has(this.objectiveHex) : false;
    const wasActive = this.mission.status === 'active';
    // #66: fail path deferred to #64 (the run loop) — no real playerDead signal yet, so this
    // always passes false and the mission can only ever go active → complete for now.
    this.mission.status = evaluateMission(this.mission, { objectiveDestroyed, playerDead: false });
    this.registry.set('mission', this.mission);
    if (wasActive && this.mission.status === 'complete') this._onMissionComplete();
  },

  // Win reaction. Kept deliberately simple (owner's call, #66): no forced return to the
  // garage (that's a #64 run-loop concern) and enemies are left running — the arena just
  // keeps playing as a sandbox after the win, with the marker swapped to a "cleared" look
  // and a banner (drawn by HudScene, reading `mission.status`) announcing it. This avoids
  // any surprising freeze/stop behaviour before the run loop exists to make that call well.
  _onMissionComplete() {
    this._floatText(this.px, this.py - 40, 'MISSION COMPLETE', '#7bd17b');
    if (this._objectiveMarker) {
      const ring = this._objectiveMarker.list[0];
      this.tweens.killTweensOf(ring);
      ring.setStrokeStyle(3, 0x7bd17b, 0.9);
      const label = this._objectiveMarker.list[1];
      label.setText('CLEARED').setColor('#7bd17b');
    }
  },
};
