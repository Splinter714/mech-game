// #252 playtest follow-up: "make lobbed weapons actually seek, not just go to the spot that was
// targeted when the shot was initiated." Plasma Cannon and Napalm were `path: 'arcing'` with no
// `guidance` at all — they computed a fixed lob trajectory ONCE at spawn (toward whatever the
// lock's aim point was at that instant, `_lockAimPoint()`) and then flew it ballistically,
// ignoring any later movement of the target. Swarm Rack/Streak Pod already re-steer live every
// frame (`guidance: 'homing'`) through the arcing-homing-blend machinery (data/delivery.js's
// arcHomingBlend/ASCENT_END/HOMING_BLEND_SPAN) — the fix gives Plasma Cannon/Napalm that same
// live steering via a new opt-in, `delivery.tracksLock`, WITHOUT flipping them to
// `guidance: 'homing'` (which would also flip on targetlock.js's no-lock-no-fire gate — these two
// are explicitly meant to keep firing unconditionally, lock or no lock, exactly as before; see
// weapons.js/targetlock.js's own comments).
//
// enemies.js/firing.js pull in Phaser transitively in ways that throw under vitest's node env
// (a vestigial top-level device detection) for some import paths, so phaser + the audio fire-cue
// scheduler are stubbed the same way flyerCover.test.js/vehicleFire.test.js do.
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));
vi.mock('../../audio/fireCues.js', () => ({ scheduleFireCues: vi.fn(), ENEMY_FIRE_GAIN_SCALE: 0.85 }));

import { FiringMixin } from './firing.js';
import { ProjectilesMixin } from './projectiles.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile } from '../../data/delivery.js';

const LOBBERS = [WEAPONS.plasmaCannon, WEAPONS.napalm];

function makeSpawnScene(lockTarget) {
  const scene = {
    projectiles: [],
    px: 300, py: 0,
    _hexKeyAt: () => 'h',
    _lockAimPoint: () => lockTarget,
  };
  Object.assign(scene, FiringMixin);
  return scene;
}

describe('_spawnProjectile: tracksLock opt-in (#252 follow-up)', () => {
  for (const weapon of LOBBERS) {
    const w = { weapon, location: 'rightArm', index: 0 };

    it(`${weapon.id}: dumb-fires (round.homing false) when the player has no lock`, () => {
      const scene = makeSpawnScene(null);
      const round = scene._spawnProjectile(w, 0, 0, 0, 'player');
      expect(round.homing).toBe(false);
      expect(round.seekTarget).toBe(null);
    });

    it(`${weapon.id}: engages live tracking (round.homing true) the instant the player has a lock`, () => {
      const target = { x: 300, y: 0, vx: 0, vy: 0, mech: { isDestroyed: () => false } };
      const scene = makeSpawnScene(target);
      const round = scene._spawnProjectile(w, 0, 0, 0, 'player');
      expect(round.homing).toBe(true);
      expect(round.seekTarget).toBe(target); // the live handle itself, not a snapshot
    });

    it(`${weapon.id}: enemy-fired rounds (the artillery turret) are never switched to tracking`, () => {
      // Enemy call sites never pass a seekOverride for this weapon (enemies.js), and the
      // owner === 'player' gate in _spawnProjectile means tracksLock never engages for them —
      // the turret's shells keep their existing plain ballistic arc, unchanged by this fix.
      const scene = makeSpawnScene(null);
      const round = scene._spawnProjectile(w, 0, 0, 0, 'enemy');
      expect(round.homing).toBe(false);
    });

    it(`${weapon.id}: guidance stays non-'homing' so canFireWeapon's no-lock-no-fire gate is untouched`, () => {
      // See weapons.test.js's dedicated "lobbed-weapon live tracking" coverage for the
      // canFireWeapon-level assertion; this just guards the invariant this fix depends on.
      expect(weapon.delivery.guidance).not.toBe('homing');
      const scene = makeSpawnScene(null);
      expect(() => scene._spawnProjectile(w, 0, 0, 0, 'player')).not.toThrow();
    });
  }
});

function makeEnemy(id, x, y, destroyed = false) {
  return { id, x, y, vx: 0, vy: 0, mech: { isDestroyed: () => destroyed } };
}

// A minimal ArenaScene-shaped `this` — same harness projectiles.test.js uses — so the round runs
// through the REAL _updateProjectiles pipeline (arc-homing blend, turn-rate steering, hit
// detection), not a hand-rolled re-implementation of it.
function makeUpdateScene({ enemies, projectiles }) {
  const damaged = [];
  const scene = {
    enemies,
    projectiles,
    firePatches: [],
    px: 0, py: 0,
    mech: { isDestroyed: () => false },
    time: { now: 0 },
    projFx: { clear: vi.fn() },
    _hexKeyAt: () => 'h',
    _isWallForRound: () => false,
    _damageBuildingAt: vi.fn(),
    _impactFx: vi.fn(),
    _damagePlayerAt: vi.fn((dmg) => damaged.push({ target: 'player', dmg })),
    _damageEnemyAt: vi.fn((e, x, y, dmg) => damaged.push({ target: e.id, dmg })),
    _rangeFactor: () => 1,
  };
  Object.assign(scene, ProjectilesMixin);
  scene._drawProjectile = vi.fn();
  return { scene, damaged };
}

// End-to-end steering check mirroring delivery.test.js's resolveSeekPoint "live tracking, not a
// spawn-time snapshot" test and projectiles.test.js's locked-round harness, but for a tracksLock
// lob rather than a real guidance:'homing' round — proves the round actually curves onto and
// HITS the target's CURRENT position after it relocates mid-flight, using the same
// arcing-homing-blend descent-phase steering Swarm Rack/Streak Pod already rely on.
describe('a tracksLock lob steers onto and hits the live target through flight (#252 follow-up)', () => {
  for (const weapon of LOBBERS) {
    it(`${weapon.id}: hits the target's RELOCATED position, not its spawn-time position`, () => {
      const target = makeEnemy('target', 550, 0);
      const { scene, damaged } = makeUpdateScene({ enemies: [target], projectiles: [] });

      const round = makeProjectile(weapon, 0, 0, 0, { maxDist: 600 });
      round.owner = 'player';
      round.homing = true; // as _spawnProjectile sets it, given a live lock at fire time
      round.seekTarget = target;
      round.trail = [];
      scene.projectiles = [round];

      // The target relocates well off the round's original straight-ahead heading right after
      // launch — the frozen-spawn-snapshot bug this fix closes would have the round keep flying
      // toward (550, 0) forever and miss this relocated target entirely.
      target.x = 450; target.y = 220;

      for (let i = 0; i < 400 && scene.projectiles.length && !scene.projectiles[0].dead; i++) {
        scene._updateProjectiles(0.016);
      }

      expect(damaged.some((d) => d.target === 'target')).toBe(true);
    });

    it(`${weapon.id}: a round with NO lock at spawn time never engages homing, even if a live ` +
       'enemy is right in front of it (dumbfire stays dumbfire)', () => {
      const bystander = makeEnemy('bystander', 60, 0);
      const { scene, damaged } = makeUpdateScene({ enemies: [bystander], projectiles: [] });

      const round = makeProjectile(weapon, 0, 0, 0, { maxDist: 550 });
      round.owner = 'player';
      round.homing = false; // no lock at fire time — _spawnProjectile would leave this false
      round.seekTarget = null;
      round.trail = [];
      scene.projectiles = [round];

      for (let i = 0; i < 400 && scene.projectiles.length && !scene.projectiles[0].dead; i++) {
        scene._updateProjectiles(0.016);
      }

      // A dumbfire lob without a lock still detonates on whatever it reaches ballistically
      // (unchanged pre-existing nearest-enemy hit-test fallback) — this test only pins down that
      // homing/tracking itself never silently turns on with no lock.
      expect(round.homing).toBe(false);
    });
  }
});
