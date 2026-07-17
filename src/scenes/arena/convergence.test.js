// #74 — direct-fire convergence clamp. The point-blank toe-in bug: with no floor on the
// convergence distance, an enemy at ~0px range put the convergence point on the mech and
// rotated the off-centre muzzles until they nearly crossed. convergedFireAngle() floors the
// distance at MIN_CONVERGE_DIST so the toe-in stays modest. Pure math, no Phaser/scene.
import { describe, it, expect } from 'vitest';
import {
  convergedFireAngle, MIN_CONVERGE_DIST, CONVERGE_DIST,
  pickConvergeTarget, nearestToAimLine, aimAngleOffset, pickAimEnemy,
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

// #250 (issue: "destroyable hexes should be potential convergence targets, but lower priority
// than enemies") — pickConvergeTarget is the ranked pick fed to _fireAngle. The mech sits at the
// origin facing +x (turretAngle = 0) for every case below.
describe('pickConvergeTarget — destructible terrain ranks below live enemies (#250)', () => {
  it('picks the enemy over a closer, better-aimed destructible hex when both exist', () => {
    // Hex sits dead-centre on the aim line at 100px (perfectly aimed AND much closer); the enemy
    // is farther and slightly off-line. An enemy must still win regardless.
    const enemy = { x: 300, y: 20 };
    const hexes = [{ x: 100, y: 0 }];
    const picked = pickConvergeTarget(0, 0, 0, enemy, hexes);
    expect(picked).toBe(enemy);
  });

  it('falls back to the nearest-to-aim-line destructible hex when no enemy is available', () => {
    const offLine = { x: 200, y: 150 };     // far off the aim line
    const onLine = { x: 200, y: 5 };        // nearly dead-centre
    const picked = pickConvergeTarget(0, 0, 0, null, [offLine, onLine]);
    expect(picked).toBe(onLine);
  });

  it('returns null when neither an enemy nor a destructible hex is available (prior behavior)', () => {
    expect(pickConvergeTarget(0, 0, 0, null, [])).toBeNull();
  });

  it('respects maxDist when scoring hex fallback candidates', () => {
    const near = { x: 50, y: 30 };   // within range but off-line
    const far = { x: 1000, y: 0 };   // dead on-line but out of range
    const picked = pickConvergeTarget(0, 0, 0, null, [near, far], 200);
    expect(picked).toBe(near);
  });
});

// #262 ("targeting focus mode" toggle, R3/keyboard F): pickConvergeTarget takes an optional
// `focusMode` ('enemy' | 'building'). Omitting it (every test above) must keep the exact #250
// behavior — an enemy always wins over a hex — and passing 'enemy' explicitly must be identical.
// 'building' inverts the ranking: a destructible hex wins over an enemy whenever one is available.
describe('pickConvergeTarget — focusMode (#262)', () => {
  it('defaults to enemy-priority when focusMode is omitted (unchanged #250 behavior)', () => {
    const enemy = { x: 300, y: 20 };
    const hexes = [{ x: 100, y: 0 }];   // closer AND better-aimed than the enemy
    expect(pickConvergeTarget(0, 0, 0, enemy, hexes)).toBe(enemy);
  });

  it('explicit focusMode "enemy" matches the default exactly', () => {
    const enemy = { x: 300, y: 20 };
    const hexes = [{ x: 100, y: 0 }];
    expect(pickConvergeTarget(0, 0, 0, enemy, hexes, Infinity, 'enemy')).toBe(enemy);
  });

  it('focusMode "building" prefers a destructible hex over an enemy, even a closer/better-aimed enemy', () => {
    const hex = { x: 300, y: 20 };      // farther, slightly off-line
    const enemy = { x: 100, y: 0 };     // closer AND dead-centre on the aim line
    const picked = pickConvergeTarget(0, 0, 0, enemy, [hex], Infinity, 'building');
    expect(picked).toBe(hex);
  });

  it('focusMode "building" falls back to the enemy when no hex candidate is available', () => {
    const enemy = { x: 100, y: 0 };
    expect(pickConvergeTarget(0, 0, 0, enemy, [], Infinity, 'building')).toBe(enemy);
  });

  it('focusMode "building" returns null when neither an enemy nor a hex exists', () => {
    expect(pickConvergeTarget(0, 0, 0, null, [], Infinity, 'building')).toBeNull();
  });

  it('focusMode "building" still respects maxDist when scoring hex candidates', () => {
    const enemy = { x: 100, y: 0 };
    const farHex = { x: 1000, y: 0 };   // dead on-line but out of range
    const picked = pickConvergeTarget(0, 0, 0, enemy, [farHex], 200, 'building');
    expect(picked).toBe(enemy);   // hex out of range, so falls back to the enemy
  });
});

// #250 playtest follow-up ("convergence/locking should somewhat prefer closer targets, not just
// strictly follow pure aim precision") — pickAimEnemy blends angular offset (dominant) with
// distance so a meaningfully closer enemy can beat a marginally-better-aimed farther one, while a
// large angular gap still wins regardless of proximity. The mech sits at the origin facing +x
// (turretAngle = 0) for every case below; ASSIST_RANGE (2200) stands in for the real caller's
// maxDist.
describe('pickAimEnemy — blended angle+proximity convergence scoring (#250 follow-up)', () => {
  const ASSIST_RANGE = 2200;
  const at = (dist, angle) => ({ x: dist * Math.cos(angle), y: dist * Math.sin(angle) });

  it('prefers the closer enemy when both share the same angular offset', () => {
    const near = at(300, 0.2);
    const far = at(2000, 0.2);
    expect(pickAimEnemy(0, 0, 0, [near, far], ASSIST_RANGE)).toBe(near);
    // Order-independent.
    expect(pickAimEnemy(0, 0, 0, [far, near], ASSIST_RANGE)).toBe(near);
  });

  it('prefers the better-aimed enemy when both are the same distance away', () => {
    const onAim = at(500, 0.05);
    const offAim = at(500, 0.3);
    expect(pickAimEnemy(0, 0, 0, [onAim, offAim], ASSIST_RANGE)).toBe(onAim);
    expect(pickAimEnemy(0, 0, 0, [offAim, onAim], ASSIST_RANGE)).toBe(onAim);
  });

  it('lets a meaningfully closer target win over a modest angular disadvantage', () => {
    // Far enemy is very precisely aimed (0.05 rad ≈ 2.9°) but at max range; close enemy is only
    // modestly worse-aimed (0.15 rad ≈ 8.6°) but adjacent to the mech. The old pure-angle rule
    // always picked the far, better-aimed enemy — the whole point of this follow-up is that
    // proximity now flips this particular case.
    const farPrecise = at(ASSIST_RANGE, 0.05);
    const closeModest = at(100, 0.15);
    expect(pickAimEnemy(0, 0, 0, [farPrecise, closeModest], ASSIST_RANGE)).toBe(closeModest);
  });

  it('still lets a large angular gap win over proximity — angle stays the dominant factor', () => {
    // Dead-on-aim enemy at max range vs. a wildly off-aim (80°) enemy standing right next to the
    // mech: aim precision must still win here — proximity only breaks MODEST angular gaps, not
    // gaps this large.
    const deadOnFar = at(ASSIST_RANGE, 0);
    const wildOffClose = at(10, 1.4);
    expect(pickAimEnemy(0, 0, 0, [deadOnFar, wildOffClose], ASSIST_RANGE)).toBe(deadOnFar);
  });

  it('respects maxDist, excluding out-of-range candidates entirely', () => {
    const inRange = at(500, 0.4);
    const outOfRange = at(3000, 0);
    expect(pickAimEnemy(0, 0, 0, [outOfRange, inRange], ASSIST_RANGE)).toBe(inRange);
  });

  it('returns null for an empty candidate list', () => {
    expect(pickAimEnemy(0, 0, 0, [], ASSIST_RANGE)).toBeNull();
  });
});

// #250 follow-up integration check: pickConvergeTarget's "enemy always beats a destructible hex"
// ranking (the original #250 behavior, tested above under its own describe block) is structural —
// `if (aimEnemy) return aimEnemy` — so it holds no matter HOW aimEnemy itself was chosen upstream.
// Feed it a blended pickAimEnemy pick (rather than a raw enemy object) to confirm the #252/#250
// wiring is unaffected by this follow-up's change to the enemy-selection scoring itself.
describe('pickAimEnemy -> pickConvergeTarget — enemy still always beats a hex (#250)', () => {
  it('an enemy chosen by the blended score still outranks a closer, better-aimed hex', () => {
    const ASSIST_RANGE = 2200;
    const at = (dist, angle) => ({ x: dist * Math.cos(angle), y: dist * Math.sin(angle) });
    // Two candidate enemies feed pickAimEnemy first (the close one wins on the blended score);
    // a destructible hex sits dead-centre on the aim line, closer than either enemy.
    const farPrecise = at(2000, 0.05);
    const closeModest = at(150, 0.15);
    const aimE = pickAimEnemy(0, 0, 0, [farPrecise, closeModest], ASSIST_RANGE);
    expect(aimE).toBe(closeModest);

    const hex = { x: 50, y: 0 };   // closer AND perfectly on-line — still must lose to the enemy.
    const picked = pickConvergeTarget(0, 0, 0, aimE, [hex]);
    expect(picked).toBe(aimE);
  });
});

describe('nearestToAimLine + aimAngleOffset — shared convergence scoring primitives', () => {
  it('aimAngleOffset is 0 for a point straight down the turret line', () => {
    expect(aimAngleOffset(0, 0, 0, 100, 0)).toBeCloseTo(0, 10);
  });

  it('nearestToAimLine ignores candidates beyond maxDist', () => {
    const inRange = { x: 50, y: 10 };
    const outOfRange = { x: 5, y: 0 };   // perfectly aimed but excluded by a tiny maxDist
    const picked = nearestToAimLine(0, 0, 0, [outOfRange, inRange], 1);
    // Neither passes a 1px maxDist, so null.
    expect(picked).toBeNull();
    expect(nearestToAimLine(0, 0, 0, [outOfRange, inRange], 60)).toBe(outOfRange);
  });

  it('nearestToAimLine returns null for an empty candidate list', () => {
    expect(nearestToAimLine(0, 0, 0, [])).toBeNull();
  });
});
