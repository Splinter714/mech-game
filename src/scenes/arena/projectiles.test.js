// #77 follow-up — "tracking missiles should not get blocked by other enemies in the way."
// A homing round with a LIVE locked target (p.seekTarget carries `.mech`, i.e. it's the actual
// enemy handle, not a blind-fire dead-reckoned {x,y} point) must only ever detonate against
// THAT target — a bystander enemy nearer the round's current position must not "steal" the hit.
// ProjectilesMixin has no Phaser dependency (art/index.js is pure canvas-drawing code), so it's
// exercised here directly against a minimal fake ArenaScene `this`.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';
import { WorldMixin } from './world.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile, planEmissions, SALVO_CONVERGE_START_PX, SALVO_CONVERGE_DONE_PX } from '../../data/delivery.js';
import { makeWallEdgeSet, spanTurretMount, SPAN_ROLE_TURRET } from '../../data/wallEdges.js';
import { hexToPixel, neighbors } from '../../data/hexgrid.js';

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

// #377 follow-up — "keep slight separation of the individual missiles warbling until last
// minute they converge on the target." The pure curves are unit-tested in delivery.test.js;
// what matters HERE is the emergent flight behaviour of a whole real salvo: does it actually
// stay spread through the cruise, does it actually tighten at the end, and — the thing that
// would ruin the change — does every round still land on the target?
describe('#377 follow-up: a Swarm Rack salvo separates in flight and converges late', () => {
  // Fire a real 6-round Swarm Rack salvo at a stationary enemy and record, each frame, how far
  // apart the outermost rounds are and how far along their flight they are.
  const flySalvo = (target, maxDist) => {
    const { shots } = planEmissions(WEAPONS.swarmRack);
    const rounds = shots.map((s) => {
      const r = makeProjectile(WEAPONS.swarmRack, 0, 0, s.angleOffset, { maxDist, angleOffset: s.angleOffset });
      r.owner = 'player';
      r.seekTarget = target;
      r.trail = [];
      return r;
    });
    const { scene, damaged } = makeScene({ enemies: [target], projectiles: [...rounds] });
    const samples = [];
    for (let i = 0; i < 2000 && scene.projectiles.length; i++) {
      const live = scene.projectiles;
      const t = Math.max(...live.map((p) => p.dist / p.maxDist));
      const xs = live.map((p) => p.x), ys = live.map((p) => p.y);
      const width = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      samples.push({ t, width, live: live.length });
      scene._updateProjectiles(0.016);
    }
    return { samples, damaged };
  };

  const widthNear = (samples, t) =>
    samples.reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best)).width;

  it('holds a visible gap between the missiles through the cruise, then tightens to nearly ' +
     'nothing by the time they arrive', () => {
    const { samples } = flySalvo(makeEnemy('t', 900, 0), 900);
    const cruise = widthNear(samples, 0.6);
    const arrival = samples[samples.length - 1].width;
    expect(cruise).toBeGreaterThan(30);          // genuinely separated mid-flight
    expect(arrival).toBeLessThan(cruise * 0.5);  // and genuinely converged by the end
  });

  it('every one of the six still HITS — a late converge must not turn the salvo into a ' +
     'scatter of misses', () => {
    const { damaged } = flySalvo(makeEnemy('t', 900, 0), 900);
    expect(damaged.filter((d) => d.target === 't').length).toBe(6);
  });

  it('still converges reliably at short range, where there is far less flight to settle in', () => {
    const { damaged } = flySalvo(makeEnemy('t', 320, 0), 320);
    expect(damaged.filter((d) => d.target === 't').length).toBe(6);
  });

  it('BEGINS converging at the same distance from the target regardless of range — the whole ' +
     'point of keying it to distance instead of flight fraction', () => {
    // Where the salvo is at its WIDEST is where convergence takes over from the natural
    // outward drift — i.e. the onset. Keyed to remaining distance that onset sits at the same
    // px-from-target at any range. Keyed to flight fraction it would scale with range: t=0.72
    // is ~196px out on a 700px lob but ~448px out on a 1600px one.
    // Each round rolls a random wobble phase, which jitters exactly where the measured peak
    // falls. Seed it so both ranges fly identical wobble, leaving RANGE as the only variable —
    // otherwise this measures noise as much as it measures the converge onset.
    const onsetDistance = (range) => {
      let seed = 12345;
      const rnd = vi.spyOn(Math, 'random').mockImplementation(() => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      });
      const target = makeEnemy('t', range, 0);
      const { shots } = planEmissions(WEAPONS.swarmRack);
      const rounds = shots.map((sh) => {
        const r = makeProjectile(WEAPONS.swarmRack, 0, 0, sh.angleOffset, { maxDist: range, angleOffset: sh.angleOffset });
        r.owner = 'player'; r.seekTarget = target; r.trail = [];
        return r;
      });
      const { scene } = makeScene({ enemies: [target], projectiles: [...rounds] });
      let widest = -1, atDist = 0;
      for (let i = 0; i < 3000 && scene.projectiles.length; i++) {
        const live = scene.projectiles;
        const xs = live.map((p) => p.x), ys = live.map((p) => p.y);
        const width = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        const rem = Math.min(...live.map((p) => Math.hypot(target.x - p.x, target.y - p.y)));
        if (width > widest) { widest = width; atDist = rem; }
        scene._updateProjectiles(0.016);
      }
      rnd.mockRestore();
      return atDist;
    };
    const shortLob = onsetDistance(700);
    const longLob = onsetDistance(1600);
    // Same distance from the target, within a frame or two of travel.
    expect(Math.abs(shortLob - longLob)).toBeLessThan(60);
    // ...and that distance is the tuned trigger, not some accident of the flight.
    for (const d of [shortLob, longLob]) {
      expect(d).toBeGreaterThan(SALVO_CONVERGE_DONE_PX);
      expect(d).toBeLessThan(SALVO_CONVERGE_START_PX + 60);
    }
  });

  it('leaves a weapon that never opted in flying exactly as it did — a Streak Pod volley is ' +
     'not spread by this at all', () => {
    const target = makeEnemy('t', 900, 0);
    const { shots } = planEmissions(WEAPONS.streakPod);
    for (const s of shots) {
      const r = makeProjectile(WEAPONS.streakPod, 0, 0, s.angleOffset, { maxDist: 900, angleOffset: s.angleOffset });
      expect(r.aimOffset).toBe(0);
    }
    expect(target.id).toBe('t');
  });
});

// #426: wall turrets are hittable from ANY side, like a flying unit (commit 9fb928e) — their
// own wall never blocks a shot aimed at them, including one fired from BEHIND (inside the
// compound); the earlier "exposed side only" gate was deliberately removed (`turretBlocked` is
// now hardcoded `false` in projectiles.js). This exercises the real WorldMixin geometry
// (`_wallEdgeHit`/`_isWallForRound`/`hittingItsGun`) against real wallEdges.js state, composed
// with ProjectilesMixin — the same "real geometry, minimal scene" approach wallTurrets.test.js
// uses for the turret's own LOS.
describe('#426 a wall turret is hittable from any side, like a flying unit', () => {
  function makeWallScene(gunOverrides = {}) {
    const A = { q: 0, r: 0 };            // base-interior hex
    const B = neighbors(A.q, A.r)[0];    // outer hex — the exposed side
    const set = makeWallEdgeSet([{ a: A, b: B, baseId: 'base0', role: SPAN_ROLE_TURRET }]);
    const edge = [...set.edges.values()][0];
    const mount = spanTurretMount(edge);
    const damaged = [];
    const gun = {
      id: 'gun', x: mount.x, y: mount.y, vx: 0, vy: 0,
      spanKey: edge.key, mech: { isDestroyed: () => false },
      ...gunOverrides,
    };
    const scene = {
      enemies: [gun],
      projectiles: [],
      firePatches: [],
      px: 0, py: 0,
      mech: { isDestroyed: () => false },
      time: { now: 0 },
      projFx: { clear: vi.fn() },
      terrain: new Map(),
      wallEdges: set,
      _rangeFactor: () => 1,
    };
    // Mixins FIRST — `_wallEdgeHit`/`_isWallForRound`/`_spanExposedTo`/`_hexKeyAt` are the REAL
    // implementations under test, run against the real `wallEdges` set built above. The FX/damage
    // methods they call out to are stubbed AFTER, same convention as wallTurrets.test.js.
    Object.assign(scene, WorldMixin, ProjectilesMixin);
    scene._damageBuildingAt = vi.fn();
    scene._damageWallEdge = vi.fn(() => false);
    scene._impactFx = vi.fn();
    scene._damagePlayerAt = vi.fn();
    scene._damageEnemyAt = vi.fn((e, x, y, dmg) => damaged.push({ target: e.id, dmg }));
    scene._drawProjectile = vi.fn();
    return { scene, gun, edge, set, damaged, inner: hexToPixel(A.q, A.r), outer: hexToPixel(B.q, B.r) };
  }

  function fireAt(scene, gun, fromX, fromY) {
    const angle = Math.atan2(gun.y - fromY, gun.x - fromX);
    const round = makeProjectile(WEAPONS.railLance, fromX, fromY, angle, { maxDist: 2000 });
    round.owner = 'player';
    round.trail = [];
    round.originHexes = [];
    round.originX = fromX;
    round.originY = fromY;
    round._lastHexKey = 'origin';
    scene.projectiles = [round];
    for (let i = 0; i < 400 && scene.projectiles.length && !scene.projectiles[0].dead; i++) {
      scene._updateProjectiles(0.016);
    }
    return round;
  }

  it('a round fired from the EXPOSED (outward) side hits the gun through its own wall', () => {
    const { scene, gun, damaged, outer } = makeWallScene();
    const from = { x: gun.x + (outer.x - gun.x) * 4, y: gun.y + (outer.y - gun.y) * 4 };
    fireAt(scene, gun, from.x, from.y);
    expect(damaged.some((d) => d.target === 'gun')).toBe(true);
    expect(scene._damageBuildingAt).not.toHaveBeenCalled();
  });

  it('a round fired from BEHIND (the inward/base-interior side) also hits the gun through its own wall', () => {
    // Deliberately changed by commit 9fb928e: `turretBlocked` is now hardcoded `false`, and the
    // `hittingItsGun` crossing-exemption carries no side restriction — a round aimed at the gun's
    // own span connects regardless of which side it was fired from.
    const { scene, gun, damaged, inner } = makeWallScene();
    const from = { x: gun.x + (inner.x - gun.x) * 4, y: gun.y + (inner.y - gun.y) * 4 };
    fireAt(scene, gun, from.x, from.y);
    expect(damaged.some((d) => d.target === 'gun')).toBe(true);
    expect(scene._damageBuildingAt).not.toHaveBeenCalled();
    expect(scene._damageWallEdge).not.toHaveBeenCalled();
  });

  it('an ordinary enemy behind the wall (no spanKey) gets no exemption — the wall still blocks the shot', () => {
    // A bystander well inside the compound, behind the gun's own span (a shape that never occurs
    // in the real game — only wall turrets ride a span — but pins the exemption to the SPECIFIC
    // exempted ENTITY, not "anything near that point"). Fired at from the outward side, exactly
    // the geometry that lets a shot through to the gun: without `spanKey` this bystander gets no
    // pass at all, so the shot detonates on the wall exactly as it always did pre-#426.
    const { scene, gun, inner, outer } = makeWallScene();
    const bystander = { id: 'bystander', x: inner.x, y: inner.y, vx: 0, vy: 0, spanKey: undefined, mech: { isDestroyed: () => false } };
    scene.enemies = [bystander];   // no gun on this span at all — a plain span behind which stands an ordinary enemy
    const from = { x: gun.x + (outer.x - gun.x) * 4, y: gun.y + (outer.y - gun.y) * 4 };
    fireAt(scene, bystander, from.x, from.y);
    expect(scene._damageEnemyAt).not.toHaveBeenCalled();
    expect(scene._damageWallEdge).toHaveBeenCalled();
  });

  it('the exemption never opens a lane through a DIFFERENT span — a second wall still blocks the shot', () => {
    // Mirrors wallTurrets.test.js's LOS assertion ("is still blocked by a DIFFERENT span") but for
    // the player's OWN shot hitting the gun, not the gun's own firing lane.
    const A = { q: 0, r: 0 };
    const B = neighbors(A.q, A.r)[0];
    const C = neighbors(A.q, A.r)[1];   // a second, unrelated span on the same base hex
    const set = makeWallEdgeSet([
      { a: A, b: B, baseId: 'base0', role: SPAN_ROLE_TURRET },
      { a: A, b: C, baseId: 'base0', role: 'wall' },
    ]);
    const gunEdge = [...set.edges.values()].find((e) => e.role === SPAN_ROLE_TURRET);
    const otherEdge = [...set.edges.values()].find((e) => e.role === 'wall');
    const mount = spanTurretMount(gunEdge);
    const damaged = [];
    const gun = { id: 'gun', x: mount.x, y: mount.y, vx: 0, vy: 0, spanKey: gunEdge.key, mech: { isDestroyed: () => false } };
    const scene = {
      enemies: [gun], projectiles: [], firePatches: [], px: 0, py: 0,
      mech: { isDestroyed: () => false }, time: { now: 0 }, projFx: { clear: vi.fn() },
      terrain: new Map(), wallEdges: set, _rangeFactor: () => 1,
    };
    Object.assign(scene, WorldMixin, ProjectilesMixin);
    scene._damageBuildingAt = vi.fn();
    scene._damageWallEdge = vi.fn(() => false);
    scene._impactFx = vi.fn();
    scene._damagePlayerAt = vi.fn();
    scene._damageEnemyAt = vi.fn((e, x, y, dmg) => damaged.push({ target: e.id, dmg }));
    scene._drawProjectile = vi.fn();
    // Fire from squarely behind the OTHER span, aimed through it at the gun.
    const om = { x: (otherEdge.x0 + otherEdge.x1) / 2, y: (otherEdge.y0 + otherEdge.y1) / 2 };
    const from = { x: om.x + (om.x - gun.x) * 3, y: om.y + (om.y - gun.y) * 3 };
    fireAt(scene, gun, from.x, from.y);
    expect(damaged.some((d) => d.target === 'gun')).toBe(false);
    expect(scene._damageWallEdge).toHaveBeenCalled();
  });
});
