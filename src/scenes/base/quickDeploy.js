// #509 Stage 1: TEMPORARY placeholder for the base's scanner hex, until #510 (Stage 2) replaces
// it with a real mission-select surface. Launches a run with whatever's already saved as the
// active build, skipping GarageScene's live-edit-session validation (there is no edit session
// on the base map) — mirrors the launch tail of GarageScene.deploy() (biome pick, run reset,
// coop keys, MECH_DEPLOYED event) minus the co-op handoff logic, which only makes sense inside
// an actual Garage editing session.
import { ACTIVE_MECH_KEY } from '../../data/rosters.js';
import { MECH_DEPLOYED } from '../../data/events.js';
import { RECENCY_WINDOW, pickNextBiome } from '../../data/biomes.js';
import { saveAllMechs } from '../../data/save.js';

export function quickDeploy(scene) {
  const allMechs = scene.registry.get('allMechs');
  const mech = allMechs?.[ACTIVE_MECH_KEY];
  if (!mech || !mech.isComplete()) {
    scene.scene.start('GarageScene');   // nothing valid to deploy yet — go build first
    return;
  }
  mech.repairAll();
  saveAllMechs(allMechs);
  const n = scene.registry.get('deployCount') || 0;
  scene.registry.set('deployCount', n + 1);
  const history = scene.registry.get('biomeHistory') || [];
  const biome = pickNextBiome(history, Math.random);
  scene.registry.set('biomeHistory', [...history, biome].slice(-RECENCY_WINDOW));
  scene.registry.set('arenaBiome', biome);
  scene.registry.set('run', null);
  scene.registry.set('coopMechKeys', [ACTIVE_MECH_KEY]);
  scene.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
  scene.scene.start('ArenaScene');
}
