// #77 follow-up — "tracking missiles should not get blocked by other enemies in the way."
// A homing round with a LIVE locked target (p.seekTarget carries `.mech`, i.e. it's the actual
// enemy handle, not a blind-fire dead-reckoned {x,y} point) must only ever detonate against
// THAT target — a bystander enemy nearer the round's current position must not "steal" the hit.
// ProjectilesMixin has no Phaser dependency (art/index.js is pure canvas-drawing code), so it's
// exercised here directly against a minimal fake ArenaScene `this`.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile } from '../../data/delivery.js';

function makeEnemy(id, x, y, destroyed = false) {
  return { id, x, y, vx: 0, vy: 0, mech: { isDestroyed: () => destroyed } };
}

// A minimal ArenaScene-shaped `this` — just enough state/methods for _updateProjectiles to run.
function makeScene({ enemies, projectiles, playerDestroyed = false }) {
  const damaged = [];
  const scene = {
    enemies,
    projectiles,
    firePatches: [],
    px: 0, py: 0,
    mech: { isDestroyed: () => playerDestroyed },
    time: { now: 0 },
    projFx: { clear: vi.fn() },
    _hexKeyAt: () => 'h',
    // #168: the per-round wall test moved from `_isWall` to `_isWallForRound`; in an open field
    // (no cover) it never blocks, same as before.
    _isWallForRound: () => false,
    _damageBuildingAt: vi.fn(),
    _impactFx: vi.fn(),
    _damagePlayerAt: vi.fn((dmg) => damaged.push({ target: 'player', dmg })),
    _damageEnemyAt: vi.fn((e, x, y, dmg) => damaged.push({ target: e.id, dmg })),
    _rangeFactor: () => 1,
  };
  Object.assign(scene, ProjectilesMixin);
  // Drawing is pure Phaser canvas art, irrelevant to hit-detection scoping — stub it out
  // AFTER mixing in ProjectilesMixin so it overrides the mixin's real implementation.
  scene._drawProjectile = vi.fn();
  return { scene, damaged };
}

describe('locked homing round hit-detection is scoped to its own seek target (#77 follow-up)', () => {
  it('flies PAST a nearer bystander enemy and hits its own locked target instead', () => {
    const locked = makeEnemy('locked', 300, 0);
    const bystander = makeEnemy('bystander', 40, 5);   // sits almost right on the flight path, much closer
    const { scene, damaged } = makeScene({ enemies: [locked, bystander], projectiles: [] });

    const round = makeProjectile(WEAPONS.streakPod, 0, 0, 0, { maxDist: 9999 });
    round.owner = 'player';
    round.seekTarget = locked;              // a LIVE handle (carries .mech) — this is a real lock
    round.trail = [];
    scene.projectiles = [round];

    // Advance until the round either hits something or times out.
    for (let i = 0; i < 400 && scene.projectiles.length && !scene.projectiles[0].dead; i++) {
      scene._updateProjectiles(0.016);
    }

    // The bystander must never take damage — only the locked target does.
    expect(damaged.some((d) => d.target === 'bystander')).toBe(false);
    expect(damaged.some((d) => d.target === 'locked')).toBe(true);
  });

  it('a dumbfire round (no seekTarget) keeps hitting whatever enemy is nearest — unaffected', () => {
    const near = makeEnemy('near', 60, 0);
    const far = makeEnemy('far', 300, 0);
    const { scene, damaged } = makeScene({ enemies: [near, far], projectiles: [] });

    const round = makeProjectile(WEAPONS.clusterRocket, 0, 0, 0, { maxDist: 9999 });
    round.owner = 'player';
    round.seekTarget = null;
    round.homing = false;
    round.trail = [];
    scene.projectiles = [round];

    for (let i = 0; i < 400 && scene.projectiles.length && !scene.projectiles[0].dead; i++) {
      scene._updateProjectiles(0.016);
    }

    expect(damaged.some((d) => d.target === 'near')).toBe(true);
    expect(damaged.some((d) => d.target === 'far')).toBe(false);
  });

  it('a locked target already destroyed is never credited with the hit (targetGone, not a stale position match)', () => {
    // The target died the instant the round's frame evaluates it — it must not register a hit
    // against the dead target's last position (the pre-existing targetGone/Infinity gate), and
    // per the fix, the earlier bug of falling back to `_nearestEnemy` must not sneak a bystander
    // hit in on this same frame either.
    const locked = makeEnemy('locked', 300, 0, true);   // already destroyed
    const bystander = makeEnemy('bystander', 40, 5);
    const { scene, damaged } = makeScene({ enemies: [locked, bystander], projectiles: [] });

    const round = makeProjectile(WEAPONS.streakPod, 0, 0, 0, { maxDist: 200 });
    round.owner = 'player';
    round.seekTarget = locked;
    round.trail = [];
    scene.projectiles = [round];

    scene._updateProjectiles(0.016);   // just the first frame — the moment death is observed

    expect(damaged.some((d) => d.target === 'locked')).toBe(false);
    expect(damaged.some((d) => d.target === 'bystander')).toBe(false);
  });

  it('two enemies overlapping the same spot: the locked one binds by IDENTITY, not by position', () => {
    // Both enemies sit at the exact same point as the round converges — a purely position-based
    // hit test (the old `_nearestEnemy` re-resolve) can't tell them apart, but object-identity
    // scoping to the actual locked handle always can.
    const locked = makeEnemy('locked', 300, 0);
    const decoy = makeEnemy('decoy', 300, 0);   // same position, different object — must NOT be hit
    const { scene, damaged } = makeScene({ enemies: [decoy, locked], projectiles: [] }); // decoy listed first
    const round = makeProjectile(WEAPONS.streakPod, 0, 0, 0, { maxDist: 9999 });
    round.owner = 'player';
    round.seekTarget = locked;
    round.trail = [];
    scene.projectiles = [round];

    for (let i = 0; i < 400 && scene.projectiles.length && !scene.projectiles[0].dead; i++) {
      scene._updateProjectiles(0.016);
    }

    expect(damaged.some((d) => d.target === 'locked')).toBe(true);
    expect(damaged.some((d) => d.target === 'decoy')).toBe(false);
  });

  it('an enemy-fired round only ever targets the player, regardless of other enemies nearby', () => {
    const other = makeEnemy('other', 10, 0);
    const { scene, damaged } = makeScene({ enemies: [other], projectiles: [] });

    const round = makeProjectile(WEAPONS.streakPod, 0, 0, 0, { maxDist: 300 });
    round.owner = 'enemy';
    round.seekTarget = { x: 300, y: 0, vx: 0, vy: 0 };   // enemy chasing the player
    round.trail = [];
    scene.projectiles = [round];
    scene.px = 300; scene.py = 0;

    for (let i = 0; i < 400 && scene.projectiles.length && !scene.projectiles[0].dead; i++) {
      scene._updateProjectiles(0.016);
    }

    expect(damaged.some((d) => d.target === 'player')).toBe(true);
    expect(damaged.some((d) => d.target === 'other')).toBe(false);
  });
});

// #168: the spatial-index `nearest()` that replaced the full O(enemies) `_nearestEnemy` scan must
// return the EXACT same enemy a brute-force scan would — a performance change, not a behaviour one.
describe('_buildEnemyIndex().nearest matches a brute-force nearest scan (#168)', () => {
  // Brute-force reference: identical to the old `_nearestEnemy` (first-encountered wins ties, but
  // ties are measure-zero here since coordinates are random floats).
  const brute = (enemies, x, y) => {
    let best = null, bd = Infinity;
    for (const e of enemies) {
      if (e.mech.isDestroyed()) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };

  it('agrees with brute force over many random enemy fields and query points', () => {
    // Deterministic PRNG (mulberry32) so the property check is reproducible.
    let s = 0x9e3779b9;
    const rand = () => {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const coord = () => (rand() - 0.5) * 4000;   // spread wider than a single grid cell (160px)

    for (let trial = 0; trial < 300; trial++) {
      const n = Math.floor(rand() * 25);         // 0..24 enemies, incl. the empty case
      const enemies = [];
      for (let i = 0; i < n; i++) {
        // ~30% destroyed, to confirm the index skips them exactly like the scan does.
        enemies.push(makeEnemy('e' + i, coord(), coord(), rand() < 0.3));
      }
      const { scene } = makeScene({ enemies, projectiles: [] });
      const index = scene._buildEnemyIndex();
      for (let q = 0; q < 8; q++) {
        const qx = coord(), qy = coord();
        const got = index.nearest(qx, qy);
        const want = brute(enemies, qx, qy);
        expect(got).toBe(want);   // object identity — same handle, not merely same position
      }
    }
  });
});
