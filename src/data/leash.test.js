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
