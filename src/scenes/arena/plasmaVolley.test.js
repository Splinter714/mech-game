// #434 — Plasma Arc is a saturating VOLLEY. One trigger pull fires 5 staggered, scattered arcing
// bolts, and — unlike every other weapon (one round per pull) — it spends ONE round PER BOLT and
// TRUNCATES the volley to whatever the magazine can afford. These cover the firing.js half of that:
// the per-bolt ammo spend and the mid-volley cutoff. The planEmissions half (5 staggered spread
// shots) is covered in data/delivery.test.js.
//
// firing.js pulls in phaser + the audio fire-cue scheduler transitively (they throw under vitest's
// node env), so both are stubbed exactly as lobSeek.test.js / flyerCover.test.js do.
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));
vi.mock('../../audio/fireCues.js', () => ({ scheduleFireCues: vi.fn() }));

import { FiringMixin } from './firing.js';
import { WEAPONS } from '../../data/weapons.js';

// A minimal ArenaScene-shaped `this` that runs the REAL fireWeapon end-to-end. `delayedCall` fires
// its callback immediately so a staggered volley's delayed sub-shots all resolve within the call
// (there is no real clock here) — letting us count every emitted bolt. `_spawnProjectile` is spied.
function makeScene() {
  const scene = {
    scene: { isActive: () => true },
    mech: { consumeAmmo: vi.fn() },
    time: { now: 0, delayedCall: (_ms, cb) => cb() },
    px: 0, py: 0,
    convergeTarget: null,   // plasmaCannon is NOT guidance:'homing', so it fires with no lock
  };
  Object.assign(scene, FiringMixin);
  scene._muzzle = () => ({ x: 0, y: 0 });
  scene._fireAngle = () => 0;
  scene._spawnProjectile = vi.fn(() => ({}));
  scene._fireHitscan = vi.fn();
  scene._melee = vi.fn();
  return scene;
}

const W = (ammo) => ({ weapon: WEAPONS.plasmaCannon, location: 'rightArm', index: 0, ammo });

describe('#434 Plasma Arc volley: per-bolt ammo + mid-volley cutoff (firing.js fireWeapon)', () => {
  it('one trigger pull with a full mag emits all 5 bolts and spends 5 rounds', () => {
    const scene = makeScene();
    scene.fireWeapon(W(30));
    expect(scene._spawnProjectile).toHaveBeenCalledTimes(5);
    expect(scene.mech.consumeAmmo).toHaveBeenCalledTimes(1);
    expect(scene.mech.consumeAmmo).toHaveBeenCalledWith('rightArm', 0, 5);
  });

  it('a pull the mag can only partly cover fires ONLY the affordable bolts and spends exactly ' +
     'those (the volley stops when the mag runs dry)', () => {
    const scene = makeScene();
    scene.fireWeapon(W(3));   // only 3 rounds left — the 5-bolt volley must cut to 3
    expect(scene._spawnProjectile).toHaveBeenCalledTimes(3);
    expect(scene.mech.consumeAmmo).toHaveBeenCalledWith('rightArm', 0, 3);
  });

  it('a mag with a single round left still fires one bolt (and spends one)', () => {
    const scene = makeScene();
    scene.fireWeapon(W(1));
    expect(scene._spawnProjectile).toHaveBeenCalledTimes(1);
    expect(scene.mech.consumeAmmo).toHaveBeenCalledWith('rightArm', 0, 1);
  });

  it('each emitted bolt is a real arcing projectile spawn (not a single lob) — every ' +
     '_spawnProjectile call is owner:"player" for the plasmaCannon slot', () => {
    const scene = makeScene();
    const w = W(30);
    scene.fireWeapon(w);
    for (const call of scene._spawnProjectile.mock.calls) {
      expect(call[0]).toBe(w);          // the weapon descriptor
      expect(call[4]).toBe('player');   // owner
    }
  });
});
