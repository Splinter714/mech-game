// #514: winning a run launched as a deep mission (MissionSelectScene's "DEEP STRIKE" offer)
// credits a deep-mission win. run.js `_endRun` is the single choke point for both win and
// death — this exercises it directly against a minimal fake scene (same style as
// baseClearRun.test.js/mission.test.js), stubbing just what `_endRun` itself touches.
import { describe, it, expect } from 'vitest';
import { RunMixin } from './run.js';
import { makeRun } from '../../data/run.js';
import { DEEP_MISSIONS_WON_KEY } from '../../data/events.js';

function fakeScene(overrides = {}) {
  const registryStore = new Map();
  return Object.assign({
    registry: { get: (k) => registryStore.get(k), set: (k, v) => registryStore.set(k, v) },
    time: { delayedCall: () => ({ remove: () => {} }) },
    toGarage: () => {},
    players: [{ mech: { isDestroyed: () => false } }],
    run: makeRun(),
  }, RunMixin, overrides);
}

describe('#514 a deep-mission WIN credits a deep-mission unlock; nothing else does', () => {
  it('winning with deepMission=true increments and persists DEEP_MISSIONS_WON_KEY', () => {
    const scene = fakeScene();
    scene.registry.set('deepMission', true);
    scene._endRun('won');
    expect(scene.registry.get(DEEP_MISSIONS_WON_KEY)).toBe(1);
  });

  it('winning an ordinary (non-deep) run credits nothing', () => {
    const scene = fakeScene();
    scene.registry.set('deepMission', false);
    scene._endRun('won');
    expect(scene.registry.get(DEEP_MISSIONS_WON_KEY)).toBeUndefined();
  });

  it('dying on a deep mission credits nothing — only a WIN counts', () => {
    const scene = fakeScene();
    scene.registry.set('deepMission', true);
    scene._endRun('dead');
    expect(scene.registry.get(DEEP_MISSIONS_WON_KEY)).toBeUndefined();
  });

  it('successive deep-mission wins accumulate', () => {
    const scene = fakeScene();
    scene.registry.set('deepMission', true);
    scene._endRun('won');
    scene.run = makeRun();
    scene._runAdvancing = false;
    scene._endRun('won');
    expect(scene.registry.get(DEEP_MISSIONS_WON_KEY)).toBe(2);
  });
});
