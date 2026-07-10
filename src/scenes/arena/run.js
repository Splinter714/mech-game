// Arena run mixin (#64) — wires the pure Run model (data/run.js) into the live arena: starts
// or continues a run at create(), feeds the mission model a REAL playerDead signal now that
// the deploy survivability buffer is tuned down, and sequences stage advance (mission
// complete → a FRESHLY REGENERATED map (#81) + a bigger/tougher squad in the SAME arena
// session, continuing from wherever the player is — no teleport) and run-over (player
// destroyed OR final stage cleared → banner, bank currency, return to garage) after a short
// beat so the banners read. Methods use `this` (the ArenaScene); composed onto the
// prototype via Object.assign, same as the other mixins.
import { makeRun, advanceStage, endRunOnDeath, isRunOver, stageDescriptor } from '../../data/run.js';
import { makeMission } from '../../data/mission.js';
import { RUN_CURRENCY_KEY } from '../../data/events.js';
import { saveRunCurrency } from '../../data/save.js';
import { pixelToHex } from '../../data/hexgrid.js';
import { pickFarObjective } from '../../data/worldgen.js';

const STAGE_TRANSITION_DELAY = 3000;   // ms after mission-complete before the next stage loads
const RUN_OVER_DELAY = 3200;           // ms the WIN/DEAD banner holds before returning to garage
// #81: a stage-advance objective must be at least this many hexes from the player's
// continuing position — otherwise "the next standing outpost" could land right next to
// where they're already standing, defeating the whole point of a freshly regenerated map.
// Owner: tunable.
const FAR_OBJECTIVE_MIN_DIST = 6;

export const RunMixin = {
  // One-time init from ArenaScene.create(), AFTER _buildWorld()/_initMission() have set up the
  // first stage's mission the normal way. Continues the in-progress run from the registry (set
  // by a prior stage advance within this same session) or starts a fresh one — GarageScene's
  // deploy() clears any stale run before starting the arena, so "no run in the registry" always
  // means "start clean at stage 0".
  _initRun() {
    this.run = this.registry.get('run') ?? makeRun();
    this.registry.set('run', this.run);
    this._runAdvancing = false;   // guards against double-triggering the stage/over transitions
  },

  // Per-frame (called from update(), after _updateMission()). Feeds the mission model a real
  // death signal, watches for the mission completing (→ advance the run) or the player dying
  // (→ end the run), and republishes `this.run` so HudScene can read stage/status.
  _updateRun() {
    if (!this.run || this._runAdvancing) return;

    if (this.mech.isDestroyed()) {
      if (this.mission && this.mission.status === 'active') {
        // Re-evaluate the mission with the real death signal so it flips to 'failed' too (the
        // pure model already supports this — see data/mission.js evaluateMission).
        this.mission.status = 'failed';
        this.registry.set('mission', this.mission);
      }
      this._endRun('dead');
      return;
    }

    if (this.mission && this.mission.status === 'complete') this._advanceRun();
  },

  // Mission cleared: bank the stage's currency, move to the next stage (or WIN if that was the
  // last one), and — if the run is still active — build a fresh mission + a harder squad in
  // this same arena session after a short beat so the "MISSION COMPLETE" banner reads first.
  _advanceRun() {
    this._runAdvancing = true;
    this.run = advanceStage(this.run);
    this.registry.set('run', this.run);

    if (isRunOver(this.run)) {
      this._endRun('won');
      return;
    }

    const label = stageDescriptor(this.run.stageIndex).label;
    this._floatText(this.px, this.py - 60, `${label} INCOMING`, '#5ec8e0');
    this.time.delayedCall(STAGE_TRANSITION_DELAY, () => this._startNextStage());
  },

  // Build stage N's mission + squad in place — no scene restart, no forced trip to the garage.
  _startNextStage() {
    const desc = stageDescriptor(this.run.stageIndex);

    // #81: regenerate the WHOLE map fresh for this stage — a new seed, new river/lake/forest/
    // outpost arrangement — instead of just picking a new objective inside the same terrain.
    // The player is NOT teleported: the safe-clear zone (normally a fixed ring around world
    // origin) is centred on wherever the mech actually is right now, so the fresh terrain can
    // never strand it in a lake/wall, and it keeps driving from exactly where it finished (its
    // own px/py are never touched here). The biome itself is unchanged — still set once per
    // deploy — only the feature arrangement varies.
    const playerHex = pixelToHex(this.px, this.py);
    this._buildWorld(undefined, playerHex);

    // A fresh objective: the just-rebuilt world's `buildingHp` map (hexKey → remaining HP)
    // holds every outpost the new layout seeded. #81: bias the pick toward one that's
    // actually FAR from the player's continuing position (pickFarObjective, data/worldgen.js)
    // so reaching it takes a real drive across the new terrain, not a step to an adjacent hex.
    // If the fresh layout somehow seeded no outposts at all, fall back to spawning one near
    // the player (same fallback as before, just re-centred).
    let hexKeys = [...this.buildingHp.keys()];
    if (!hexKeys.length) {
      const fresh = this._spawnOutpostAt(playerHex.q, playerHex.r);
      hexKeys = fresh ? [fresh] : [];
    }
    this.objectiveHex = pickFarObjective(hexKeys, playerHex, FAR_OBJECTIVE_MIN_DIST);
    this.mission = makeMission(desc.missionTypeId);
    this.registry.set('mission', this.mission);
    if (this._objectiveMarker) { this._objectiveMarker.destroy(); this._objectiveMarker = null; }
    if (this.objectiveHex) this._makeObjectiveMarker(this.objectiveHex);

    // A new, harder squad (per data/run.js escalation curve), dropped off-screen same as the
    // opening squad. #71: tear down the previous stage's enemies first (views + generated
    // textures) — replacing the array alone leaked every prior stage's corpse sprites onto the
    // display list for the rest of the session, dragging the frame rate down as a run went on.
    for (const e of this.enemies) this._destroyEnemy(e);
    this.enemies = [];
    this._enemiesSpawnedThisStage = 0;   // #87: fresh stage-total counter for the HUD's N/M
    this._spawnSquad(desc.squad);

    this._floatText(this.px, this.py - 40, desc.label, '#7bd17b');
    this._runAdvancing = false;
  },

  // Terminal run state (win or death): republish, bank the run's currency into the persistent
  // save-adjacent registry value the garage reads (full spend/shop UI is #65's job — this issue
  // just needs the number banked and visible), show a banner, and return to the garage after a
  // beat. Clears `run` from the registry so the NEXT deploy starts clean at stage 0.
  _endRun(status) {
    this._runAdvancing = true;
    if (status === 'dead') this.run = endRunOnDeath(this.run);
    this.registry.set('run', this.run);

    const banked = (this.registry.get(RUN_CURRENCY_KEY) || 0) + this.run.currency;
    this.registry.set(RUN_CURRENCY_KEY, banked);
    saveRunCurrency(banked);
    this.registry.set('lastRunResult', { status: this.run.status, currency: this.run.currency });

    const won = this.run.status === 'won';
    const label = won ? 'RUN COMPLETE' : 'RUN OVER';
    const color = won ? '#7bd17b' : '#e2533a';
    this._floatText(this.px, this.py - 50, label, color);
    this.registry.set('runOverBanner', { label, color, currency: this.run.currency });

    this.time.delayedCall(RUN_OVER_DELAY, () => {
      this.registry.set('run', null);
      this.registry.set('runOverBanner', null);
      this.toGarage();
    });
  },
};
