// #293 — the turret's FIRE DECISION used to have no line-of-sight requirement at all
// (enemyBehaviors.js's turretBehavior called aimAndFire with needLos: false), by design, on the
// theory that "the shell doesn't need LOS to reach the target, so the turret doesn't either."
// That conflated two separate things: the shell's own arcing flight physics (still lobs over/
// through cover once fired — projectiles.js's `if (!p.arc)` gate, untouched by this fix) vs. the
// DECISION to open fire, which had no gate at all — the turret could blast the player through
// solid walls from anywhere in its huge 2400px range the instant it woke. Fix: turretBehavior now
// passes needLos: true, so the fire decision runs the same shared `_cachedLosToPlayer` gate every
// other needLos:true kind (tank/carrier/infantry) already uses. These tests exercise the real
// `turretBehavior` (via ENEMY_BEHAVIORS.turret) end-to-end against the real aimAndFire.
//
// enemies.js has a vestigial `import Phaser from 'phaser'` whose top-level device detection
// throws under vitest's node env, so Phaser is stubbed with just the bit aimAndFire actually
// calls (Phaser.Math.Angle.Wrap), same convention as mutualCollision.test.js.
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { ENEMY_BEHAVIORS } from './enemyBehaviors.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';

// A turret enemy record shaped like the real one the arena builds from ENEMY_KINDS.wallTurret,
// sitting dead ahead of the player (bearing 0) and already on-target (turret angle 0) so the
// `onTarget` gate in aimAndFire never masks the LOS behavior this test is actually proving.
function makeTurret({ dist = 500 } = {}) {
  const kindDef = ENEMY_KINDS.wallTurret;
  return {
    key: 'testTurret', kind: 'turret', behavior: 'turret',
    fireCd: 0, x: 0, y: 0, turret: 0, vx: 0, vy: 0,
    kindDef,
  };
}

function makeCtx(dist) {
  return { dt: 0.016, delta: 16, dxp: dist, dyp: 0, dist, bearing: 0, ux: 1, uy: 0 };
}

function makeScene({ hasLos }) {
  return {
    enemyFire: true,
    // #304: aimAndFire now asks the scene through this gate (debug toggle AND the player-dead
    // stand-down clock) rather than reading `enemyFire` raw — player alive here, so it's open.
    _enemyFireAllowed: () => true,
    px: 500, py: 0,
    _cachedLosToPlayer: vi.fn(() => hasLos),
    _fireVehicleWeapon: vi.fn(),
  };
}

describe('#293 turretBehavior requires LOS to open fire', () => {
  it('fires when the player is in range AND line of sight is clear (unchanged behavior)', () => {
    const scene = makeScene({ hasLos: true });
    const e = makeTurret();
    const ctx = makeCtx(500);   // well within the turret's 2400px fireRange

    ENEMY_BEHAVIORS.turret(scene, e, ctx);

    expect(scene._cachedLosToPlayer).toHaveBeenCalled();
    expect(scene._fireVehicleWeapon).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire when in range but LOS is blocked by intervening terrain (the #293 fix)', () => {
    const scene = makeScene({ hasLos: false });
    const e = makeTurret();
    const ctx = makeCtx(500);   // same in-range distance as above — only LOS differs

    ENEMY_BEHAVIORS.turret(scene, e, ctx);

    expect(scene._cachedLosToPlayer).toHaveBeenCalled();
    expect(scene._fireVehicleWeapon).not.toHaveBeenCalled();
  });

  it('still respects range even with clear LOS: does not fire once the player is beyond fireRange', () => {
    const scene = makeScene({ hasLos: true });
    const e = makeTurret();
    const ctx = makeCtx(3000);  // beyond the turret's 2400px fireRange

    ENEMY_BEHAVIORS.turret(scene, e, ctx);

    expect(scene._fireVehicleWeapon).not.toHaveBeenCalled();
  });

  it('stays stationary regardless of LOS (no locomotion — static emplacement, unchanged)', () => {
    const scene = makeScene({ hasLos: false });
    const e = makeTurret();
    const ctx = makeCtx(500);

    ENEMY_BEHAVIORS.turret(scene, e, ctx);

    expect(e.vx).toBe(0);
    expect(e.vy).toBe(0);
  });
});
