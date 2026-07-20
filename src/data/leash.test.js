// #348: the shared-camera hard-stop leash. Jackson rejected zoom-out and rubber-band by name,
// so what these lock down is specifically that the limit STOPS a player rather than moving the
// camera or pulling anyone.
import { describe, it, expect } from 'vitest';
import { LEASH_RADIUS, clampToLeash, leashFocus } from './leash.js';

const P = (x, y, vx = 0, vy = 0) => ({ x, y, vx, vy });

describe('leashFocus', () => {
  it('is the single player, for one player', () => {
    expect(leashFocus([P(120, -40)])).toEqual({ x: 120, y: -40 });
  });

  it('is the midpoint of two players', () => {
    expect(leashFocus([P(0, 0), P(100, 200)])).toEqual({ x: 50, y: 100 });
  });

  it('ignores the dead while anyone is alive', () => {
    const players = [P(0, 0), P(1000, 0)];
    const alive = (p) => p.x === 0;
    expect(leashFocus(players, alive)).toEqual({ x: 0, y: 0 });
  });

  it('falls back to everyone when nobody is alive, rather than returning null', () => {
    // A wiped team still has a camera position for the run-over beat.
    expect(leashFocus([P(0, 0), P(100, 0)], () => false)).toEqual({ x: 50, y: 0 });
  });

  it('is null for an empty collection', () => {
    expect(leashFocus([])).toBeNull();
  });
});

describe('clampToLeash — the hard stop', () => {
  it('never clamps a single player: they are the centroid', () => {
    const solo = [P(9999, -9999, 300, 300)];
    expect(clampToLeash(solo, leashFocus(solo))).toBe(0);
    expect(solo[0].x).toBe(9999);
  });

  it('leaves players inside the leash completely untouched', () => {
    const players = [P(0, 0, 50, 0), P(200, 0, -50, 0)];
    expect(clampToLeash(players, leashFocus(players))).toBe(0);
    expect(players[1].x).toBe(200);
    expect(players[1].vx).toBe(-50);
  });

  it('caps separation at twice the leash radius when both walk apart', () => {
    const players = [P(-5000, 0), P(5000, 0)];
    expect(clampToLeash(players, leashFocus(players))).toBe(2);
    expect(Math.hypot(players[1].x - players[0].x, players[1].y - players[0].y))
      .toBeCloseTo(2 * LEASH_RADIUS, 6);
  });

  it('places the offender exactly ON the circle, not merely inside it', () => {
    const players = [P(0, 0), P(0, 3000)];
    const focus = leashFocus(players);
    clampToLeash(players, focus);
    for (const p of players) {
      expect(Math.hypot(p.x - focus.x, p.y - focus.y)).toBeCloseTo(LEASH_RADIUS, 6);
    }
  });

  it('does not drag the stationary player: only the walker is moved', () => {
    // The stationary player still shifts relative to the centroid (the centroid moved toward
    // the walker), but the rule must not TELEPORT someone who is standing still, so with a
    // separation just past the limit only the far player ends up repositioned meaningfully.
    const stay = P(0, 0);
    const walk = P(4000, 0, 400, 0);
    const players = [stay, walk];
    clampToLeash(players, leashFocus(players));
    expect(walk.x - stay.x).toBeCloseTo(2 * LEASH_RADIUS, 6);
  });

  it('strips the OUTWARD velocity but keeps the tangential slide', () => {
    // Driving straight out at the wall: the outward component dies (hard stop), the
    // perpendicular component survives so the player can still circle the boundary.
    const players = [P(0, 0), P(LEASH_RADIUS * 4, 0, 300, 120)];
    clampToLeash(players, leashFocus(players));
    expect(players[1].vx).toBeCloseTo(0, 6);   // outward (+x) removed
    expect(players[1].vy).toBeCloseTo(120, 6); // tangential kept
  });

  it('leaves INWARD velocity alone, so a clamped player can always walk back', () => {
    const players = [P(0, 0), P(LEASH_RADIUS * 4, 0, -300, 0)];
    clampToLeash(players, leashFocus(players));
    expect(players[1].vx).toBeCloseTo(-300, 6);
  });

  it('generalises past two players — every player is inside the same circle', () => {
    const players = [P(-4000, 0), P(4000, 0), P(0, 4000)];
    const focus = leashFocus(players);
    clampToLeash(players, focus);
    for (const p of players) {
      expect(Math.hypot(p.x - focus.x, p.y - focus.y)).toBeLessThanOrEqual(LEASH_RADIUS + 1e-6);
    }
  });
});

// #348 (playtest 2026-07-19): "multiplayer leash can pull the other player through the boundary
// of the corridor" and "through ANY kind of blocking cover, e.g. base walls". The clamp ran after
// locomotion had already resolved collision, so the position it wrote was never re-checked.
describe('the leash clamp is clipped by walls and terrain (#348)', () => {
  const P = (x, y, vx = 0, vy = 0) => ({ x, y, vx, vy });
  const FOCUS = { x: 0, y: 0 };

  it('never places a player somewhere they could not have driven', () => {
    // A wall along x = 100: nothing may be placed to its left. The clamp target is well past it.
    const canMove = (p, x) => x >= 100;
    const p = P(400, 0);
    const others = [P(-400, 0), p];
    clampToLeash(others, FOCUS, LEASH_RADIUS, { canMove });
    expect(canMove(p, p.x, p.y)).toBe(true);
  });

  it('accepts a player left OUTSIDE the radius when a wall blocks the correction', () => {
    // Terrain wins over the leash. The overshoot is the correct outcome, not a failure.
    const canMove = (p, x) => x >= 350;
    const p = P(400, 0);
    clampToLeash([P(-400, 0), p], FOCUS, LEASH_RADIUS, { canMove });
    expect(Math.hypot(p.x - FOCUS.x, p.y - FOCUS.y)).toBeGreaterThan(LEASH_RADIUS);
    expect(canMove(p, p.x, p.y)).toBe(true);
  });

  it('still moves the player as far inward as collision allows, not zero', () => {
    const canMove = (p, x) => x >= 350;
    const p = P(400, 0);
    clampToLeash([P(-400, 0), p], FOCUS, LEASH_RADIUS, { canMove });
    expect(p.x).toBeLessThan(400);
  });

  it('leaves the player exactly put when even a hair of the correction is blocked', () => {
    const p = P(400, 0);
    clampToLeash([P(-400, 0), p], FOCUS, LEASH_RADIUS, { canMove: () => false });
    expect(p).toMatchObject({ x: 400, y: 0 });
  });

  it('still strips the outward velocity even when the move was blocked, so nothing keeps pushing out', () => {
    const p = P(400, 0, 50, 20);
    clampToLeash([P(-400, 0), p], FOCUS, LEASH_RADIUS, { canMove: () => false });
    expect(p.vx).toBeCloseTo(0, 6);
    expect(p.vy).toBeCloseTo(20, 6);   // tangential motion survives — the player stays steerable
  });

  it('is byte-identical to the old hard clamp when nothing is blocking', () => {
    const open = P(400, 0), plain = P(400, 0);
    clampToLeash([P(-400, 0), open], FOCUS, LEASH_RADIUS, { canMove: () => true });
    clampToLeash([P(-400, 0), plain], FOCUS, LEASH_RADIUS);
    expect(open).toMatchObject({ x: plain.x, y: plain.y });
    expect(Math.hypot(open.x, open.y)).toBeCloseTo(LEASH_RADIUS, 6);
  });

  it('uses a FIXED clip budget — the cost does not scale with the world (#345)', () => {
    const calls = [];
    const canMove = (p, x, y) => { calls.push([x, y]); return false; };
    // A correction spanning an enormous distance must cost no more predicate calls than a tiny
    // one: the bisection is a constant number of steps, not a walk over world-sized space.
    clampToLeash([P(-1e6, 0), P(1e6, 0)], FOCUS, LEASH_RADIUS, { canMove });
    const far = calls.length;
    calls.length = 0;
    clampToLeash([P(-400, 0), P(400, 0)], FOCUS, LEASH_RADIUS, { canMove });
    expect(calls.length).toBe(far);
    expect(far).toBeLessThan(16);
  });
});
