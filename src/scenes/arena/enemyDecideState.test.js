// #212 — Jackson (owner) observed enemies apparently give up pursuing the player once the
// player moves off to another objective, and asked whether a HURT enemy should still keep
// following. Root cause: `_decideEnemyState`'s hurt branch (cover/kite) fired unconditionally
// whenever an enemy was below COVER_HEALTH_TRIGGER or inside its post-hit `hurtUntil` window —
// and since hp never regenerates, a hurt enemy stayed hurt for the rest of the encounter. Once
// the player walked far enough away (tooFar), a hurt enemy would just keep kiting further away
// or camping a local cover spot, NEVER falling through to the existing tooFar->press catch-up
// rule that healthy enemies already get (see case 2 below hurt in _decideEnemyState) — so it
// looked exactly like giving up the chase. The fix: the hurt branch only applies while still in
// engagement range (`hurt && !tooFar`); once the player has actually left it behind, it falls
// through to the same tooFar->press rule as a healthy enemy, closing the distance again. It
// still stays AWARE the whole time (awareness.js's one-way transition, unaffected by this).
//
// Stubbed the same way enemyFireAngle.test.js exercises EnemiesMixin directly against a minimal
// ArenaScene-shaped `this` (real EnemiesMixin methods; the handful of cross-mixin helpers used
// by _decideEnemyState are stubbed).
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));
import { EnemiesMixin } from './enemies.js';
import { Mech } from '../../data/Mech.js';
import { WEAPONS } from '../../data/weapons.js';

const WEAPON = WEAPONS.beamLaser.id;

function makeEnemy({ standoff = 200, role = 'skirmisher', hurtUntil = 0, coverSpot = null } = {}) {
  const mech = new Mech({ chassisId: 'medium', mounts: { rightArm: [WEAPON] } });
  mech.repairAll();
  return {
    key: 'testEnemy', mech, kind: 'mech', x: 0, y: 0, handed: 1,
    role, standoff, allIndirect: false, hurtUntil, coverSpot, goal: null, state: 'flank',
  };
}

// A minimal ArenaScene-shaped `this`, with the player mech fully healthy and no wall/cover in
// reach (so the hurt branch's cover search always misses and it must decide between kite/press).
function makeScene({ px, py, now = 0 } = {}) {
  const playerMech = new Mech({ chassisId: 'medium', mounts: {} });
  playerMech.repairAll();
  const scene = {
    px, py, vx: 0, vy: 0, turretAngle: 0, mech: playerMech,
    time: { now },
  };
  Object.assign(scene, EnemiesMixin);
  scene._wallDistanceLos = () => Infinity;   // full LOS, no walls anywhere
  scene._findCoverSpot = () => null;         // no cover reachable
  return scene;
}

describe('#212 a hurt enemy still resumes pursuit once the player has moved far away', () => {
  it('hurt AND in engagement range (not tooFar): breaks contact (kite), as before', () => {
    const e = makeEnemy({ standoff: 200 });
    const scene = makeScene({ px: 250, py: 0 });   // dist 250, well within standoff*1.45=290

    scene._decideEnemyState(e, 250, 0, 0.2);   // hp 0.2 < COVER_HEALTH_TRIGGER (0.45) => hurt

    expect(e.state).toBe('kite');
  });

  it('hurt AND tooFar (player left to do something else): resumes closing distance (press), not kite/cover', () => {
    const e = makeEnemy({ standoff: 200 });
    const dist = 800;   // way beyond standoff*1.45=290 => tooFar
    const scene = makeScene({ px: dist, py: 0 });

    scene._decideEnemyState(e, dist, 0, 0.2);   // still hurt (hp 0.2)

    expect(e.state).toBe('press');
  });

  it('hurt via the post-hit hurtUntil window (not low hp) also still presses once tooFar', () => {
    const e = makeEnemy({ standoff: 200, hurtUntil: 5000 });   // "just got hit" window still open
    const dist = 800;
    const scene = makeScene({ px: dist, py: 0, now: 1000 });   // now < hurtUntil => hurt

    scene._decideEnemyState(e, dist, 0, 1.0);   // full hp, but within the post-hit window

    expect(e.state).toBe('press');
  });

  it('a healthy enemy already pressed when tooFar (baseline, unaffected by this fix)', () => {
    const e = makeEnemy({ standoff: 200 });
    const dist = 800;
    const scene = makeScene({ px: dist, py: 0 });

    scene._decideEnemyState(e, dist, 0, 1.0);   // full hp, no recent hit

    expect(e.state).toBe('press');
  });
});
