// #153 — a fired round's travel direction must come from the turret's ACTUAL current
// rendered angle (`e.turret`), not an idealized "aim straight at the player" line
// (`_enemyFireAngle`, with lead prediction). The muzzle's world POSITION already read off
// `e.turret` (via `partMuzzle`), but the shot's direction of travel didn't — so a slow-turning
// mech could land a perfect hit while its gun art was still visibly pointed elsewhere. See the
// fix in enemies.js's fire loop (`aim = e.turret` for direct/LOS fire).
//
// enemies.js has a vestigial `import Phaser from 'phaser'` (grepped: no `Phaser.` reference
// anywhere in the file body — everything routes through the pure `rotateToward` etc. in
// shared.js instead). Phaser's own top-level device-detection code touches `navigator`, which
// throws under vitest's node test environment, so the bare import crashes on load. Stub the
// module out (it's never actually used) so this test can exercise the real EnemiesMixin code
// directly, the same way projectiles.test.js exercises ProjectilesMixin against a minimal
// ArenaScene-shaped `this`.
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));
import { EnemiesMixin } from './enemies.js';
import { Mech } from '../../data/Mech.js';
import { AWARE } from '../../data/awareness.js';
import { WEAPONS } from '../../data/weapons.js';

// Referenced via WEAPONS.<id>.id (not string literals) so this file doesn't trip the
// architecture guard's "arena/*.js never names a specific weapon id" rule (that rule
// exists to keep the SCENE layer weapon-id-free; a test constructing a real Mech still
// needs *some* concrete weapon, so it goes through the registry like the other arena
// tests, e.g. projectiles.test.js's `WEAPONS.streakPod`, do).
const HITSCAN_WEAPON = WEAPONS.beamLaser.id;
const PROJECTILE_WEAPON = WEAPONS.clusterRocket.id;
const INDIRECT_WEAPON = WEAPONS.plasmaCannon.id;

// Smallest signed angular difference a-b, wrapped into (-pi, pi] — used so assertions don't
// break on the +/-pi seam.
function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function makeMechEnemy({ chassisId, mounts, x = 0, y = 0, turret = 0 }) {
  const mech = new Mech({ chassisId, mounts });
  mech.repairAll();
  return {
    key: 'testEnemy', mech, kind: 'mech',
    view: { hull: { rotation: 0 }, turret: { rotation: 0 }, setPosition() {} },
    x, y, vx: 0, vy: 0, angle: turret, turret,
    fireCd: {}, handed: 1, awareness: AWARE,
  };
}

// A minimal ArenaScene-shaped `this`: the REAL EnemiesMixin methods (so `_updateEnemy`'s turret
// slew + fire-loop logic under test is genuine), with the handful of cross-mixin helpers that
// live in OTHER mixins (collision.js/firing.js/projectiles.js — not part of EnemiesMixin, so
// they're simply absent from a bare object) stubbed out.
function makeScene({ px, py, vx = 0, vy = 0, blocked = false }) {
  const hitscan = [];
  const projectiles = [];
  const scene = {
    enemyMove: false,   // skip the whole movement/goal state-machine — irrelevant to firing
    enemyFire: true,
    px, py, vx, vy,
    time: { now: 0, delayedCall: () => {} },
  };
  Object.assign(scene, EnemiesMixin);
  scene._wallDistance = () => (blocked ? 1 : Infinity);   // finite => LOS blocked
  scene._wallDistanceLos = () => (blocked ? 1 : Infinity); // #167 allocation-free variant
  scene._cachedLosToPlayer = () => !blocked;               // #167: mech per-frame LOS is now cached
  scene._losTransparency = () => 0;
  scene._blocked = () => false;
  scene._speedFactorAt = () => 1;
  scene._updateEnemyLock = () => {};                      // don't touch e.lock — tests set it directly
  scene._fireInterval = () => 1000;
  scene._melee = vi.fn();
  scene._fireHitscan = vi.fn((w, mx, my, angle) => hitscan.push(angle));
  scene._spawnProjectile = vi.fn((w, mx, my, angle) => projectiles.push(angle));
  scene._syncTilts = () => {};
  return { scene, hitscan, projectiles };
}

const AIM_ERR_MAX = 0.06;   // half-width of the existing random aimErr wobble ((rand-0.5)*0.12)

describe('enemy direct-fire round direction follows the turret angle, not an idealized aim line (#153)', () => {
  it('a mid-rotation turret fires along ITS OWN current angle, not the direct line to the player', () => {
    // Player straight ahead (direct bearing 0 from the enemy); turret starts rotated 90 deg
    // away, simulating "still catching up" after the player juked. One 16ms frame of the
    // heavy chassis's turretSlew (1.9 rad/s => ~0.03 rad/frame) can't close that gap.
    const e = makeMechEnemy({ chassisId: 'heavy', mounts: { rightArm: [HITSCAN_WEAPON] }, turret: Math.PI / 2 });
    const { scene, hitscan } = makeScene({ px: 300, py: 0 });

    scene._updateEnemy(e, 0.016, 16);

    expect(hitscan.length).toBe(1);
    const fireAngle = hitscan[0];
    // Fired angle must track wherever e.turret actually ended up this frame (+/- aimErr) —
    // NOT the direct bearing to the player (0 rad).
    expect(Math.abs(angDiff(fireAngle, e.turret))).toBeLessThanOrEqual(AIM_ERR_MAX + 1e-9);
    expect(Math.abs(angDiff(fireAngle, 0))).toBeGreaterThan(0.5);
    // Sanity: confirm this really is a mid-rotation scenario (turret hasn't caught up).
    expect(Math.abs(angDiff(e.turret, 0))).toBeGreaterThan(1.0);
  });

  it('a turret already aligned with the player still fires accurately (unaffected baseline case)', () => {
    const e = makeMechEnemy({ chassisId: 'heavy', mounts: { rightArm: [HITSCAN_WEAPON] }, turret: 0 });
    const { scene, hitscan } = makeScene({ px: 300, py: 0 });

    scene._updateEnemy(e, 0.016, 16);

    expect(hitscan.length).toBe(1);
    expect(Math.abs(angDiff(hitscan[0], 0))).toBeLessThanOrEqual(AIM_ERR_MAX + 1e-9);
  });

  it('ignores the lead-predicted aim-at-player angle: fires along the turret even though a fast-moving player would pull the OLD lead math well off it', () => {
    // clusterRocket is a real projectile (velocity 1140) — unlike a hitscan weapon (whose old
    // _enemyFireAngle lead term is always zero anyway), a fast lateral player velocity here
    // pulls the idealized lead angle ~0.34 rad off the direct bearing. Turret is aligned with
    // the direct (un-led) bearing (0). Pre-fix, the fired angle would have come from the lead
    // calc (~0.34 rad); the fix must fire along the turret (0) instead.
    const e = makeMechEnemy({ chassisId: 'heavy', mounts: { rightArm: [PROJECTILE_WEAPON] }, turret: 0 });
    const { scene, projectiles } = makeScene({ px: 300, py: 0, vy: 400 });

    scene._updateEnemy(e, 0.016, 16);

    // #269 playtest follow-up (streams/multi-shot bug fix): clusterRocket is a genuine 5-round
    // cluster (delivery.cluster: true, count: 5) — the enemy fire loop now dispatches
    // EVERY emission in the plan (see enemies.js `_fireEnemyShots`), so one trigger pull spawns
    // all 5 rounds (each with angleOffset 0, just a different lateral clump offset), not just
    // one like the old single-shot-only dispatch did.
    expect(projectiles.length).toBe(5);
    const fireAngle = projectiles[0];
    const oldLeadAngle = Math.atan2(400 * (300 / 1140), 300);   // the pre-fix _enemyFireAngle result
    expect(Math.abs(angDiff(fireAngle, 0))).toBeLessThanOrEqual(AIM_ERR_MAX + 1e-9);
    expect(Math.abs(angDiff(fireAngle, oldLeadAngle))).toBeGreaterThan(0.2);
    // Every round in the cluster fires along the same angle (only lateral offset differs).
    for (const a of projectiles) {
      expect(Math.abs(angDiff(a, fireAngle))).toBeLessThan(1e-9);
    }
  });
});

describe('enemy indirect (lock-based) fire still fires through cover, always along the turret angle (#153, playtest follow-up #252)', () => {
  it('an indirect weapon fires with no LOS (behind cover) as long as it has a live lock, aimed along the turret same as any other shot', () => {
    // plasmaCannon is indirect (path: 'arcing'), so it needs no LOS to fire once it has a target
    // (#252's playtest follow-up dropped the old dead-reckoned "blind fire" aim entirely — there
    // is no more distinct off-turret aim point for a no-LOS shot; every shot, direct or indirect,
    // fires along the turret's actual current angle, #153).
    const e = makeMechEnemy({ chassisId: 'heavy', mounts: { leftTorso: [INDIRECT_WEAPON] }, turret: 0 });
    // A live (#252: convergence-mirroring) lock — just needs a target, no last-known/blind state.
    e.lock = { target: 'player' };
    // LOS currently blocked (behind cover) but close/in-range, so the indirect fire gate is
    // satisfied purely by having a lock, with no LOS requirement at all.
    const { scene, projectiles } = makeScene({ px: 50, py: 0, blocked: true });

    scene._updateEnemy(e, 0.016, 16);

    expect(projectiles.length).toBe(1);
    const fireAngle = projectiles[0];
    // Fires along the turret's own current angle (0), same as a direct-fire shot would.
    expect(Math.abs(angDiff(fireAngle, e.turret))).toBeLessThanOrEqual(AIM_ERR_MAX + 1e-9);
  });

  it('an indirect weapon with no lock at all (player out of lock range) does not fire despite being in weapon range', () => {
    const e = makeMechEnemy({ chassisId: 'heavy', mounts: { leftTorso: [INDIRECT_WEAPON] }, turret: 0 });
    e.lock = { target: null };
    const { scene, projectiles } = makeScene({ px: 50, py: 0, blocked: true });

    scene._updateEnemy(e, 0.016, 16);

    expect(projectiles.length).toBe(0);
  });
});
