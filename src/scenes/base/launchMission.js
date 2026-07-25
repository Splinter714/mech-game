// #510: launches a chosen mission (MissionSelectScene) straight into ArenaScene — mirrors the
// launch tail of GarageScene.deploy() (biome set, run reset, coop keys, MECH_DEPLOYED event)
// minus the co-op handoff/build-validation UI, which only make sense inside an actual Garage
// editing session. `biomeId` is the player's OWN pick (replaces the blind pickNextBiome()
// auto-pick the base's scanner hex used before #510 existed), but `biomeHistory` is still
// updated with it so GarageScene's own Deploy button — still a valid separate path — keeps
// reading accurate recency data.
import { ACTIVE_MECH_KEY } from '../../data/rosters.js';
import { MECH_DEPLOYED } from '../../data/events.js';
import { RECENCY_WINDOW } from '../../data/biomes.js';
import { saveAllMechs } from '../../data/save.js';

export function launchMission(scene, biomeId) {
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
  scene.registry.set('biomeHistory', [...history, biomeId].slice(-RECENCY_WINDOW));
  scene.registry.set('arenaBiome', biomeId);
  scene.registry.set('run', null);
  scene.registry.set('coopMechKeys', [ACTIVE_MECH_KEY]);
  scene.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
  scene.scene.start('ArenaScene');
}
