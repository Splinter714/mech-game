// #307 — Barrage on a continuously-held beam (Beam Laser).
//
// A held sustained/stream hitscan keeps ONE persistent beam object that re-pins to the muzzle
// every tick, so it tracks the mech as it turns (#86). That object used to be keyed by
// shooter+location ALONE, which meant Barrage's two parallel lanes shared a key: the second
// lane took the "re-pin the live beam" branch and overwrote the first lane's endpoints. Two
// shots fired, one line rendered — and (confirmed in-game) damage doubled with zero visual
// feedback. The key now carries the lane index, so each lane owns its own persistent beam.
//
// These cover the three things that must hold simultaneously: lanes are distinct, a single
// hold is still ONE object (#86 must not regress), and a lane that stops being planned is
// retired rather than left hanging.
import { describe, it, expect, vi } from 'vitest';
import { FiringMixin } from './firing.js';

// Fixtures are defined by their DELIVERY SHAPE, not by naming a real weapon — the arena
// plumbing (and its tests) must stay weapon-agnostic; see architecture.guard.test.js.
const BEAM_WEAPON = {
  id: 'testSustainedBeam', category: 'energy', damage: 10, range: { min: 0, opt: 400, max: 600 },
  delivery: { hit: 'hitscan', pattern: 'stream', fireRate: 20, sustained: true },
};
const RAIL_WEAPON = {   // hitscan, but NOT continuous — pushes an independent beam per shot
  id: 'testPulsedBeam', category: 'energy', damage: 20, range: { min: 0, opt: 400, max: 600 },
  delivery: { hit: 'hitscan', pattern: 'single', kind: 'rail' },
};

function makeScene() {
  const scene = {
    enemies: [], beams: [], dyingBeams: [],
    px: 300, py: 0,
    mech: { isDestroyed: () => false },
    _hexKeyAt: () => 'h',
    _damagePlayerAt: vi.fn(), _damageEnemyAt: vi.fn(), _impactFx: vi.fn(),
  };
  Object.assign(scene, FiringMixin);
  scene._hitscanReach = vi.fn(() => Infinity);   // no cover in these tests
  return scene;
}

const W = (weapon) => ({ weapon, location: 'rightArm', index: 0 });

describe('#307 a held beam owns one persistent beam object PER PARALLEL LANE', () => {
  it('Barrage\'s two lanes create TWO distinct beams instead of the second stomping the first', () => {
    const scene = makeScene();
    // What fireWeapon does under Barrage: two lanes, straddling laterals, same angle.
    scene._fireHitscan(W(BEAM_WEAPON), 0, -2.5, 0, 'player', 'player', false, false, { lane: 0, lateral: -2.5 });
    scene._fireHitscan(W(BEAM_WEAPON), 0, 2.5, 0, 'player', 'player', false, false, { lane: 1, lateral: 2.5 });

    expect(scene.beams).toHaveLength(2);
    expect(scene.beams.map((b) => b.loc)).toEqual(['player:rightArm:0', 'player:rightArm:1']);
    // Each lane kept its OWN muzzle — the bug was lane 1 overwriting lane 0's endpoints.
    expect(scene.beams[0].y0).toBeCloseTo(-2.5, 3);
    expect(scene.beams[1].y0).toBeCloseTo(2.5, 3);
  });

  it('#86 NOT regressed: repeated ticks of a SINGLE-lane hold keep re-pinning one object', () => {
    const scene = makeScene();
    for (let i = 0; i < 12; i++) {
      scene._fireHitscan(W(BEAM_WEAPON), i, 0, 0, 'player', 'player', false, false, { lane: 0, lateral: 0 });
    }
    expect(scene.beams).toHaveLength(1);
    expect(scene.beams[0].loc).toBe('player:rightArm:0');
    expect(scene.beams[0].x0).toBe(11);   // re-pinned to the latest muzzle, not duplicated
  });

  it('each lane is independently re-pinned across ticks (2 lanes stay 2 objects)', () => {
    const scene = makeScene();
    for (let i = 0; i < 8; i++) {
      scene._fireHitscan(W(BEAM_WEAPON), i, -2.5, 0, 'player', 'player', false, false, { lane: 0, lateral: -2.5 });
      scene._fireHitscan(W(BEAM_WEAPON), i, 2.5, 0, 'player', 'player', false, false, { lane: 1, lateral: 2.5 });
    }
    expect(scene.beams).toHaveLength(2);
    expect(scene.beams[0].x0).toBe(7);
    expect(scene.beams[1].x0).toBe(7);
  });

  it('two shooters in the same location still keep separate beams (#117 unchanged)', () => {
    const scene = makeScene();
    scene._fireHitscan(W(BEAM_WEAPON), 0, 0, 0, 'enemy', 'tankA', false, false, { lane: 0, lateral: 0 });
    scene._fireHitscan(W(BEAM_WEAPON), 0, 0, 0, 'enemy', 'tankB', false, false, { lane: 0, lateral: 0 });
    expect(scene.beams.map((b) => b.loc)).toEqual(['tankA:rightArm:0', 'tankB:rightArm:0']);
  });

  it('a NON-continuous hitscan (rail-style) still pushes independent, unkeyed beams', () => {
    const scene = makeScene();
    scene._fireHitscan(W(RAIL_WEAPON), 0, 0, 0, 'player', 'player', false, false, { lane: 0, lateral: -2.5 });
    scene._fireHitscan(W(RAIL_WEAPON), 0, 0, 0, 'player', 'player', false, false, { lane: 1, lateral: 2.5 });
    expect(scene.beams).toHaveLength(2);
    expect(scene.beams.map((b) => b.loc)).toEqual([null, null]);
  });

  it('defaults to lane 0 when no lane descriptor is passed (enemy call sites, old behaviour)', () => {
    const scene = makeScene();
    scene._fireHitscan(W(BEAM_WEAPON), 0, 0, 0, 'enemy', 'tank', false);
    expect(scene.beams[0].loc).toBe('tank:rightArm:0');
  });
});

describe('#307 retiring lanes that are no longer planned (Barrage expiring mid-hold)', () => {
  it('drops the lanes beyond the new plan\'s lane count, keeping the surviving one', () => {
    const scene = makeScene();
    scene._fireHitscan(W(BEAM_WEAPON), 0, -2.5, 0, 'player', 'player', false, false, { lane: 0, lateral: -2.5 });
    scene._fireHitscan(W(BEAM_WEAPON), 0, 2.5, 0, 'player', 'player', false, false, { lane: 1, lateral: 2.5 });
    expect(scene.beams).toHaveLength(2);

    // Barrage lapses: the plan is back to a single lane.
    scene._retireStaleBeamLanes('player', 'rightArm', 1);
    // Retired via the normal ttl expiry path (projectiles.js filters ttl > 0), so it fades out
    // through the same spark-fade as any other beam rather than vanishing abruptly.
    expect(scene.beams.filter((b) => b.ttl > 0).map((b) => b.loc)).toEqual(['player:rightArm:0']);
  });

  it('leaves a single-lane hold completely alone', () => {
    const scene = makeScene();
    scene._fireHitscan(W(BEAM_WEAPON), 0, 0, 0, 'player', 'player', false, false, { lane: 0, lateral: 0 });
    scene._retireStaleBeamLanes('player', 'rightArm', 1);
    expect(scene.beams.filter((b) => b.ttl > 0)).toHaveLength(1);
  });

  it('never touches another location\'s or another shooter\'s lanes', () => {
    const scene = makeScene();
    scene._fireHitscan(W(BEAM_WEAPON), 0, 0, 0, 'player', 'leftArm', false, false, { lane: 0, lateral: 0 });
    scene._fireHitscan(W(BEAM_WEAPON), 0, 0, 0, 'enemy', 'tank', false, false, { lane: 1, lateral: 0 });
    scene._retireStaleBeamLanes('player', 'rightArm', 1);
    expect(scene.beams.every((b) => b.ttl > 0)).toBe(true);
  });
});

describe('#307 _trackHeldBeam re-pins EVERY lane at its own lateral offset', () => {
  function trackableScene() {
    const scene = makeScene();
    scene._muzzle = () => ({ x: 100, y: 0 });
    scene._fireAngle = () => 0;                       // firing along +x ⇒ lateral is along +y
    scene._liveEnemiesForTrace = () => [];
    return scene;
  }

  it('moves both Barrage lanes to the new muzzle, each keeping its own perpendicular offset', () => {
    const scene = trackableScene();
    scene._fireHitscan(W(BEAM_WEAPON), 0, -2.5, 0, 'player', 'player', false, false, { lane: 0, lateral: -2.5 });
    scene._fireHitscan(W(BEAM_WEAPON), 0, 2.5, 0, 'player', 'player', false, false, { lane: 1, lateral: 2.5 });

    scene._trackHeldBeam(W(BEAM_WEAPON));

    expect(scene.beams).toHaveLength(2);
    for (const b of scene.beams) expect(b.x0).toBeCloseTo(100, 3);
    expect(scene.beams[0].y0).toBeCloseTo(-2.5, 3);
    expect(scene.beams[1].y0).toBeCloseTo(2.5, 3);
    // The two lines stay parallel and distinct — the visible "two beams".
    expect(scene.beams[0].y1).not.toBeCloseTo(scene.beams[1].y1, 3);
  });

  it('a single lane tracks exactly as before (#86), with no lateral offset applied', () => {
    const scene = trackableScene();
    scene._fireHitscan(W(BEAM_WEAPON), 0, 0, 0, 'player', 'player', false, false, { lane: 0, lateral: 0 });
    scene._trackHeldBeam(W(BEAM_WEAPON));
    expect(scene.beams).toHaveLength(1);
    expect(scene.beams[0].x0).toBeCloseTo(100, 3);
    expect(scene.beams[0].y0).toBeCloseTo(0, 3);
  });

  it('is a no-op when the location has no live beam yet (first frame of a hold)', () => {
    const scene = trackableScene();
    expect(() => scene._trackHeldBeam(W(BEAM_WEAPON))).not.toThrow();
    expect(scene.beams).toHaveLength(0);
  });
});
