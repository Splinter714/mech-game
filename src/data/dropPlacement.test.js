// #336: a kill's pickup must never end up on the far side of a base wall from the thing that
// dropped it. Two nudges used to let that happen — an oversized #88 scatter and #73's
// side-agnostic ring search — so these cover the tamed radius and the side rule together.
import { describe, it, expect } from 'vitest';
import { resolveDropPos, DROP_SCATTER_RADIUS } from './dropPlacement.js';
import { hexToPixel, pixelToHex, axialKey, HEX_SIZE, scatterOffset } from './hexgrid.js';
import { makeWallEdgeSet, wallEdgeSeparating } from './wallEdges.js';

// A synthetic wall along the y axis: two points are separated iff their x's straddle zero.
const yAxisWall = (ax, ay, bx, by) => (ax < 0) !== (bx < 0);

describe('DROP_SCATTER_RADIUS (#88 scatter, tamed by #336)', () => {
  it('cannot throw a drop across a wall band on its own (well under half a hex)', () => {
    expect(DROP_SCATTER_RADIUS).toBeLessThan(HEX_SIZE / 2);
    // The concrete guarantee: a kill standing clear of a wall by more than the radius can never
    // be scattered through it.
    for (let i = 0; i < 500; i++) {
      const p = scatterOffset(-(DROP_SCATTER_RADIUS + 1), 0, DROP_SCATTER_RADIUS);
      expect(p.x).toBeLessThan(0);
    }
  });

  it('still separates two drops from one kill often enough to be worth doing', () => {
    let apart = 0;
    for (let i = 0; i < 400; i++) {
      const a = scatterOffset(0, 0, DROP_SCATTER_RADIUS);
      const b = scatterOffset(0, 0, DROP_SCATTER_RADIUS);
      if (Math.hypot(a.x - b.x, a.y - b.y) > 4) apart++;
    }
    expect(apart).toBeGreaterThan(200);
  });
});

describe('resolveDropPos — the side rule (#336)', () => {
  it('leaves a walkable, same-side drop exactly where it landed', () => {
    const pos = resolveDropPos(-100, 20, {
      ref: { x: -110, y: 20 }, blocked: () => false, separated: yAxisWall,
    });
    expect(pos).toEqual({ x: -100, y: 20, fallback: false });
  });

  it('relocates a drop that the scatter pushed THROUGH the wall back to the kill\'s side', () => {
    // Drop point is at +x (through the wall); the kill happened at -x. Everything is walkable,
    // so the only thing that can move it is the side rule.
    const pos = resolveDropPos(10, 0, {
      ref: { x: -30, y: 0 }, blocked: () => true, passable: () => true, separated: yAxisWall,
    });
    expect(pos.x).toBeLessThan(0);
    expect(pos.fallback).toBe(false);
  });

  it('keeps expanding past a NEARER far-side tile to find a same-side one (the #73 bug)', () => {
    // The old search was purely geometric, so the hex just over the wall won because it was
    // closest. Make only the far side passable nearby and confirm we do NOT take it.
    const passable = (q, r) => {
      const p = hexToPixel(q, r);
      return p.x > 0 || p.x < -3 * HEX_SIZE;      // a gap of impassable ground on our own side
    };
    const pos = resolveDropPos(-10, 0, {
      ref: { x: -20, y: 0 }, blocked: () => true, passable, separated: yAxisWall,
    });
    expect(pos.x).toBeLessThan(0);
    expect(pos.fallback).toBe(false);
  });

  it('with no ref, behaves exactly as before — nearest passable tile, side ignored', () => {
    const passable = (q, r) => hexToPixel(q, r).x > 0;
    const pos = resolveDropPos(-10, 0, { ref: null, blocked: () => true, passable });
    expect(pos.x).toBeGreaterThan(0);
  });

  it('a FLYER downed over a wall drops on the side its ref (the player) is on', () => {
    // Same death point, two different refs — the drop follows the ref, which is exactly how the
    // scene distinguishes a flyer (player position) from a ground kill (death position).
    const opts = { blocked: () => true, passable: () => true, separated: yAxisWall };
    const overWall = { x: 4, y: 0 };
    const playerLeft = resolveDropPos(overWall.x, overWall.y, { ...opts, ref: { x: -200, y: 0 } });
    const playerRight = resolveDropPos(overWall.x, overWall.y, { ...opts, ref: { x: 200, y: 0 } });
    expect(yAxisWall(-200, 0, playerLeft.x, playerLeft.y)).toBe(false);
    expect(yAxisWall(200, 0, playerRight.x, playerRight.y)).toBe(false);
    expect(playerLeft.x).toBeLessThan(0);
    expect(playerRight.x).toBeGreaterThanOrEqual(0);
  });
});

describe('resolveDropPos — the wedged-in-a-corner fallback (#336)', () => {
  it('places against the wall on the correct side rather than losing the drop', () => {
    // Nothing walkable exists on our side at all: the reward must still appear, on our side.
    const passable = (q, r) => hexToPixel(q, r).x > 0;
    const pos = resolveDropPos(-10, 0, {
      ref: { x: -20, y: 0 }, blocked: () => true, passable, separated: yAxisWall, maxSteps: 6,
    });
    expect(pos.fallback).toBe(true);
    expect(pos.x).toBeLessThan(0);
  });

  it('never returns nothing — a drop is never silently dropped on the floor', () => {
    const pos = resolveDropPos(0, 0, {
      ref: { x: 5, y: 7 }, blocked: () => true, passable: () => false,
      separated: () => true, maxSteps: 3,
    });
    expect(Number.isFinite(pos.x) && Number.isFinite(pos.y)).toBe(true);
    expect(pos.fallback).toBe(true);
  });
});

describe('resolveDropPos against REAL wall geometry', () => {
  // One standing span between two adjacent hexes, driven by the same wallEdgeSeparating the
  // scene passes in — #320's true opposite-sides test, not wallEdgeCrossing.
  const a = { q: 0, r: 0 };
  const b = { q: 1, r: 0 };
  const set = makeWallEdgeSet([{ a, b }]);
  const separated = (ax, ay, bx, by) => !!wallEdgeSeparating(set, ax, ay, bx, by);

  it('a drop pushed into the neighbouring hex comes back across the span', () => {
    const home = hexToPixel(a.q, a.r);
    const over = hexToPixel(b.q, b.r);
    expect(separated(home.x, home.y, over.x, over.y)).toBe(true);
    const pos = resolveDropPos(over.x, over.y, {
      ref: home, blocked: () => true, passable: () => true, separated,
    });
    expect(separated(home.x, home.y, pos.x, pos.y)).toBe(false);
  });

  it('a drop resting AGAINST the plate on its own side is left alone (not over-rejected)', () => {
    // The distinction #320 drew: a point inside the wall's thickness but on the shooter's own
    // side is not "separated". If this used wallEdgeCrossing it would reject and move the drop.
    const home = hexToPixel(a.q, a.r);
    const over = hexToPixel(b.q, b.r);
    const nearPlate = { x: (home.x + over.x) / 2 - 2, y: (home.y + over.y) / 2 };
    expect(separated(home.x, home.y, nearPlate.x, nearPlate.y)).toBe(false);
    const pos = resolveDropPos(nearPlate.x, nearPlate.y, {
      ref: home, blocked: () => false, passable: () => true, separated,
    });
    expect(pos).toEqual({ ...nearPlate, fallback: false });
  });

  it('an open world with no walls places drops identically to the old behaviour', () => {
    const empty = makeWallEdgeSet([]);
    const sep = (ax, ay, bx, by) => !!wallEdgeSeparating(empty, ax, ay, bx, by);
    const passable = (q, r) => axialKey(q, r) !== axialKey(...Object.values(pixelToHex(0, 0)));
    const pos = resolveDropPos(0, 0, {
      ref: { x: 0, y: 0 }, blocked: () => true, passable, separated: sep,
    });
    expect(pos.fallback).toBe(false);
    expect(Math.hypot(pos.x, pos.y)).toBeLessThanOrEqual(HEX_SIZE * 2);
  });
});
