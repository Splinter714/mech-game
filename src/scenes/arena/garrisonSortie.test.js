// #332 — "turn the garrison thing off; let them come out and fight".
//
// #331 diagnosed the cause: travel DIRECTION was routed, but the DECISION to travel was not. A
// ground unit measured its firing standoff to the player as the crow flies — straight THROUGH its
// own base wall — concluded it was already at its ideal range, and strafed against the inside of
// the wall indefinitely. A tank's standoff is 300px and a base's wall ring is only ~181px in
// radius, so with the player anywhere near a compound EVERY defender believed it had already
// arrived.
//
// The fix measures the standoff along the ROUTE instead. `ctx.travelDist` is how far the player is
// along the path the unit would actually drive; `ctx.dist` stays the true straight line and still
// drives aim, range checks and LOS. The two are the same number whenever the line to the player is
// clear — which is every open-field engagement — so the open field is unchanged by construction,
// and that is what the last test here pins down.
//
// enemyBehaviors.js imports Phaser only for `Phaser.Math.Angle.Wrap`; stubbed as the other arena
// test files do.
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { ENEMY_BEHAVIORS } from './enemyBehaviors.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';

function makeScene() {
  return {
    enemyFire: false,
    _enemyFireAllowed: () => false,
    _cachedLosToPlayer: () => false,
    _fireVehicleWeapon: vi.fn(),
  };
}

function makeUnit(kind) {
  return {
    kind, kindDef: ENEMY_KINDS[kind], x: 0, y: 0, vx: 0, vy: 0,
    angle: 0, turret: 0, handed: 1,
    // Infantry mill on a randomised per-trooper orbit angle (`_jitterAt`/`_orbitAng`). Pin both so
    // the two sides of the open-field comparison below differ only by what is under test.
    _jitterAt: 99999, _orbitAng: 0.7,
  };
}

// The player sits due east at `dist`; `travelDist` is how far away he is along the route, and
// `tux/tuy` is the routed travel heading. In the garrison case the route leads NORTH — out through
// the gate — even though the player is due east through the wall.
function makeCtx({ dist, travelDist, heading = 0 }) {
  return {
    dt: 0.016, delta: 16,
    dxp: dist, dyp: 0, dist, bearing: 0, ux: 1, uy: 0,
    tux: Math.cos(heading), tuy: Math.sin(heading),
    travelDist,
  };
}

// How much of the movement intent is committed along the travel heading (the "advance" component)?
// Positive = driving toward the player along the route; ~0 or negative = holding/backing off.
function advanceAlong(intent, heading = 0) {
  return intent.mx * Math.cos(heading) + intent.my * Math.sin(heading);
}

// The three ground kinds a base actually fields out of the dock pools. Helicopters and drones fly
// (they were never blocked by a wall), and turrets cannot travel at all — neither is touched here.
const GROUND_KINDS = ['tank', 'carrier', 'infantry'];

describe('#332 — a walled-in garrison unit sorties instead of holding station', () => {
  for (const kind of GROUND_KINDS) {
    it(`${kind}: advances along the routed way out when the player is close in a straight line but far by road`, () => {
      const scene = makeScene();
      const e = makeUnit(kind);
      // The #331 geometry: the player is 250px away through the wall (inside every ground kind's
      // standoff, which is why this unit used to hold), but 700px of driving away out via the
      // gate, which lies to the north.
      const north = -Math.PI / 2;
      ENEMY_BEHAVIORS[kind](scene, e, makeCtx({ dist: 250, travelDist: 700, heading: north }));
      // It commits toward the gate rather than milling in place.
      expect(advanceAlong({ mx: e.vx, my: e.vy }, north)).toBeGreaterThan(0);
    });

    it(`${kind}: with no wall in the way (travel distance == straight line) it behaves exactly as before`, () => {
      // Same unit, same close range — but out in the open the route IS the straight line, so it
      // must make the same call it always did: it is at its firing standoff, so it does not close.
      const before = makeUnit(kind);
      const after = makeUnit(kind);
      // `ctx.travelDist` absent = a caller that never routed (the pre-#332 shape); present and
      // equal to `dist` = the open-field routed case. Both must produce identical movement.
      const legacyCtx = makeCtx({ dist: 250, travelDist: undefined });
      const openFieldCtx = makeCtx({ dist: 250, travelDist: 250 });
      ENEMY_BEHAVIORS[kind](makeScene(), before, legacyCtx);
      ENEMY_BEHAVIORS[kind](makeScene(), after, openFieldCtx);
      expect(after.vx).toBeCloseTo(before.vx, 6);
      expect(after.vy).toBeCloseTo(before.vy, 6);
    });
  }

  for (const kind of GROUND_KINDS) {
    it(`${kind}: keeps closing while it has no line of fire, even once the route is inside its standoff`, () => {
      // The half that route distance alone does NOT solve, and it was measured in the real game
      // before this existed: a tank wants to sit 300px from the player, and 300px measured ALONG a
      // route that leaves through the gate still puts it inside its own wall with no shot. It
      // advanced to the gate mouth and stopped there. Holding a firing standoff you cannot fire
      // from is hiding, not holding — so with no firing lane it closes regardless of the band.
      const scene = makeScene();
      const e = makeUnit(kind);
      const north = -Math.PI / 2;
      const ctx = makeCtx({ dist: 180, travelDist: 260, heading: north });
      ctx.noFiringLane = true;
      ENEMY_BEHAVIORS[kind](scene, e, ctx);
      expect(advanceAlong({ mx: e.vx, my: e.vy }, north)).toBeGreaterThan(0);
    });
  }

  it('a tank far out in the open still closes, exactly as it always did', () => {
    // The regression guard the issue names: open-field engagement must not change. Player 900px
    // due east with a clear line, so travel distance equals straight-line distance.
    const e = makeUnit('tank');
    ENEMY_BEHAVIORS.tank(makeScene(), e, makeCtx({ dist: 900, travelDist: 900 }));
    expect(advanceAlong({ mx: e.vx, my: e.vy })).toBeGreaterThan(0);
  });

  it('a tank the player has walked right up to still backs off to keep its gun\'s distance', () => {
    // The reverse band still works on route distance: 60px away with a clear line is 60px of
    // driving, so the tank gives ground the same as before. Run a stretch of frames rather than
    // one — a tank turns its hull onto a new heading before it drives anywhere (#294), so a single
    // tick shows the turn, not the travel.
    const scene = makeScene();
    const e = makeUnit('tank');
    const ctx = makeCtx({ dist: 60, travelDist: 60 });
    for (let i = 0; i < 120; i++) ENEMY_BEHAVIORS.tank(scene, e, ctx);
    // Player is due east, so retreating means net westward travel.
    expect(e.vx).toBeLessThan(0);
  });
});
