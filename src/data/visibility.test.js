// #306: the player's field-of-view pass and the targeting rule it feeds.
import { describe, it, expect } from 'vitest';
import { computeVisibleHexes, hexLineClear, enemyTargetable } from './visibility.js';
import { axialKey, distance, range } from './hexgrid.js';

// A terrain lookup backed by a plain {key: id} map — everything unlisted is open grass.
const world = (obj) => (q, r) => obj[axialKey(q, r)] ?? 'grass';

// `wallSegment` is HARD cover (terrain.js `coverTier`), so it blocks a mech's sight line
// unconditionally. `forest` is SOFT cover, which a large unit (the player is always a mech)
// sees clean over — see `softCoverBlocksLOS`. Both facts are load-bearing below.
const HARD = 'wallSegment';
const SOFT = 'forest';

describe('hexLineClear', () => {
  const origin = { q: 0, r: 0 };

  it('is clear across open ground', () => {
    expect(hexLineClear(origin, { q: 5, r: 0 }, world({}))).toBe(true);
  });

  it('is clear to the viewer own hex and to an adjacent hex, whatever is in them', () => {
    // Nothing can lie strictly BETWEEN two hexes that are the same or adjacent, so these are
    // clear by construction — this is the #72 own-hex rule: standing in cover must not blind you.
    expect(hexLineClear(origin, origin, world({ '0,0': HARD }))).toBe(true);
    expect(hexLineClear(origin, { q: 1, r: 0 }, world({ '0,0': HARD, '1,0': HARD }))).toBe(true);
  });

  it('is blocked by hard cover strictly between the endpoints', () => {
    expect(hexLineClear(origin, { q: 4, r: 0 }, world({ '2,0': HARD }))).toBe(false);
  });

  it('still sees the blocker hex itself — you can see the wall, not past it', () => {
    expect(hexLineClear(origin, { q: 2, r: 0 }, world({ '2,0': HARD }))).toBe(true);
  });

  it('is NOT blocked by soft cover — the player is a mech and sees over it', () => {
    // Deliberately consistent with what the player can SHOOT through (`coverBlocksForRay` with
    // smallUnitInvolved = false). If sight and fire disagreed, targeting would start rejecting
    // enemies the player is perfectly able to hit.
    expect(hexLineClear(origin, { q: 4, r: 0 }, world({ '2,0': SOFT }))).toBe(true);
  });

  it('treats off-map (undefined) hexes as non-blocking', () => {
    expect(hexLineClear(origin, { q: 4, r: 0 }, () => undefined)).toBe(true);
  });
});

describe('computeVisibleHexes', () => {
  const origin = { q: 0, r: 0 };

  it('sees the whole disc on fully open ground', () => {
    const vis = computeVisibleHexes(origin, 4, world({}));
    const all = range(origin, 4);
    expect(vis.size).toBe(all.length);
    for (const h of all) expect(vis.has(axialKey(h.q, h.r))).toBe(true);
  });

  it('always includes the viewer own hex, even standing inside hard cover', () => {
    const vis = computeVisibleHexes(origin, 3, world({ '0,0': HARD }));
    expect(vis.has(axialKey(0, 0))).toBe(true);
  });

  it('casts a shadow directly behind a hard blocker, and the blocker stays visible', () => {
    const vis = computeVisibleHexes(origin, 6, world({ '2,0': HARD }));
    expect(vis.has(axialKey(2, 0))).toBe(true);    // the wall itself
    expect(vis.has(axialKey(3, 0))).toBe(false);   // immediately behind it
    expect(vis.has(axialKey(5, 0))).toBe(false);   // further along the same line
    expect(vis.has(axialKey(-3, 0))).toBe(true);   // the opposite direction is unaffected
  });

  it('the shadow widens with distance behind the blocker', () => {
    const vis = computeVisibleHexes(origin, 8, world({ '2,0': HARD }));
    const shadowAt = (d) => range(origin, 8)
      .filter((h) => distance(origin, h) === d && !vis.has(axialKey(h.q, h.r))).length;
    expect(shadowAt(6)).toBeGreaterThan(shadowAt(3));
  });

  it('a solid wall of hard cover hides everything beyond it', () => {
    // A full ring of hard cover at radius 2: nothing outside radius 2 can be seen.
    const walls = {};
    for (const h of range(origin, 8)) if (distance(origin, h) === 2) walls[axialKey(h.q, h.r)] = HARD;
    const vis = computeVisibleHexes(origin, 5, world(walls));
    for (const h of range(origin, 5)) {
      const seen = vis.has(axialKey(h.q, h.r));
      expect(seen).toBe(distance(origin, h) <= 2);
    }
  });

  it('soft cover casts no shadow for the player', () => {
    const vis = computeVisibleHexes(origin, 5, world({ '2,0': SOFT, '2,-1': SOFT }));
    expect(vis.size).toBe(range(origin, 5).length);
  });

  // "Blowing a hole in cover clears the dimming behind it": the computation is a pure function of
  // the terrain lookup, so re-running it after a collapse (the scene invalidates its cache on
  // `_damageBuildingAt`'s destroyed branch) necessarily reveals what the blocker was hiding.
  it('recomputing after a blocker collapses to rubble reveals what it hid', () => {
    const before = computeVisibleHexes(origin, 6, world({ '2,0': HARD }));
    expect(before.has(axialKey(4, 0))).toBe(false);
    const after = computeVisibleHexes(origin, 6, world({ '2,0': 'rubble' }));
    expect(after.has(axialKey(4, 0))).toBe(true);
  });
});

describe('enemyTargetable', () => {
  const hexKeyOf = (x, y) => axialKey(x, y);   // tests address enemies by hex directly
  const seen = new Set([axialKey(1, 0)]);

  it('accepts a ground enemy standing in a visible hex', () => {
    expect(enemyTargetable({ x: 1, y: 0 }, seen, hexKeyOf)).toBe(true);
  });

  it('REJECTS a ground enemy the player has no sight of', () => {
    expect(enemyTargetable({ x: 9, y: 9 }, seen, hexKeyOf)).toBe(false);
  });

  it('always accepts a FLYING enemy, sighted or not — they are above ground-level cover', () => {
    expect(enemyTargetable({ x: 9, y: 9, flying: true }, seen, hexKeyOf)).toBe(true);
  });

  it('does not gate at all before a field of view has been computed', () => {
    expect(enemyTargetable({ x: 9, y: 9 }, null, hexKeyOf)).toBe(true);
  });
});
