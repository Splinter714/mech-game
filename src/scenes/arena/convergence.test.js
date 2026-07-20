// #74 — direct-fire convergence clamp. The point-blank toe-in bug: with no floor on the
// convergence distance, an enemy at ~0px range put the convergence point on the mech and
// rotated the off-centre muzzles until they nearly crossed. convergedFireAngle() floors the
// distance at MIN_CONVERGE_DIST so the toe-in stays modest. Pure math, no Phaser/scene.
import { describe, it, expect } from 'vitest';
import {
  convergedFireAngle, MIN_CONVERGE_DIST, CONVERGE_DIST,
  pickConvergeTarget, aimAngleOffset, TARGET_CONE, ENEMY_RANGE_EDGE,
} from './shared.js';

// The worst-case real muzzle: the heavy chassis' arm. Lateral offset r and forward offset f
// in world px, derived from mechLayout arm.x/ y × ARENA_MECH_SCALE(0.34) × ART_SCALE(4):
//   r = |W*0.72*armSpread| * 1.36 ≈ 32.7px,  f ≈ 12.1px  (see locomotion _muzzle / shared.js).
const R = 32.7, F = 12.1;
// Toe-in of a muzzle at lateral offset r, forward offset f, converging at distance `dist`
// (relative to the turret facing = 0 here, mech at origin).
const toeDeg = (dist) => {
  const ang = convergedFireAngle(0, 0, 0, dist, F, R);   // muzzle at (f, r), turret facing +x
  return Math.abs((ang * 180) / Math.PI);
};

describe('convergedFireAngle — point-blank convergence clamp (#74)', () => {
  it('clamps a below-floor distance to MIN_CONVERGE_DIST', () => {
    // dist far below the floor must produce the SAME angle as exactly at the floor.
    const atPointBlank = convergedFireAngle(0, 0, 0, 1, F, R);
    const atFloor = convergedFireAngle(0, 0, 0, MIN_CONVERGE_DIST, F, R);
    expect(atPointBlank).toBeCloseTo(atFloor, 10);
  });

  it('leaves an above-floor distance unchanged', () => {
    // Convergence point at (CONVERGE_DIST, 0), muzzle at (F, R) → angle = atan2(0 - R, CONVERGE_DIST - F).
    const expected = Math.atan2(-R, CONVERGE_DIST - F);
    const got = convergedFireAngle(0, 0, 0, CONVERGE_DIST, F, R);
    expect(got).toBeCloseTo(expected, 10);
    // ...and it differs from the clamped-at-floor angle (proving the floor isn't applied here).
    expect(got).not.toBeCloseTo(convergedFireAngle(0, 0, 0, MIN_CONVERGE_DIST, F, R), 4);
  });

  it('keeps the worst-case (heavy arm) toe-in modest at the floor — not tens of degrees', () => {
    // At the floor the heaviest muzzle should toe in only ~10°, never the ~45–90° near-cross
    // that the un-floored point-blank case produced.
    expect(toeDeg(MIN_CONVERGE_DIST)).toBeLessThan(12);
    expect(toeDeg(MIN_CONVERGE_DIST)).toBeGreaterThan(2);
  });

  it('toe-in only ever DEcreases as the enemy gets closer than the floor (never explodes)', () => {
    const atFloor = toeDeg(MIN_CONVERGE_DIST);
    // Every closer-than-floor distance is clamped, so its toe-in equals the floor's — it can
    // never exceed it. (Without the clamp, dist→0 would send this toward ~90°.)
    for (const dist of [0, 1, 25, 100, MIN_CONVERGE_DIST - 1]) {
      expect(toeDeg(dist)).toBeCloseTo(atFloor, 6);
    }
    // Farther than the floor, convergence tightens the toe LESS (point is farther → straighter).
    expect(toeDeg(CONVERGE_DIST)).toBeLessThan(atFloor);
  });

  it('accepts an explicit minDist override', () => {
    const a = convergedFireAngle(0, 0, 0, 10, F, R, 300);
    const b = convergedFireAngle(0, 0, 0, 300, F, R);
    expect(a).toBeCloseTo(b, 10);
  });
});

// #322 — the targeting priority rule: cone gate, then NEAREST wins, one rule for enemies and
// terrain alike, with enemies scored as modestly closer. Replaces #250's blended enemy score,
// #250's pure-angle terrain score, and #262's focus toggle (all removed). The mech sits at the
// origin facing +x (turretAngle = 0) in every case below; a "terrain" candidate is any plain
// {x, y} (a destructible hex or a base wall span — they're scored identically), and an "enemy"
// candidate is whatever is passed in the enemies list.
describe('pickConvergeTarget — cone gate then nearest wins (#322)', () => {
  it('picks the nearest of two in-cone candidates of the same kind, regardless of who is better aimed', () => {
    const nearOffish = { x: 200, y: 50 };    // ~14° off aim, close
    const farDeadOn = { x: 900, y: 0 };      // perfectly aimed, far
    expect(pickConvergeTarget(0, 0, 0, [], [nearOffish, farDeadOn])).toBe(nearOffish);
    expect(pickConvergeTarget(0, 0, 0, [], [farDeadOn, nearOffish])).toBe(nearOffish);
  });

  it('ignores anything outside the cone even when it is far closer', () => {
    const closeButWide = { x: 30, y: 90 };   // ~72° off aim — well outside the ~20° cone
    const inCone = { x: 600, y: 0 };
    expect(pickConvergeTarget(0, 0, 0, [], [closeButWide, inCone])).toBe(inCone);
  });

  it('returns null when every candidate is outside the cone', () => {
    const behind = { x: -100, y: 0 };
    const wide = { x: 10, y: 100 };
    expect(pickConvergeTarget(0, 0, 0, [behind], [wide])).toBeNull();
  });

  it('gates on TARGET_CONE specifically: just inside qualifies, just outside does not', () => {
    const at = (deg, r = 500) => ({
      x: Math.cos(deg * Math.PI / 180) * r, y: Math.sin(deg * Math.PI / 180) * r,
    });
    const coneDeg = TARGET_CONE * 180 / Math.PI;
    const inside = at(coneDeg - 1), outside = at(coneDeg + 1);
    expect(pickConvergeTarget(0, 0, 0, [], [inside])).toBe(inside);
    expect(pickConvergeTarget(0, 0, 0, [], [outside])).toBeNull();
  });

  it('is symmetric about the aim line (either side of the cone qualifies equally)', () => {
    const left = { x: 500, y: -100 }, right = { x: 500, y: 100 };
    expect(pickConvergeTarget(0, 0, 0, [], [left])).toBe(left);
    expect(pickConvergeTarget(0, 0, 0, [], [right])).toBe(right);
  });

  it('respects maxDist for both pools', () => {
    const farEnemy = { x: 900, y: 0 }, farTerrain = { x: 800, y: 0 };
    expect(pickConvergeTarget(0, 0, 0, [farEnemy], [farTerrain], 200)).toBeNull();
  });

  it('returns null with nothing to pick from at all', () => {
    expect(pickConvergeTarget(0, 0, 0, [], [])).toBeNull();
    expect(pickConvergeTarget(0, 0, 0, null, null)).toBeNull();
  });
});

// The one asymmetry between the pools: an enemy is scored as if ENEMY_RANGE_EDGE × its true
// distance away. This is what makes "a wall right in front of me beats a distant drone" true
// while "the mech and the wall are both roughly there" still resolves to the mech.
describe('pickConvergeTarget — the enemy range edge (#322)', () => {
  it('an enemy at comparable range beats terrain', () => {
    const enemy = { x: 500, y: 0 };
    const terrain = { x: 470, y: 0 };   // genuinely nearer, but only just
    expect(pickConvergeTarget(0, 0, 0, [enemy], [terrain])).toBe(enemy);
  });

  it('terrain much closer than the enemy WINS — the thing #322 exists to fix', () => {
    const drone = { x: 1400, y: 200 };   // in cone, far
    const wall = { x: 150, y: 10 };      // right in front of you
    expect(pickConvergeTarget(0, 0, 0, [drone], [wall])).toBe(wall);
  });

  it('the edge is exactly ENEMY_RANGE_EDGE, applied multiplicatively at any range', () => {
    // Terrain sitting just inside the enemy's discounted distance wins; just outside it loses.
    for (const d of [300, 900, 1500]) {
      const enemy = { x: d, y: 0 };
      const inside = { x: d * ENEMY_RANGE_EDGE - 10, y: 0 };
      const outside = { x: d * ENEMY_RANGE_EDGE + 10, y: 0 };
      expect(pickConvergeTarget(0, 0, 0, [enemy], [inside])).toBe(inside);
      expect(pickConvergeTarget(0, 0, 0, [enemy], [outside])).toBe(enemy);
    }
  });

  it('the edge cannot rescue an out-of-cone enemy', () => {
    const enemy = { x: 100, y: 200 };   // ~63° off aim
    const terrain = { x: 900, y: 0 };
    expect(pickConvergeTarget(0, 0, 0, [enemy], [terrain])).toBe(terrain);
  });

  it('an exact effective-distance tie resolves to the enemy', () => {
    const enemy = { x: 500, y: 0 };
    const terrain = { x: 500 * ENEMY_RANGE_EDGE, y: 0 };
    expect(pickConvergeTarget(0, 0, 0, [enemy], [terrain])).toBe(enemy);
  });

  // The case #322's follow-up exists to fix, stated as geometry rather than as a number: a base
  // ring is ~479px across, so a flyer deep inside a compound sits up to ~480px past the wall span
  // facing you. Pointed at it, it has to win — this is what makes #338's lock-following shots
  // through a wall actually reachable in play.
  it('a flyer anywhere inside a base beats the wall span in front of you', () => {
    // Standoffs from a realistic engagement range down to the point where the ratio breaks: at a
    // 150px standoff a far-corner flyer is 4x the wall's distance and the wall wins again, which
    // is the deliberate non-absolute end of the dial (you are practically touching the wall).
    for (const standoff of [250, 400, 600]) {
      const wall = { x: standoff, y: 0 };
      for (const depth of [0, 240, 480]) {          // near edge, centre, far edge of the ring
        const flyer = { x: standoff + depth, y: 0 };
        expect(pickConvergeTarget(0, 0, 0, [flyer], [wall])).toBe(flyer);
      }
    }
  });

  // The other half of the same dial: it must NOT be enemy-always-wins, which the owner had removed.
  it('terrain you are practically touching still beats a mid-range enemy', () => {
    const rock = { x: 120, y: 0 };
    const mech = { x: 600, y: 0 };                  // 5x farther — well outside the edge
    expect(pickConvergeTarget(0, 0, 0, [mech], [rock])).toBe(rock);
  });

  it('a whole ring of wall spans cannot pull the pick off a mech you are pointed at', () => {
    // 28 spans on a circle around the player (as a base wall ring is) — only the couple ahead of
    // you are even in the cone, and the enemy you're aimed at is nearer than they are.
    const spans = Array.from({ length: 28 }, (_, i) => ({
      x: Math.cos(i / 28 * Math.PI * 2) * 700, y: Math.sin(i / 28 * Math.PI * 2) * 700,
    }));
    const mech = { x: 400, y: 20 };
    expect(pickConvergeTarget(0, 0, 0, [mech], spans)).toBe(mech);
  });
});

describe('aimAngleOffset — shared scoring primitive', () => {
  it('is 0 for a point straight down the turret line', () => {
    expect(aimAngleOffset(0, 0, 0, 100, 0)).toBeCloseTo(0, 10);
  });

  it('is signed and wrapped to (−π, π]', () => {
    expect(aimAngleOffset(0, 0, 0, 0, 100)).toBeCloseTo(Math.PI / 2, 10);
    expect(aimAngleOffset(0, 0, 0, 0, -100)).toBeCloseTo(-Math.PI / 2, 10);
    expect(Math.abs(aimAngleOffset(0, 0, 0, -100, -1))).toBeLessThanOrEqual(Math.PI);
  });
});
