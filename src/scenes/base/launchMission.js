// #509/#510: GarageScene no longer launches a run itself — this is now the ONLY place a run
// actually starts, reached by hitting Deploy on a selected card in MissionSelectScene. Mirrors
// the launch tail GarageScene.deploy() used to own (biome set, run reset, coop keys,
// MECH_DEPLOYED event) minus the co-op handoff/build-validation UI, which only make sense
// inside an actual Garage editing session. `biomeId` is the player's OWN pick (replaces the
// blind pickNextBiome() auto-pick the base's scanner hex used before #510 existed).
import { ACTIVE_MECH_KEY } from '../../data/rosters.js';
import { PLAYER_MECH_KEYS } from '../../data/coopGarage.js';
import { MECH_DEPLOYED, OUTPOSTS_KEY } from '../../data/events.js';
import { RECENCY_WINDOW } from '../../data/biomes.js';
import { saveAllMechs, saveOutposts } from '../../data/save.js';
import { resolveAllUndefendedLosses, rollRegarrisonForBiome } from '../../data/outposts.js';

export function launchMission(scene, biomeId, isDeep = false) {
  const allMechs = scene.registry.get('allMechs');
  const mech = allMechs?.[ACTIVE_MECH_KEY];
  if (!mech || !mech.isComplete()) {
    scene.scene.start('GarageScene');   // nothing valid to deploy yet — go build first
    return;
  }
  // #349: whichever builds GarageScene last published as ready (its own finish action sets
  // this before returning to base) — falls back to solo if the base was reached without ever
  // visiting Garage this session. Every co-op slot gets repaired here, same as Garage's own
  // blanket repair on entry, so a player 2+ build coming back from a prior run deploys healthy.
  const coopMechKeys = scene.registry.get('coopMechKeys') ?? [ACTIVE_MECH_KEY];
  for (const key of PLAYER_MECH_KEYS) allMechs[key]?.repairAll();
  saveAllMechs(allMechs);
  const n = scene.registry.get('deployCount') || 0;
  scene.registry.set('deployCount', n + 1);
  const history = scene.registry.get('biomeHistory') || [];
  scene.registry.set('biomeHistory', [...history, biomeId].slice(-RECENCY_WINDOW));
  scene.registry.set('arenaBiome', biomeId);
  scene.registry.set('run', null);
  scene.registry.set('coopMechKeys', coopMechKeys);
  // #514: flagged so run.js's _endRun knows a WIN here should count toward unlocking the next
  // biome. Set unconditionally (not just when true) so a later non-deep deploy can't inherit a
  // stale flag from a previous sortie.
  scene.registry.set('deepMission', !!isDeep);
  // #509 Stage 5: there's no dedicated "defend" mission yet, so committing to ANY mission while
  // an outpost is under attack counts as not defending it — resolves every currently-attacked
  // outpost's loss check right here. A real defend-mission type (future work) would exempt
  // itself from this by resolving its OWN target outpost differently instead of calling this.
  const outposts = scene.registry.get(OUTPOSTS_KEY) ?? [];
  const resolved = resolveAllUndefendedLosses(outposts);
  // #519: regarrison — an escalating percentage chance PER DEPLOYMENT (not real time) that a
  // claimed base in the biome about to be deployed into flips back to contested. Rolled here, once
  // per deploy, for every base sharing this `biomeId` — "the point [the deploy flow] already
  // builds the corridor" per the issue; this is that point (world-gen itself, scenes/arena/
  // world.js, only ever reads the outposts already in the registry, it never rolls anything).
  const regarrisoned = rollRegarrisonForBiome(resolved, biomeId);
  if (regarrisoned !== outposts) {
    scene.registry.set(OUTPOSTS_KEY, regarrisoned);
    saveOutposts(regarrisoned);
  }
  scene.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
  scene.scene.start('ArenaScene');
}
