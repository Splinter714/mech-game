// #361 — the pure ground-unit separation rule. The behaviour that matters is the LAST test in
// this file: no arrangement of bodies can freeze one, which is the property the hard block it
// replaced did not have.
import { describe, it, expect } from 'vitest';
import { separateGroundUnits, MASS_SMALL, MASS_LARGE, MASS_IMMOBILE } from './groundSeparation.js';

const R = 10;
const opts = (extra = {}) => ({ radiusOf: () => R, massOf: () => MASS_SMALL, ...extra });
const U = (x, y, vx = 0, vy = 0) => ({ x, y, vx, vy });

describe('separateGroundUnits', () => {
  it('leaves non-overlapping units alone', () => {
    const a = U(0, 0), b = U(100, 0);
    expect(separateGroundUnits([a, b], opts())).toBe(0);
    expect(a.x).toBe(0); expect(b.x).toBe(100);
  });

  it('pushes an overlapping equal-mass pair apart symmetrically, to exactly touching', () => {
    const a = U(0, 0), b = U(10, 0);
    expect(separateGroundUnits([a, b], opts())).toBe(1);
    expect(b.x - a.x).toBeCloseTo(2 * R, 6);
    expect(a.x).toBeCloseTo(-5, 6);       // half each
    expect(b.x).toBeCloseTo(15, 6);
  });

  it('uses per-unit radii — contact is ra + rb, not a shared diameter', () => {
    const small = U(0, 0), big = U(30, 0);
    const radiusOf = (u) => (u === small ? 8 : 28);
    separateGroundUnits([small, big], opts({ radiusOf }));
    expect(big.x - small.x).toBeCloseTo(36, 6);
  });

  it('splits the push by mass — the light unit absorbs most of it', () => {
    const tank = U(0, 0), mech = U(10, 0);
    const massOf = (u) => (u === tank ? MASS_SMALL : MASS_LARGE);
    separateGroundUnits([tank, mech], opts({ massOf }));
    // overlap 10; tank takes 4/5, mech 1/5.
    expect(tank.x).toBeCloseTo(-8, 6);
    expect(mech.x).toBeCloseTo(12, 6);
  });

  it('never displaces an immobile unit — a turret is the wall it looks like', () => {
    const tank = U(0, 0), turret = U(10, 0);
    const massOf = (u) => (u === turret ? MASS_IMMOBILE : MASS_SMALL);
    separateGroundUnits([tank, turret], opts({ massOf }));
    expect(turret.x).toBe(10);
    expect(tank.x).toBeCloseTo(-10, 6);   // the tank takes the whole overlap
  });

  it('skips a pair of immobile units rather than dividing by infinity', () => {
    const a = U(0, 0), b = U(5, 0);
    const r = separateGroundUnits([a, b], opts({ massOf: () => MASS_IMMOBILE }));
    expect(r).toBe(0);
    expect(a.x).toBe(0); expect(b.x).toBe(5);
    expect(Number.isFinite(a.x) && Number.isFinite(b.x)).toBe(true);
  });

  it('fans co-located units apart deterministically', () => {
    const a = U(50, 50), b = U(50, 50);
    separateGroundUnits([a, b], opts());
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(2 * R, 6);
    const c = U(50, 50), d = U(50, 50);
    separateGroundUnits([c, d], opts());
    expect(c.x).toBe(a.x); expect(d.x).toBe(b.x);   // same input ⇒ same output, every machine
  });

  it('strips only the CLOSING part of the relative velocity', () => {
    const a = U(0, 0, 100, 40), b = U(10, 0, -100, 40);
    separateGroundUnits([a, b], opts());
    expect(a.vx).toBeCloseTo(0, 6);      // head-on closing component gone
    expect(b.vx).toBeCloseTo(0, 6);
    expect(a.vy).toBe(40);               // tangential motion untouched — they can still drive
    expect(b.vy).toBe(40);
  });

  it('leaves a SEPARATING pair′s velocity completely alone', () => {
    const a = U(0, 0, -60, 0), b = U(10, 0, 60, 0);
    separateGroundUnits([a, b], opts());
    expect(a.vx).toBe(-60); expect(b.vx).toBe(60);
  });

  it('clips a push through canMove, and slides along the free axis', () => {
    // b is backed against a wall at x >= 12: it cannot be pushed further +x, but +y is free.
    const a = U(0, 0), b = U(10, 0);
    const canMove = (u, x) => !(u === b && x > 12);
    separateGroundUnits([a, b], opts({ canMove }));
    expect(b.x).toBeLessThanOrEqual(12);
    expect(a.x).toBeCloseTo(-5, 6);      // the partner still takes its own half: they separate
  });

  it('skips a push entirely rather than shoving a unit into geometry', () => {
    const a = U(0, 0), b = U(10, 0);
    const canMove = (u) => u !== b;      // b is boxed in on every axis
    separateGroundUnits([a, b], opts({ canMove }));
    expect(b.x).toBe(10); expect(b.y).toBe(0);
    expect(a.x).toBeCloseTo(-5, 6);
  });

  it('resolves a dense pile so that NO unit ends the sweep unable to move (#361, #282)', () => {
    // Ten units dumped on nearly the same point — the shape that gridlocked drones under #282's
    // hard block and tanks under this one. Iterating the pure rule alone must fully separate them.
    const pile = [];
    for (let i = 0; i < 10; i++) pile.push(U(Math.cos(i) * 2, Math.sin(i) * 2));
    for (let step = 0; step < 200; step++) separateGroundUnits(pile, opts());
    for (let i = 0; i < pile.length; i++) {
      for (let j = i + 1; j < pile.length; j++) {
        const d = Math.hypot(pile[j].x - pile[i].x, pile[j].y - pile[i].y);
        expect(d).toBeGreaterThan(2 * R - 1e-6);
      }
    }
  });
});
