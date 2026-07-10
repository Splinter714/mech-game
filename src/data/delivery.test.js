import { describe, it, expect } from 'vitest';
import { planEmissions, makeProjectile, stepProjectile, rotateToward, projectileKind, doubleShotEmissions, homingTurnRate, leadAngle, segmentPointDistance, resolveSeekPoint } from './delivery.js';
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

  it('doubleShotEmissions (#60) doubles the emission count with a staggered twin per shot', () => {
    const base = planEmissions(WEAPONS.autocannon).shots;
    const doubled = doubleShotEmissions(base, 1);
    expect(doubled).toHaveLength(base.length * 2);
    // Each original shot is followed by a delayed twin.
    expect(doubled[0].delay).toBe(base[0].delay);
    expect(doubled[1].delay).toBeGreaterThan(base[0].delay);
  });

  it('doubleShotEmissions tightens spread offsets so a doubled fan reads as a double', () => {
    const base = planEmissions(WEAPONS.shotgun).shots;
    const doubled = doubleShotEmissions(base, 0.5);
    // Original + twin share the tightened (halved) angle offset of their source pellet.
    for (let i = 0; i < base.length; i++) {
      expect(doubled[i * 2].angleOffset).toBeCloseTo(base[i].angleOffset * 0.5);
      expect(doubled[i * 2 + 1].angleOffset).toBeCloseTo(base[i].angleOffset * 0.5);
    }
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

describe('homing steering (#77)', () => {
  it('derives turn rate from speed so the turn radius stays bounded', () => {
    // radius = speed / turn ≈ constant across speeds (until the clamps bite).
    const rSlow = 300 / homingTurnRate(300);
    const rFast = 440 / homingTurnRate(440);
    expect(rSlow).toBeCloseTo(rFast, 0);         // same corner radius regardless of speed
    expect(rFast).toBeLessThan(120);             // far tighter than the old fixed-4-rad/s ~110px orbit
  });

  it('turn rate is clamped to sane bounds', () => {
    expect(homingTurnRate(10)).toBeGreaterThanOrEqual(3.2);   // floor
    expect(homingTurnRate(100000)).toBeLessThanOrEqual(9.0);  // ceiling
  });

  it('leadAngle aims AHEAD of a crossing target, not at its current position', () => {
    // Round at origin flying right; target above moving right (crossing). The intercept bearing
    // must lead — point further along +x than the straight bearing to the target's current spot.
    const direct = Math.atan2(200, 300);                       // bearing to current pos
    const lead = leadAngle(0, 0, 500, 300, 200, 120, 0);       // target moving +x at 120
    expect(lead).toBeLessThan(direct);                         // aims lower/ahead of current pos
  });

  it('leadAngle degrades to the direct bearing for a stationary target', () => {
    expect(leadAngle(0, 0, 500, 300, 200, 0, 0)).toBeCloseTo(Math.atan2(200, 300), 6);
  });

  it('a homing round CONVERGES on a crossing target instead of orbiting it', () => {
    // Simulate a streak-pod-speed missile chasing a target that crosses its path. With the
    // derived turn rate + intercept lead it should close to a hit, not settle into an orbit.
    const speed = 440;
    const p = makeProjectile(WEAPONS.streakPod, 0, 0, 0, { maxDist: 99999 });
    p.arc = false;                                   // isolate the seeker from the arc blend
    const tgt = { x: 300, y: 60, vx: 90, vy: 0 };    // crossing left→right
    let minDist = Infinity;
    for (let i = 0; i < 400; i++) {
      tgt.x += tgt.vx * 0.016; tgt.y += tgt.vy * 0.016;
      const desired = leadAngle(p.x, p.y, p.speed, tgt.x, tgt.y, tgt.vx, tgt.vy);
      stepProjectile(p, 0.016, desired);
      minDist = Math.min(minDist, Math.hypot(p.x - tgt.x, p.y - tgt.y));
      if (minDist < 32) break;
    }
    expect(minDist).toBeLessThan(32);                // reaches hit radius — converges, doesn't orbit
    void speed;
  });

  it('segmentPointDistance catches a fast round that tunnels past the target in one step', () => {
    // A round steps from (-40,0) to (40,0) in one frame; the target sits at (0,0). The END points
    // are 40px away (would miss a 32px hit test), but the SWEPT segment passes through it.
    expect(segmentPointDistance(-40, 0, 40, 0, 0, 0)).toBeCloseTo(0, 6);
    expect(Math.hypot(40, 0)).toBeGreaterThan(32);   // end-point test alone would have missed
  });
});

describe('resolveSeekPoint (#77 follow-up: live tracking, not a spawn-time snapshot)', () => {
  // The bug: "missiles hit where the target was when they were fired, instead of continuing
  // to track." A round's seekTarget must be re-read fresh from the live target handle every
  // frame, not resolved once into a frozen {x,y} at spawn.
  it('re-reads the CURRENT x/y of a live target handle each call, not its spawn-time position', () => {
    const target = { x: 100, y: 0, vx: 0, vy: 0, mech: { isDestroyed: () => false } };
    const atSpawn = resolveSeekPoint(target);
    expect(atSpawn).toMatchObject({ x: 100, y: 0, alive: true });

    // The target moves after the round has already spawned (mutated in place, exactly as the
    // arena's enemy/playerTarget records are updated every frame).
    target.x = 500; target.y = 300; target.vx = 40; target.vy = -20;
    const later = resolveSeekPoint(target);
    expect(later).toMatchObject({ x: 500, y: 300, vx: 40, vy: -20, alive: true });
    expect(later).not.toMatchObject(atSpawn); // proves it's live, not a cached copy
  });

  it('a fixed blind-fire point (no .mech) is returned as-is with zero velocity', () => {
    const point = { x: 42, y: -7 };
    expect(resolveSeekPoint(point)).toEqual({ x: 42, y: -7, vx: 0, vy: 0, alive: true });
  });

  it('flags a live target as dead once its mech is destroyed, so the caller can stop homing', () => {
    const target = { x: 10, y: 10, vx: 0, vy: 0, mech: { isDestroyed: () => true } };
    expect(resolveSeekPoint(target).alive).toBe(false);
  });

  it('null seekTarget resolves to null (dumb-fire round, no lock)', () => {
    expect(resolveSeekPoint(null)).toBeNull();
  });

  it('end-to-end: a homing round steers toward the target\'s CURRENT position at every step, ' +
     'not the position it had when the round spawned', () => {
    // A live target handle exactly like the arena's enemy record: a mutable object the "game
    // loop" moves each frame, referenced by the round's seekTarget (not copied).
    const target = { x: 300, y: 0, vx: 0, vy: 0, mech: { isDestroyed: () => false } };
    const p = makeProjectile(WEAPONS.streakPod, 0, 0, 0, { maxDist: 99999 });
    p.arc = false;

    // Step 1: target hasn't moved yet — the round should steer straight at it.
    let resolved = resolveSeekPoint(target);
    let desired = leadAngle(p.x, p.y, p.speed, resolved.x, resolved.y, resolved.vx, resolved.vy);
    expect(desired).toBeCloseTo(0, 6); // (300,0) from (0,0) is straight ahead

    // Now the "game loop" moves the target far off its spawn line — well away from the spawn
    // position AND from where a straight-ahead round would still be heading.
    target.x = 300; target.y = 400;

    // Re-resolving the SAME seekTarget reference must reflect the target's new position — this
    // is the crux of the fix: a snapshot taken once at spawn (the bug) would still say y=0 here.
    resolved = resolveSeekPoint(target);
    expect(resolved.y).toBe(400); // live, not frozen at the spawn-time y=0

    desired = leadAngle(p.x, p.y, p.speed, resolved.x, resolved.y, resolved.vx, resolved.vy);
    expect(desired).toBeGreaterThan(0.5); // now steers well off the old straight-ahead bearing

    // Drive the round for a while using resolveSeekPoint fresh every frame (as the arena does)
    // and confirm it actually converges on the target's NEW position, proving live tracking end
    // to end rather than merely proving the resolver's return value changed.
    let minDist = Infinity;
    for (let i = 0; i < 400; i++) {
      const r = resolveSeekPoint(target);
      const desiredAngle = leadAngle(p.x, p.y, p.speed, r.x, r.y, r.vx, r.vy);
      stepProjectile(p, 0.016, desiredAngle);
      minDist = Math.min(minDist, Math.hypot(p.x - target.x, p.y - target.y));
      if (minDist < 32) break;
    }
    expect(minDist).toBeLessThan(32); // reaches the target's CURRENT (post-move) position
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
