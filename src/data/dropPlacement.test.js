// Where a kill's pickup lands.
//
// HISTORY, because most of this file used to assert the opposite of what it now asserts: #336
// made a drop stay on the same SIDE of a base wall as the thing that dropped it, since a drop
// across a wall was one the player couldn't collect. Jackson reversed that on 2026-07-20 ("drop
// the same-side rule entirely") once #378's magnet started pulling drops THROUGH walls — which
// side a drop landed on stopped meaning anything. The side rule, the flyer-uses-the-player's-side
// reference and the wedged-against-the-correct-side fallback are all gone; the tests that
// asserted them are rewritten below to assert the replacement behaviour rather than deleted, so
// the reversal is visible.
//
// What survives from those issues, deliberately: #336's tamed scatter radius (a real fix, nothing
// to do with walls) and #345's bounded search (guards the bug CLASS — a budget scaled off world
// size — not just the wall-test instance that made it catastrophic).
import { describe, it, expect } from 'vitest';
import { resolveDropPos, DROP_SCATTER_RADIUS, DROP_SEARCH_RINGS } from './dropPlacement.js';
import { hexToPixel, HEX_SIZE, scatterOffset } from './hexgrid.js';

describe('DROP_SCATTER_RADIUS (#88 scatter, tamed by #336 — KEPT through the reversal)', () => {
  it('stays well under half a hex, so a drop lands near the kill that earned it', () => {
    // The original 30px was most of a 48px hex, which could fling a drop most of a hex away from
    // the kill. That was the problem worth fixing regardless of walls.
    expect(DROP_SCATTER_RADIUS).toBeLessThan(HEX_SIZE / 2);
    for (let i = 0; i < 500; i++) {
      const p = scatterOffset(0, 0, DROP_SCATTER_RADIUS);
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(DROP_SCATTER_RADIUS);
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

describe('resolveDropPos — drops land where the enemy died (the 2026-07-20 reversal)', () => {
  it('leaves a walkable drop exactly where it landed', () => {
    const pos = resolveDropPos(-100, 20, { blocked: () => false });
    expect(pos).toEqual({ x: -100, y: 20, fallback: false });
  });

  it('takes the NEAREST passable tile, with no notion of sides — was the #336 side rule', () => {
    // Under #336 this drop (at -10, with only the +x side passable nearby) was dragged back to a
    // far tile on its own side of the wall. Now it simply takes the closest walkable ground.
    const passable = (q, r) => hexToPixel(q, r).x > 0;
    const pos = resolveDropPos(-10, 0, { blocked: () => true, passable });
    expect(pos.x).toBeGreaterThan(0);
    expect(pos.fallback).toBe(false);
  });

  it('does not relocate a drop merely for being across a wall from the kill', () => {
    // The exact case #336 existed to move. Nothing about walls is consulted anymore, so a
    // walkable spot is accepted as-is and the magnet (#378) is what gets it to the player.
    const pos = resolveDropPos(10, 0, { blocked: () => false });
    expect(pos).toEqual({ x: 10, y: 0, fallback: false });
  });

  it('relocates ONLY for genuinely unreachable ground — #73\'s original job, which stands', () => {
    // Deep water / impassable terrain / off-map: the one reason left to move a drop at all.
    const passable = (q, r) => Math.abs(hexToPixel(q, r).x) > HEX_SIZE;
    const pos = resolveDropPos(0, 0, { blocked: () => true, passable });
    expect(Math.abs(pos.x)).toBeGreaterThan(HEX_SIZE);
    expect(pos.fallback).toBe(false);
  });

  it('a FLYER\'s drop no longer follows the player — the ref rule is gone', () => {
    // #336 placed a flyer's drop on the PLAYER's side of a wall, because a flyer downed over a
    // wall had no side of its own. With no side rule the death point is simply where it lands,
    // and `resolveDropPos` has no ref parameter to pass a player through at all.
    const overWall = { x: 4, y: 0 };
    const pos = resolveDropPos(overWall.x, overWall.y, { blocked: () => false });
    expect(pos).toEqual({ ...overWall, fallback: false });
  });
});

describe('resolveDropPos — a drop is never silently lost', () => {
  it('leaves a wedged drop where it landed rather than losing it', () => {
    // Nothing walkable anywhere in the search (died in a sealed pocket). #336 placed it against
    // the wall on the correct side; now it just stays put, and the magnet can pull it out.
    const pos = resolveDropPos(-10, 3, { blocked: () => true, passable: () => false, maxSteps: 6 });
    expect(pos).toEqual({ x: -10, y: 3, fallback: true });
  });

  it('always returns finite coordinates', () => {
    const pos = resolveDropPos(0, 0, { blocked: () => true, passable: () => false, maxSteps: 3 });
    expect(Number.isFinite(pos.x) && Number.isFinite(pos.y)).toBe(true);
    expect(pos.fallback).toBe(true);
  });
});

// #345 — the freeze, and the reason the bound must OUTLIVE the rule that made it urgent. A kill
// landing ON a wall span left the reference point inside the wall, so nearly nothing read as
// same-side and the ring search ran to exhaustion running a wall-separation segment test per
// candidate. That was fine as a small fixed neighbourhood and catastrophic when the budget was
// `worldRadius * 2 + …`, which #340's longer corridor pushed to 752 rings (~1.7M candidates) —
// measured at 549 SECONDS for one drop. Removing the side rule removed that expensive predicate,
// but these still hold the budget down: the class of bug is the world-scaled budget itself.
describe('resolveDropPos — the search is bounded to a local neighbourhood (#345)', () => {
  it('does bounded work when NOTHING is ever passable', () => {
    let calls = 0;
    const pos = resolveDropPos(0, 0, {
      blocked: () => true,
      passable: () => { calls++; return false; },
    });
    expect(pos.fallback).toBe(true);
    // The point of the assertion is the ORDER OF MAGNITUDE: hundreds, never the ~1.7M the
    // world-sized budget allowed. 3n(n+1)+1 hexes in a DROP_SEARCH_RINGS disc, with room to spare.
    const perDisc = 3 * DROP_SEARCH_RINGS * (DROP_SEARCH_RINGS + 1) + 1;
    expect(calls).toBeLessThanOrEqual(perDisc * 2 + 2);
    expect(calls).toBeLessThan(1000);
  });

  it('the default budget does not scale with the world — it is a small fixed constant', () => {
    // The regression itself: the callers used to derive maxSteps from MAX_WORLD_RADIUS (351),
    // giving 752. If someone reintroduces a world-derived default, this fails.
    expect(DROP_SEARCH_RINGS).toBeLessThanOrEqual(12);
  });
});
