import { describe, it, expect } from 'vitest';
import { planEmissions, makeProjectile, stepProjectile, rotateToward, projectileKind, homingTurnRate, leadAngle, segmentPointDistance, resolveSeekPoint, arcMaxDist, arcHomingBlend, ASCENT_END, stepWeakSeek, withinWeakSeekRadius, WEAK_SEEK_TURN_RATE, WEAK_SEEK_RADIUS } from './delivery.js';
import { WEAPONS } from './weapons.js';

describe('planEmissions', () => {
  it('emits a single immediate shot for a plain projectile/hitscan', () => {
    const p = planEmissions(WEAPONS.autocannon);
    expect(p.mode).toBe('projectile');
    expect(p.shots).toHaveLength(1);
    expect(p.shots[0]).toMatchObject({ delay: 0, angleOffset: 0, lateral: 0 });
  });

  it('fans a spread weapon into spreadCount angled shots, centred on the aim line', () => {
    // swarmRack has no spreadJitter, so its fan is the plain deterministic (unjittered)
    // case — shotgun (#101) shares this same deterministic-fan behaviour, verified below.
    const p = planEmissions(WEAPONS.swarmRack);
    expect(p.shots).toHaveLength(WEAPONS.swarmRack.delivery.spreadCount);
    const angles = p.shots.map((s) => s.angleOffset);
    expect(Math.min(...angles)).toBeLessThan(0);
    expect(Math.max(...angles)).toBeGreaterThan(0);
    expect(angles.reduce((a, b) => a + b, 0)).toBeCloseTo(0); // symmetric fan
    expect(p.shots.every((s) => s.lateral === 0)).toBe(true);
  });

  it('fans Scatter Gun\'s pellets into a perfectly even, deterministic fan every trigger pull (#101 correction)', () => {
    // #101 correction: a prior pass jittered each pellet's LAUNCH angle (spreadJitter) for an
    // "organic" feel, but the owner wants the fan itself perfectly even/repeatable — no
    // launch-angle jitter. Instead the organic feel comes from independent per-pellet FLIGHT
    // wobble (see the 'kinematics' describe block below), which never touches these angles.
    const { spreadCount, spreadAngle, spreadJitter } = WEAPONS.shotgun.delivery;
    const cone = (spreadAngle * Math.PI) / 180;

    expect(spreadCount).toBe(7);
    expect(WEAPONS.shotgun.damage).toBe(4.457);   // #259 DPS-squish retune (was 3)
    expect(spreadJitter).toBeUndefined(); // no launch-angle jitter (reverted)

    // Repeated trigger pulls produce the EXACT same evenly-spaced fan every time.
    const runs = Array.from({ length: 20 }, () => planEmissions(WEAPONS.shotgun).shots.map((s) => s.angleOffset));
    const first = runs[0];
    expect(first).toHaveLength(spreadCount);
    for (const angles of runs) expect(angles).toEqual(first);

    // The fan spans exactly ±cone/2 (centred, symmetric) with no random overshoot.
    expect(Math.min(...first)).toBeCloseTo(-cone / 2);
    expect(Math.max(...first)).toBeCloseTo(cone / 2);
    expect(first.reduce((a, b) => a + b, 0)).toBeCloseTo(0);

    // No random emission stagger either — every pellet fires immediately.
    const p = planEmissions(WEAPONS.shotgun);
    expect(p.shots.every((s) => s.delay === 0)).toBe(true);
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

  // #117: the enemy fire loop never consulted planEmissions at all, so EVERY enemy weapon
  // (including a real hitscan weapon like Beam Laser) fired as a travelling projectile via
  // _spawnProjectile. The enemy loop now branches on this same `mode` the player's fireWeapon
  // already used, so a hitscan weapon correctly routes to 'hitscan' (resolved as an instant beam
  // via _fireHitscan) instead of 'projectile' — this is the pure dispatch decision the fix
  // relies on. (Beam Laser itself is no longer enemy-mounted — see plasmaLance in weapons.js and
  // the sniper/artillery loadouts in data/enemies.js for why — but the weapon and its hitscan
  // classification are unchanged, and this same routing applies to any future enemy hitscan
  // mount, e.g. Pulse Laser below.)
  it('routes the Beam Laser to hitscan, not projectile', () => {
    expect(planEmissions(WEAPONS.beamLaser).mode).toBe('hitscan');
  });

  // #117: plasmaLance formalizes the accidental "enemy beamLaser fires as a plasma bolt" look
  // Jackson liked — it must stay a genuine travelling PROJECTILE (not get accidentally
  // reclassified as hitscan later), since the enemy fire loop now actually honors this mode.
  it('routes the new Plasma Lance to projectile, not hitscan', () => {
    expect(planEmissions(WEAPONS.plasmaLance).mode).toBe('projectile');
  });

  // #220: a small spreadJitter was added so the single-lane bolt stream sputters slightly
  // off a perfectly straight line. plasmaLance has no sprayCount/streams>1/cluster/spread,
  // so this must land on the "single continuously-streamed shot" branch of planEmissions —
  // exactly ONE bolt per cadence tick, just with a small random angleOffset — never an
  // accidental multi-pellet spray or fan.
  it('jitters Plasma Lance bolts slightly without spawning extra pellets per shot', () => {
    const { spreadJitter } = WEAPONS.plasmaLance.delivery;
    expect(spreadJitter).toBeGreaterThan(0);
    expect(spreadJitter).toBeLessThanOrEqual(5); // subtle sputter, not a Flamethrower-style cone
    const jitterRad = (spreadJitter * Math.PI) / 180;
    const angles = [];
    for (let i = 0; i < 50; i++) {
      const p = planEmissions(WEAPONS.plasmaLance);
      expect(p.mode).toBe('projectile');
      expect(p.shots).toHaveLength(1); // exactly one bolt per shot, never a spray
      const [s] = p.shots;
      expect(s.lateral).toBe(0); // single lane, no stream offset
      expect(Math.abs(s.angleOffset)).toBeLessThanOrEqual(jitterRad + 1e-9);
      angles.push(s.angleOffset);
    }
    expect(new Set(angles).size).toBeGreaterThan(1); // actually varies shot to shot
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

  it('Scatter Gun pellets each get their OWN independent flight-wobble phase, same mechanism as Cluster Salvo (#101)', () => {
    // #101 correction: pellets launch on the fixed even fan (see planEmissions test above), but
    // each pellet independently sways in FLIGHT — exactly like Cluster Salvo's rockets, just with
    // its own (smaller/faster) amplitude and frequency tuned for a pellet's much shorter flight.
    const plan = planEmissions(WEAPONS.shotgun);
    const rounds = plan.shots.map((s) =>
      makeProjectile(WEAPONS.shotgun, 0, 0, s.angleOffset, { maxDist: 9999 }));
    expect(rounds.every((p) => p.wobble === 'sway')).toBe(true);
    const phases = rounds.map((p) => p.wobblePhase);
    expect(new Set(phases).size).toBeGreaterThan(1); // independent phases, not one shared value

    // Pellet wobble is scaled DOWN in amplitude and UP in frequency relative to Cluster Salvo's,
    // suited to the pellets' much shorter flight time/range.
    const clusterRound = makeProjectile(WEAPONS.clusterRocket, 0, 0, 0, { maxDist: 9999 });
    expect(rounds[0].wobbleAmplitude).toBeLessThan(clusterRound.wobbleAmplitude);
    expect(rounds[0].wobbleFrequency).toBeGreaterThan(clusterRound.wobbleFrequency);

    // The wobble actually nudges a pellet perpendicular to its flight path within a short
    // flight — proves the mechanism does something visually meaningful for a pellet's brief
    // travel time, not just that the flag is set.
    const p = rounds[0];
    for (let i = 0; i < 20; i++) stepProjectile(p, 0.016, null); // ~0.32s, roughly a pellet's max flight time
    expect(p.wobbleOffset).not.toBe(0);
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

describe('arcMaxDist (#77 follow-up: "missile range too low" / "swarm rack flight path too crazy")', () => {
  // The bug: firing.js used to project the target onto THIS SHOT'S OWN launch angle (which for
  // a wide-fan weapon like Swarm Rack, spreadAngle 44°, is deliberately offset from the true
  // target bearing) instead of the weapon's un-offset CENTRE bearing (`aimAngle`, shared by
  // every shot in the fan). That made outer shots see a big perpendicular "miss" to the real
  // target and fall back to a short `range.opt` travel budget instead of the real distance —
  // landing them well short of the target (read as low range) with the homing-blend window
  // squeezed into much less remaining distance for the round with the largest heading error to
  // correct (read as a chaotic flight path).
  const swarm = WEAPONS.swarmRack.delivery;   // spreadAngle 44°, spreadCount 6 → offsets up to ±22°
  const maxRange = WEAPONS.swarmRack.range.max + 40;
  const opt = WEAPONS.swarmRack.range.opt;

  // #77 tuning follow-up: swarmRack's opt/max were 3.5x'd (300/500 → 1050/1750). The target
  // distance below is scaled by the same factor (480 → 1680, ~96% of max, same as before) so it
  // stays between the new opt and max — the geometry this test suite exercises.
  it('a centre (un-offset) shot gets the true straight-line distance to a far target', () => {
    const tgt = { x: 1680, y: 0 };
    expect(arcMaxDist(0, 0, 0, tgt, maxRange, opt)).toBeCloseTo(1680, 0);
  });

  it('BUG (fixed): projecting onto a wide-fan shot\'s OWN offset angle truncates a valid target to `opt`', () => {
    // This reproduces the old, buggy call site — passing the shot's own 22°-offset launch
    // angle as the projection axis instead of the weapon's centre bearing.
    const offsetRad = (22 * Math.PI) / 180;
    const tgt = { x: 1680, y: 0 };                    // dead ahead of the CENTRE bearing (aimAngle=0)
    const buggy = arcMaxDist(0, 0, offsetRad, tgt, maxRange, opt);
    expect(buggy).toBeCloseTo(opt, 0);                // falls back short of the real ~1680px distance
  });

  it('FIX: every shot in the fan gets the full/correct budget when projected onto the CENTRE bearing', () => {
    // Same geometry as the bug case above, but using aimAngle=0 (the shared centre bearing) —
    // exactly what firing.js now passes regardless of each shot's own angleOffset.
    const tgt = { x: 1680, y: 0 };
    for (const offsetDeg of [0, 4.4, 8.8, 13.2, 17.6, 22]) {
      const dist = arcMaxDist(0, 0, 0, tgt, maxRange, opt);
      expect(dist).toBeGreaterThan(opt);              // reaches well past the old opt-only fallback
      expect(dist).toBeCloseTo(1680, 0);
      void offsetDeg; // aimAngle is the same (0) for every shot in the fan — that's the whole fix
    }
  });

  it('a target genuinely behind/far to the side still falls back to `opt`, not the full max range', () => {
    const behind = { x: -200, y: 0 };
    expect(arcMaxDist(0, 0, 0, behind, maxRange, opt)).toBe(opt);
    const wide = { x: 50, y: 400 };   // far off to the side of the centre bearing
    expect(arcMaxDist(0, 0, 0, wide, maxRange, opt)).toBe(opt);
  });
});

describe('Swarm Rack wide-angle-offset flight (#77 follow-up regression guard)', () => {
  // End-to-end simulation of a real Swarm Rack salvo: build rounds at their ACTUAL launch
  // angles (aim line + spreadAngle fan offsets) but give every round the maxDist the FIXED
  // firing.js now computes (arcMaxDist projected onto the shared centre bearing), then fly them
  // with the real arc-homing blend + turn-rate-from-speed steering and confirm the wide-offset
  // rounds converge smoothly — no wild oscillation/overshoot past the target line — same as a
  // narrow-offset round, instead of whipping through an exaggerated last-second correction.
  function simulate(angleOffsetRad, target) {
    const weapon = WEAPONS.swarmRack;
    const aimAngle = 0;                              // the shared centre bearing every shot fans from
    const launchAngle = aimAngle + angleOffsetRad;
    const maxDist = arcMaxDist(0, 0, aimAngle, target, weapon.range.max + 40, weapon.range.opt);
    const p = makeProjectile(weapon, 0, 0, launchAngle, { maxDist });
    p.arc = true;
    // Constant-apex speed re-derivation, mirroring firing.js for an arcing round.
    const flightTime = weapon.range.opt / p.speed;
    p.speed = maxDist / flightTime;
    p.vx = Math.cos(launchAngle) * p.speed; p.vy = Math.sin(launchAngle) * p.speed;
    p.turn = homingTurnRate(p.speed);

    let maxHeadingStep = 0;
    let crossings = 0;               // how many times the round crosses the direct target line
    let prevSign = null;
    const dt = 0.016;
    let minDist = Infinity;
    for (let i = 0; i < 500 && p.dist < p.maxDist; i++) {
      const blend = arcHomingBlend(p.dist / p.maxDist);
      const restoreTurn = p.turn;
      p.turn = p.turn * blend;
      const desired = blend > 0 ? leadAngle(p.x, p.y, p.speed, target.x, target.y) : null;
      const beforeAngle = p.angle;
      stepProjectile(p, dt, desired);
      p.turn = restoreTurn;
      maxHeadingStep = Math.max(maxHeadingStep, Math.abs(rotateToward(beforeAngle, p.angle, 1e9) - beforeAngle));

      const sign = Math.sign(p.y - (target.y / target.x) * p.x || 0);
      if (prevSign != null && sign !== 0 && prevSign !== sign) crossings++;
      if (sign !== 0) prevSign = sign;

      minDist = Math.min(minDist, Math.hypot(p.x - target.x, p.y - target.y));
    }
    return { maxHeadingStep, crossings, minDist, dist: p.dist, maxDist: p.maxDist };
  }

  it('a wide-offset (outer swarm) round converges without an oscillating/overshooting path', () => {
    const target = { x: 400, y: 0 };
    const wide = simulate((22 * Math.PI) / 180, target);
    // Bounded per-step heading correction — no snap/whip turn even with the largest fan offset.
    expect(wide.maxHeadingStep).toBeLessThan(0.35);           // radians/frame, generous smoothness bound
    // Converges close to the target rather than sailing past it repeatedly.
    expect(wide.minDist).toBeLessThan(40);
    // Doesn't cross back and forth over the direct target line more than once or twice —
    // repeated crossings are exactly what "oscillating" looks like.
    expect(wide.crossings).toBeLessThanOrEqual(2);
  });

  it('a wide-offset round gets (approximately) the SAME flight budget as a centred round — not a truncated one', () => {
    const target = { x: 400, y: 0 };
    const centre = simulate(0, target);
    const wide = simulate((22 * Math.PI) / 180, target);
    // Before the fix, the wide shot's maxDist collapsed to `range.opt` (300) while the centre
    // shot's stayed the true ~400 — a large, visible mismatch. After the fix both should be
    // (essentially) the same, since both project onto the shared centre bearing.
    expect(Math.abs(wide.maxDist - centre.maxDist)).toBeLessThan(1);
  });

  it('the homing blend only starts after ASCENT_END and the round is still mostly ballistic before it', () => {
    const target = { x: 400, y: 0 };
    const p = makeProjectile(WEAPONS.swarmRack, 0, 0, (22 * Math.PI) / 180, { maxDist: 400 });
    p.arc = true;
    expect(arcHomingBlend((ASCENT_END - 0.05) * p.maxDist / p.maxDist)).toBe(0);
    expect(arcHomingBlend((ASCENT_END + 0.05) * p.maxDist / p.maxDist)).toBeGreaterThan(0);
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

// #213: Plasma Lance's "very light" per-bolt tracking bias — a DELIBERATELY weak nudge, never
// the real homing/lock-on model above. These tests pin down the steering math in isolation
// (the arena owns finding "nearest enemy to the bolt" every frame; these tests just supply a
// target position and check the bounded rotation).
describe('weak seek (#213 — Plasma Lance)', () => {
  it('is far weaker than the weakest real homing turn rate', () => {
    // WEAK_SEEK_TURN_RATE must stay well under HOMING_TURN_MIN (3.2 rad/s) so this never
    // reads as "real" homing, per Jackson's "very light"/"slight" framing.
    expect(WEAK_SEEK_TURN_RATE).toBeLessThan(1.0);
    expect(WEAK_SEEK_TURN_RATE).toBeLessThan(homingTurnRate(0));
  });

  // #223: playtest verdict on #220's jitter was "angle wobble only, no speed jitter" — Plasma
  // Lance now sets `jitterSpeed: false` so makeProjectile's paired speed-variance branch is
  // gated off for it specifically, while its `spreadJitter` angle wobble (tested elsewhere)
  // stays unconditional. Every bolt should now launch at the EXACT tuned velocity (#219: 580).
  it('launches every Plasma Lance bolt at its exact base velocity — no speed jitter (#223)', () => {
    const { velocity } = WEAPONS.plasmaLance.delivery;
    expect(WEAPONS.plasmaLance.delivery.jitterSpeed).toBe(false);
    for (let i = 0; i < 50; i++) {
      const p = makeProjectile(WEAPONS.plasmaLance, 0, 0, 0, { maxDist: 9999 });
      expect(p.speed).toBe(velocity);
    }
  });

  // Flamethrower is the OTHER spreadJitter user (#46) and should keep its original paired
  // angle+speed variance for the spray-cone feel — confirms the new `jitterSpeed` gate (which
  // defaults to true) doesn't change its behaviour just because Plasma Lance opted out.
  it('still varies each Flamethrower particle\'s launch speed within the bounded jitter range', () => {
    const { velocity } = WEAPONS.flamethrower.delivery;
    const speeds = [];
    for (let i = 0; i < 50; i++) {
      const p = makeProjectile(WEAPONS.flamethrower, 0, 0, 0, { maxDist: 9999 });
      expect(p.speed).toBeGreaterThanOrEqual(velocity * 0.82 - 1e-6);
      expect(p.speed).toBeLessThanOrEqual(velocity * 1.18 + 1e-6);
      speeds.push(p.speed);
    }
    expect(new Set(speeds).size).toBeGreaterThan(1); // actually varies, not fixed at base velocity
  });

  it('plasmaLance opts in to weakSeek and NOT to real homing/lock-on guidance', () => {
    expect(WEAPONS.plasmaLance.delivery.weakSeek).toBe(true);
    expect(WEAPONS.plasmaLance.delivery.guidance).not.toBe('homing');
    // Confirms scoping: no other current weapon accidentally opted in.
    const weakSeekWeapons = Object.values(WEAPONS).filter((w) => w.delivery.weakSeek);
    expect(weakSeekWeapons.map((w) => w.id)).toEqual(['plasmaLance']);
  });

  it('nudges heading a small, bounded amount toward the target each frame', () => {
    const p = makeProjectile(WEAPONS.plasmaLance, 0, 0, 0, { maxDist: 9999 }); // facing +x (angle 0)
    // Target is directly "above" (positive y) — a 90° correction needed.
    stepWeakSeek(p, 0.1, 1000, 1000);
    const expectedStep = WEAK_SEEK_TURN_RATE * 0.1;
    expect(p.angle).toBeGreaterThan(0);                         // turned toward the target...
    expect(p.angle).toBeCloseTo(expectedStep, 5);               // ...but only by the tiny bounded step
    expect(p.angle).toBeLessThan(0.1);                          // nowhere near a hard turn-in
  });

  it('velocity is re-derived from the new heading at the round\'s original speed', () => {
    const p = makeProjectile(WEAPONS.plasmaLance, 0, 0, 0, { maxDist: 9999 });
    const speed = p.speed;
    stepWeakSeek(p, 0.1, 500, 500);
    expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(speed, 5);
  });

  it('re-evaluates continuously as the nearest target changes — the SAME round steers toward ' +
      'whichever point is passed this frame, not a target fixed at spawn', () => {
    const p = makeProjectile(WEAPONS.plasmaLance, 0, 0, 0, { maxDist: 9999 });
    stepWeakSeek(p, 0.05, 0, 1000);           // "nearest enemy" this frame is above
    const afterFirst = p.angle;
    expect(afterFirst).toBeGreaterThan(0);
    stepWeakSeek(p, 0.05, 0, -1000);          // the nearest enemy is now BELOW instead
    expect(p.angle).toBeLessThan(afterFirst); // steers back the other way, no memory of the old target
  });

  it('a target far off the bolt\'s own axis gets barely corrected toward, never run down like a lock', () => {
    // A target almost directly behind the bolt (~170° off-axis) — real homing would snap the
    // full turn-rate-capped step toward it every frame and converge fast; weak seek should
    // barely register over many frames of a short flight.
    const p = makeProjectile(WEAPONS.plasmaLance, 0, 0, 0, { maxDist: 9999 });
    for (let i = 0; i < 10; i++) stepWeakSeek(p, 0.016, -1000, 50); // ~0.16s of flight, target behind+slightly off
    // 10 frames * 0.016s * WEAK_SEEK_TURN_RATE is the hard ceiling on how far it could have turned.
    const maxPossibleTurn = 10 * 0.016 * WEAK_SEEK_TURN_RATE;
    expect(Math.abs(p.angle)).toBeLessThanOrEqual(maxPossibleTurn + 1e-6);
    expect(Math.abs(p.angle)).toBeLessThan(0.15); // reads as "barely a wobble", not a run-down
  });

  it('withinWeakSeekRadius gates out targets beyond the notice radius', () => {
    const p = makeProjectile(WEAPONS.plasmaLance, 0, 0, 0, { maxDist: 9999 });
    expect(withinWeakSeekRadius(p, WEAK_SEEK_RADIUS - 1, 0)).toBe(true);
    expect(withinWeakSeekRadius(p, WEAK_SEEK_RADIUS + 50, 0)).toBe(false);
  });
});

// #243 tunability pass: constants that a single weapon could plausibly want to vary are now
// optional per-weapon `delivery` fields, each defaulting to the shared constant — so every
// existing weapon behaves EXACTLY as before (zero-behavior-change refactor), and a weapon that
// sets the field genuinely deviates.
describe('per-weapon delivery tunables default to the shared constants (#243)', () => {
  it('spreadJitterDelay: default emission stagger stays within the old 35ms cap; an override widens it', () => {
    // Flamethrower (spreadJitter, sprayCount) — its multi-pellet sibling path: use a synthetic
    // jittered SPREAD so the delay branch is exercised deterministically.
    const jittered = { ...WEAPONS.shotgun, delivery: { ...WEAPONS.shotgun.delivery, spreadJitter: 5, wobble: null } };
    for (let i = 0; i < 40; i++) {
      for (const s of planEmissions(jittered).shots) {
        expect(s.delay).toBeGreaterThanOrEqual(0);
        expect(s.delay).toBeLessThanOrEqual(35);
      }
    }
    const wide = { ...jittered, delivery: { ...jittered.delivery, spreadJitterDelay: 500 } };
    let sawPastOldCap = false;
    for (let i = 0; i < 60 && !sawPastOldCap; i++) {
      sawPastOldCap = planEmissions(wide).shots.some((s) => s.delay > 35);
    }
    expect(sawPastOldCap).toBe(true);
  });

  it('speedJitterFrac: default reproduces the exact 0.82–1.18 band; an override narrows it', () => {
    const { velocity } = WEAPONS.flamethrower.delivery;
    for (let i = 0; i < 60; i++) {
      const p = makeProjectile(WEAPONS.flamethrower, 0, 0, 0, { maxDist: 9999 });
      expect(p.speed).toBeGreaterThanOrEqual(velocity * 0.82 - 1e-6);
      expect(p.speed).toBeLessThanOrEqual(velocity * 1.18 + 1e-6);
    }
    const tight = { ...WEAPONS.flamethrower, delivery: { ...WEAPONS.flamethrower.delivery, speedJitterFrac: 0.02 } };
    for (let i = 0; i < 60; i++) {
      const p = makeProjectile(tight, 0, 0, 0, { maxDist: 9999 });
      expect(p.speed).toBeGreaterThanOrEqual(velocity * 0.98 - 1e-6);
      expect(p.speed).toBeLessThanOrEqual(velocity * 1.02 + 1e-6);
    }
  });

  it('burstStaggerDeg: default alternating stagger is exactly the old ±0.3°; an override rescales it', () => {
    const base = planEmissions(WEAPONS.streakPod);
    const oldStaggerRad = (0.3 * Math.PI) / 180;
    base.shots.forEach((s, i) => {
      expect(s.angleOffset).toBeCloseTo(oldStaggerRad * (i % 2 === 0 ? 1 : -1), 10);
    });
    const wide = { ...WEAPONS.streakPod, delivery: { ...WEAPONS.streakPod.delivery, burstStaggerDeg: 3 } };
    const widePlan = planEmissions(wide);
    const wideRad = (3 * Math.PI) / 180;
    widePlan.shots.forEach((s, i) => {
      expect(s.angleOffset).toBeCloseTo(wideRad * (i % 2 === 0 ? 1 : -1), 10);
    });
  });

  it('homingTurnRadius: default turn derives from the old 64px radius; an override changes cornering', () => {
    // homingTurnRate default second arg must equal speed/64 (clamped) — the pre-#243 constant.
    expect(homingTurnRate(320)).toBeCloseTo(320 / 64, 10);
    expect(homingTurnRate(320, 64)).toBe(homingTurnRate(320));
    // A per-weapon radius flows into the round's stamped turn rate.
    const p = makeProjectile(WEAPONS.swarmRack, 0, 0, 0, { maxDist: 9999 });
    expect(p.turn).toBeCloseTo(homingTurnRate(p.speed), 10);
    const lazy = { ...WEAPONS.swarmRack, delivery: { ...WEAPONS.swarmRack.delivery, homingTurnRadius: 200 } };
    const pl = makeProjectile(lazy, 0, 0, 0, { maxDist: 9999 });
    expect(pl.turn).toBeCloseTo(homingTurnRate(pl.speed, 200), 10);
    expect(pl.turn).toBeLessThan(p.turn);   // wider radius ⇒ lazier cornering at the same speed
  });

  it('weakSeekTurnRate/weakSeekRadius: rounds default to the shared constants exactly', () => {
    const p = makeProjectile(WEAPONS.plasmaLance, 0, 0, 0, { maxDist: 9999 });
    expect(p.weakSeekTurnRate).toBe(WEAK_SEEK_TURN_RATE);
    expect(p.weakSeekRadius).toBe(WEAK_SEEK_RADIUS);
  });

  it('weakSeekTurnRate: a per-weapon value drives stepWeakSeek\'s bounded step', () => {
    const strong = { ...WEAPONS.plasmaLance, delivery: { ...WEAPONS.plasmaLance.delivery, weakSeekTurnRate: 1.6 } };
    const p = makeProjectile(strong, 0, 0, 0, { maxDist: 9999 });
    stepWeakSeek(p, 0.1, 1000, 1000);   // 90° correction wanted; step is turnRate-capped
    expect(p.angle).toBeCloseTo(1.6 * 0.1, 5);
    // A raw round with no stamped rate still falls back to the shared constant (old behavior).
    const bare = { x: 0, y: 0, angle: 0, speed: 100, vx: 100, vy: 0 };
    stepWeakSeek(bare, 0.1, 1000, 1000);
    expect(bare.angle).toBeCloseTo(WEAK_SEEK_TURN_RATE * 0.1, 5);
  });

  it('weakSeekRadius: a per-weapon value widens/narrows the notice gate', () => {
    const wide = { ...WEAPONS.plasmaLance, delivery: { ...WEAPONS.plasmaLance.delivery, weakSeekRadius: 500 } };
    const p = makeProjectile(wide, 0, 0, 0, { maxDist: 9999 });
    expect(withinWeakSeekRadius(p, 480, 0)).toBe(true);        // past the old 260 default
    expect(withinWeakSeekRadius(p, 520, 0)).toBe(false);
    // A raw round with no stamped radius keeps the shared-constant gate (old behavior).
    const bare = { x: 0, y: 0 };
    expect(withinWeakSeekRadius(bare, WEAK_SEEK_RADIUS - 1, 0)).toBe(true);
    expect(withinWeakSeekRadius(bare, WEAK_SEEK_RADIUS + 1, 0)).toBe(false);
  });
});
