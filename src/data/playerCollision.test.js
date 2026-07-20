// #348 playtest answer: players collide with each other. Phase 2 shipped them passing through.
//
// The two things that actually have to hold, and which every test below is an instance of:
//   1. Players never come to rest overlapping — driving into your teammate shoves them.
//   2. NO configuration can leave a player unable to move. That is the real risk, because the
//      leash (data/leash.js) is a hard stop that also constrains position, and a body being
//      shoved while pinned against a hard stop is the classic way to build a deadlock.
import { describe, it, expect } from 'vitest';
import { separatePlayers, PLAYER_COLLIDE_RADIUS as R } from './playerCollision.js';
import { clampToLeash, leashFocus, LEASH_RADIUS } from './leash.js';

const P = (x, y, vx = 0, vy = 0) => ({ x, y, vx, vy });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

describe('separatePlayers — players are solid to one another', () => {
  it('leaves non-overlapping players completely untouched', () => {
    const a = P(0, 0), b = P(R * 2 + 5, 0);
    expect(separatePlayers([a, b])).toBe(0);
    expect(a).toEqual(P(0, 0));
    expect(b).toEqual(P(R * 2 + 5, 0));
  });

  it('pushes an overlapping pair apart to exactly touching, half each (symmetric)', () => {
    const a = P(-10, 0), b = P(10, 0);   // 20px apart, contact is at 56
    expect(separatePlayers([a, b])).toBe(1);
    expect(dist(a, b)).toBeCloseTo(R * 2, 6);
    // Symmetric: the midpoint did not move, so standing still never drags you.
    expect((a.x + b.x) / 2).toBeCloseTo(0, 6);
    expect(a.x).toBeCloseTo(-R, 6);
    expect(b.x).toBeCloseTo(R, 6);
  });

  it('a single player (or none) is never separated — solo play is untouched', () => {
    expect(separatePlayers([P(0, 0)])).toBe(0);
    expect(separatePlayers([])).toBe(0);
    expect(separatePlayers(null)).toBe(0);
  });

  it('resolves exactly co-located players deterministically rather than dividing by zero', () => {
    const a = P(100, 100), b = P(100, 100);
    expect(separatePlayers([a, b])).toBe(1);
    expect(dist(a, b)).toBeCloseTo(R * 2, 6);
    expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
    // Deterministic: the same input always fans out the same way, so two machines agree.
    const c = P(100, 100), d = P(100, 100);
    separatePlayers([c, d]);
    expect([c.x, c.y, d.x, d.y]).toEqual([a.x, a.y, b.x, b.y]);
  });

  it('kills the CLOSING velocity of a mech driven into a teammate, but nothing else', () => {
    // a drives right into a stationary b, and is also drifting downward.
    const a = P(-20, 0, 100, 40), b = P(20, 0, 0, 0);
    separatePlayers([a, b]);
    // Closing (x) component shared out; the perpendicular drift (y) survives untouched.
    expect(a.vx).toBeLessThan(100);
    expect(a.vy).toBe(40);
    expect(b.vx).toBeGreaterThan(0);   // the shove transfers into the one being pushed
  });

  it('does not touch velocity when the pair is already separating', () => {
    const a = P(-20, 0, -50, 0), b = P(20, 0, 50, 0);
    separatePlayers([a, b]);
    expect(a.vx).toBe(-50);
    expect(b.vx).toBe(50);
  });

  it('never leaves a resolved pair still overlapping, for any approach geometry', () => {
    for (const [dx, dy] of [[1, 0], [0, 1], [3, 4], [-7, 2], [0.5, -0.25], [40, 39]]) {
      const a = P(0, 0), b = P(dx, dy);
      separatePlayers([a, b]);
      expect(dist(a, b)).toBeGreaterThanOrEqual(R * 2 - 1e-9);
    }
  });

  it('separates all three pairs when three players pile up', () => {
    const a = P(0, 0), b = P(6, 0), c = P(0, 6);
    expect(separatePlayers([a, b, c])).toBe(3);
  });
});

describe('separatePlayers — the world clip (a shove can never place a mech in geometry)', () => {
  it('skips the half-push of a player backed against a wall; the pair still separates', () => {
    // A wall at x = -20: nobody may move to x < -20. `a` is pressed against it.
    const canMove = (_p, x) => x >= -20;
    const a = P(-18, 0), b = P(0, 0);
    separatePlayers([a, b], { canMove });
    expect(a.x).toBeGreaterThanOrEqual(-20);   // never shoved through the wall
    expect(b.x).toBeGreaterThan(0);            // the partner still takes its own half
  });

  it('slides along the blocked axis rather than refusing the whole push', () => {
    const canMove = (_p, x) => x >= 0;         // wall on the left only
    const a = P(0, 0), b = P(3, 4);
    separatePlayers([a, b], { canMove });
    expect(a.x).toBe(0);                       // x half rejected
    expect(a.y).toBeLessThan(0);               // y half still applied
  });

  it('a fully boxed-in player is left where it is instead of teleporting out', () => {
    const canMove = () => false;
    const a = P(0, 0), b = P(10, 0);
    expect(() => separatePlayers([a, b], { canMove })).not.toThrow();
    expect(a).toEqual(P(0, 0));
    expect(b).toEqual(P(10, 0));
  });
});

// ── The interaction that actually had to be got right ────────────────────────────────────────
// The scene order is drive → separatePlayers → clampToLeash (ArenaScene.update / coop.js), so
// these tests run the same two steps in the same order on plain fixtures.
function frame(players) {
  separatePlayers(players);
  clampToLeash(players, leashFocus(players), LEASH_RADIUS);
}

describe('collision + leash — a pinned player being shoved is never stuck', () => {
  it('AT N=2 a shove and a leash pin are geometrically incapable of co-occurring', () => {
    // Overlapping means the pair are within 56px of each other, so each is within 28px of their
    // midpoint-centroid — and the leash only engages past 280px. Ten times apart in scale.
    const a = P(0, 0), b = P(10, 0);
    expect(separatePlayers([a, b])).toBe(1);
    const focus = leashFocus([a, b]);
    expect(clampToLeash([a, b], focus, LEASH_RADIUS)).toBe(0);
    expect(Math.hypot(a.x - focus.x, a.y - focus.y)).toBeLessThan(LEASH_RADIUS);
  });

  it('a player pinned ON the leash circle and shoved outward stays on it and keeps steering', () => {
    // Three players, so the centroid is NOT the midpoint of the shoving pair and a pin and an
    // overlap CAN co-occur. `a` is out at the leash limit, `b` is right on top of it shoving it
    // further out, `c` anchors the centroid at the origin.
    const a = P(400, 0, 0, 0);
    const b = P(380, 0, 60, 0);        // overlapping a, driving outward into it
    const c = P(-400, 0, 0, 0);
    // `a` steers inward and sideways while being shoved.
    a.vx = -30; a.vy = 45;
    frame([a, b, c]);
    const focus = leashFocus([a, b, c]);
    const d = Math.hypot(a.x - focus.x, a.y - focus.y);
    // The leash invariant survives the shove — the clamp runs last.
    expect(d).toBeLessThanOrEqual(LEASH_RADIUS + 1e-9);
    // And the pinned player is NOT frozen: it keeps the inward and tangential velocity it
    // steered with. This is the whole point — pinned and shoved must still equal drivable.
    expect(a.vy).not.toBe(0);
    expect(Math.hypot(a.vx, a.vy)).toBeGreaterThan(0);
    // Nor is it left buried inside its teammate.
    expect(dist(a, b)).toBeGreaterThan(R);
  });

  it('a pinned, shoved player can still drive back inward on the next frame', () => {
    const a = P(400, 0), b = P(380, 0, 80, 0), c = P(-400, 0);
    frame([a, b, c]);
    const before = Math.hypot(a.x - leashFocus([a, b, c]).x, a.y);
    // Next frame: the player commands inward movement, as the human would.
    a.vx = -100; a.vy = 0;
    a.x += a.vx * 0.1;
    frame([a, b, c]);
    const after = Math.hypot(a.x - leashFocus([a, b, c]).x, a.y);
    expect(after).toBeLessThan(before);   // it actually moved in; nothing pinned it in place
  });

  it('repeated frames of one player bulldozing another never deadlock or drift out of bounds', () => {
    const a = P(0, 0, 0, 0), b = P(30, 0, 0, 0), c = P(-100, 0);
    for (let i = 0; i < 200; i++) {
      a.vx = 120;                  // a holds the stick hard into b, forever
      a.x += a.vx * (1 / 60);
      frame([a, b, c]);
      const f = leashFocus([a, b, c]);
      for (const p of [a, b, c]) {
        expect(Math.hypot(p.x - f.x, p.y - f.y)).toBeLessThanOrEqual(LEASH_RADIUS + 1e-6);
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      }
      expect(dist(a, b)).toBeGreaterThan(R);   // never ends a frame buried in each other
    }
    expect(b.x).toBeGreaterThan(30);           // b was genuinely pushed along, not walked through
  });
});
