import { describe, it, expect } from 'vitest';
import { planEmissions, makeProjectile, stepProjectile, rotateToward, projectileKind } from './delivery.js';
import { WEAPONS } from './weapons.js';

describe('planEmissions', () => {
  it('emits a single immediate shot for a plain projectile/hitscan', () => {
    const p = planEmissions(WEAPONS.autocannon);
    expect(p.mode).toBe('projectile');
    expect(p.shots).toHaveLength(1);
    expect(p.shots[0]).toMatchObject({ delay: 0, angleOffset: 0, lateral: 0 });
  });

  it('fans a spread weapon into spreadCount angled shots, centred on the aim line', () => {
    const p = planEmissions(WEAPONS.shotgun);
    expect(p.shots).toHaveLength(WEAPONS.shotgun.delivery.spreadCount);
    const angles = p.shots.map((s) => s.angleOffset);
    expect(Math.min(...angles)).toBeLessThan(0);
    expect(Math.max(...angles)).toBeGreaterThan(0);
    expect(angles.reduce((a, b) => a + b, 0)).toBeCloseTo(0); // symmetric fan
    expect(p.shots.every((s) => s.lateral === 0)).toBe(true);
  });

  it('clusters a dumbfire clump with lateral offsets and ~parallel headings (no fan)', () => {
    const p = planEmissions(WEAPONS.clusterRocket);
    expect(p.shots).toHaveLength(WEAPONS.clusterRocket.delivery.spreadCount);
    expect(p.shots.some((s) => s.lateral !== 0)).toBe(true);
    expect(p.shots.every((s) => Math.abs(s.angleOffset) < 0.05)).toBe(true); // tight, not a cone
    expect(p.shots.every((s) => s.delay === 0)).toBe(true);                  // whole clump launches at once
  });

  it('schedules a multi-pulse burst as delayed sub-shots', () => {
    const { burst } = WEAPONS.pulseLaser.delivery;
    const p = planEmissions(WEAPONS.pulseLaser);
    expect(p.mode).toBe('hitscan');
    expect(p.shots).toHaveLength(burst.count);
    expect(p.shots.map((s) => s.delay)).toEqual(
      Array.from({ length: burst.count }, (_, i) => i * burst.interval),
    );
  });

  it('routes melee to a contact swing', () => {
    const meleeFixture = { delivery: { hit: 'contact', pattern: 'single', kind: 'slash' } };
    expect(planEmissions(meleeFixture).mode).toBe('contact');
  });

  it('emits parallel lanes for a multi-stream weapon — offset laterally, no fan (Repeater)', () => {
    const p = planEmissions(WEAPONS.machineGun);
    const { streams, streamSpacing } = WEAPONS.machineGun.delivery;
    expect(p.shots).toHaveLength(streams);
    expect(p.shots.every((s) => s.angleOffset === 0)).toBe(true);        // parallel, not fanned
    const laterals = p.shots.map((s) => s.lateral);
    expect(laterals.reduce((a, b) => a + b, 0)).toBeCloseTo(0);          // straddles the aim line
    expect(new Set(laterals).size).toBe(streams);                       // distinct lanes
    // Adjacent lanes are exactly streamSpacing apart.
    const sorted = [...laterals].sort((a, b) => a - b);
    expect(sorted[1] - sorted[0]).toBeCloseTo(streamSpacing);
  });

  it('sprays a random handful of simultaneous shots per stream tick (Flamethrower)', () => {
    const { min, max } = WEAPONS.flamethrower.delivery.sprayCount;
    const counts = new Set();
    for (let i = 0; i < 50; i++) {
      const p = planEmissions(WEAPONS.flamethrower);
      expect(p.mode).toBe('projectile');
      expect(p.shots.length).toBeGreaterThanOrEqual(min);
      expect(p.shots.length).toBeLessThanOrEqual(max);
      expect(p.shots.every((s) => s.delay === 0)).toBe(true); // simultaneous, not staggered
      counts.add(p.shots.length);
    }
    expect(counts.size).toBeGreaterThan(1); // actually varies, not a fixed count
  });

  it('jitters each sprayed shot\'s angle so a held trigger stays chaotic, not laser-straight', () => {
    const angles = Array.from({ length: 50 }, () => planEmissions(WEAPONS.flamethrower).shots)
      .flat().map((s) => s.angleOffset);
    expect(angles.some((a) => a !== 0)).toBe(true);
    expect(Math.max(...angles)).toBeGreaterThan(0);
    expect(Math.min(...angles)).toBeLessThan(0);
  });
});

describe('projectileKind', () => {
  it('honours an explicit kind override', () => {
    expect(projectileKind(WEAPONS.napalm)).toBe('fire');
    expect(projectileKind(WEAPONS.railLance)).toBe('rail');
  });
  it('defaults by category/pattern', () => {
    expect(projectileKind(WEAPONS.plasmaCannon)).toBe('plasma');   // energy
    expect(projectileKind(WEAPONS.swarmRack)).toBe('missile');     // missile
    expect(projectileKind(WEAPONS.autocannon)).toBe('slug');       // single ballistic
    expect(projectileKind(WEAPONS.machineGun)).toBe('bullet');     // stream ballistic
  });
});

describe('kinematics', () => {
  it('makeProjectile seeds velocity from speed along the firing angle', () => {
    const p = makeProjectile(WEAPONS.autocannon, 0, 0, 0, { maxDist: 300 });
    expect(p.vx).toBeCloseTo(WEAPONS.autocannon.delivery.velocity);
    expect(p.vy).toBeCloseTo(0);
    expect(p.homing).toBe(false);
    expect(p.maxDist).toBe(300);
  });

  it('stepProjectile integrates position and distance', () => {
    const p = makeProjectile(WEAPONS.autocannon, 0, 0, 0, { maxDist: 9999 });
    stepProjectile(p, 0.1, null);
    expect(p.x).toBeCloseTo(WEAPONS.autocannon.delivery.velocity * 0.1);
    expect(p.dist).toBeCloseTo(WEAPONS.autocannon.delivery.velocity * 0.1);
  });

  it('a homing round steers toward the desired bearing, capped by turn rate', () => {
    const p = makeProjectile(WEAPONS.swarmRack, 0, 0, 1.0, { maxDist: 9999 }); // facing +1 rad
    stepProjectile(p, 0.1, 0);                       // want straight ahead (0)
    expect(p.angle).toBeLessThan(1.0);               // turned toward 0
    expect(p.angle).toBeGreaterThanOrEqual(1.0 - p.turn * 0.1 - 1e-6);
  });

  it('cluster rounds each wobble on their OWN random phase — no lockstep (#51)', () => {
    // Emit one clump, build every round, and confirm the wobble phases aren't all identical
    // (the old bug shared ONE phase across the whole volley, so they snaked in lockstep).
    const plan = planEmissions(WEAPONS.clusterRocket);
    const rounds = plan.shots.map((s) =>
      makeProjectile(WEAPONS.clusterRocket, 0, 0, s.angleOffset, { maxDist: 9999 }));
    expect(rounds.every((p) => p.wobble === 'sway')).toBe(true);
    const phases = rounds.map((p) => p.wobblePhase);
    expect(new Set(phases).size).toBeGreaterThan(1); // independent phases, not one shared value
  });
});

describe('rotateToward', () => {
  it('snaps to target when within one step', () => {
    expect(rotateToward(0, 0.05, 0.1)).toBeCloseTo(0.05);
  });
  it('takes the shortest way across the ±π seam', () => {
    const out = rotateToward(3.0, -3.0, 0.2);        // short way is +0.2 (through π), not -6
    const moved = Math.atan2(Math.sin(out - 3.0), Math.cos(out - 3.0));
    expect(moved).toBeCloseTo(0.2);                  // stepped +0.2 in the short direction
    expect(Math.abs(out)).toBeGreaterThan(3.0);      // wrapped past π to ≈ −3.08
  });
});
