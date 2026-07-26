// #507 follow-up — Smoke Screen's cloud must actually block the real per-enemy firing-lane
// raycast (`_wallDistanceLos`, world.js), not just the noise-aggro cover it granted before this.
// Composes WorldMixin + StealthMixin onto one fake scene (mirroring world.test.js's minimal
// `terrain`/`time` double) to prove the wiring end to end, rather than only unit-testing
// `smokeBlocksPoint` in isolation (stealth.test.js already does that).
import { describe, it, expect } from 'vitest';
import { WorldMixin } from './world.js';
import { StealthMixin } from './stealth.js';
import { axialKey } from '../../data/hexgrid.js';

function makeScene(players = []) {
  // An all-clear terrain grid — the ONLY thing standing in the ray's way, if anything, is smoke.
  const terrain = new Map();
  for (let q = -10; q <= 10; q++) {
    for (let r = -10; r <= 10; r++) terrain.set(axialKey(q, r), 'grass');
  }
  return Object.assign({ terrain, time: { now: 0 }, players }, WorldMixin, StealthMixin);
}

describe('#507 Smoke Screen blocks the enemy firing-lane raycast', () => {
  it('a clear lane with no smoke is unobstructed', () => {
    const scene = makeScene([]);
    const d = scene._wallDistanceLos(0, 0, 0, 300, 300, 0);
    expect(d).toBe(Infinity);
  });

  it('a cloud sitting in the lane blocks it, same as a wall would', () => {
    const scene = makeScene([{ smokeCloud: { x: 150, y: 0, radius: 50 } }]);
    const d = scene._wallDistanceLos(0, 0, 0, 300, 300, 0);
    expect(d).toBeLessThan(Infinity);
    expect(d).toBeGreaterThanOrEqual(90);   // roughly where the ray first enters the 50px-radius cloud
    expect(d).toBeLessThanOrEqual(110);
  });

  it('a cloud OFF to the side of the lane does not block it', () => {
    const scene = makeScene([{ smokeCloud: { x: 150, y: 400, radius: 50 } }]);
    const d = scene._wallDistanceLos(0, 0, 0, 300, 300, 0);
    expect(d).toBe(Infinity);
  });

  it('ANY live player\'s cloud blocks it, not just the shooter/target\'s own', () => {
    const scene = makeScene([
      { smokeCloud: null },
      { smokeCloud: { x: 150, y: 0, radius: 50 } },
    ]);
    const d = scene._wallDistanceLos(0, 0, 0, 300, 300, 0);
    expect(d).toBeLessThan(Infinity);
  });

  it('feeds through _cachedLosToPlayer exactly like a wall would (LOS reads false)', () => {
    const scene = makeScene([{ smokeCloud: { x: 150, y: 0, radius: 50 } }]);
    const e = {};
    scene._cachedLosToPlayer(e, 0, 0, 0, 0, 300, 300, 0);   // seed
    expect(e._losClear).toBe(false);
  });
});
