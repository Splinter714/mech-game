// #337 v2 — the compound-interior fog model. The v1 tests that lived here pinned the open-world
// block machinery (cell keys, cell centres, the 9-ring reveal disc, the all-angles breach union) and
// were deleted with it; nothing in the redesign has an open-world concept to test.
import { describe, it, expect } from 'vitest';
import {
  buildFogWorld, compoundAt, fogHexes, fogEdgeDepths, fogAlphaFor, enemyVisibleInFog,
  FOG_ALPHA, FOG_SOFT_STEPS,
} from './fogRegions.js';
import { axialKey, range } from './hexgrid.js';
import { pointVisibleFrom } from './shadowPolygon.js';

// A compound centred on `c` with radius `rad` rings — the same shape worldgen hands over.
function base(id, c, rad) {
  return { id, footprint: range(c, rad) };
}
const K = (q, r) => axialKey(q, r);

describe('buildFogWorld', () => {
  const world = buildFogWorld([base('alpha', { q: 0, r: 0 }, 3)]);

  it('splits a footprint into an outline ring and an interior', () => {
    const fp = world.footprints.get('alpha');
    const out = world.outlines.get('alpha');
    const inner = world.interiors.get('alpha');
    expect(fp.size).toBe(37);                       // 3-ring hex
    expect(out.size).toBe(18);                      // the outermost ring only
    expect(inner.size).toBe(19);                    // everything strictly inside
    expect(out.size + inner.size).toBe(fp.size);
    expect(out.has(K(3, 0))).toBe(true);
    expect(inner.has(K(0, 0))).toBe(true);
  });

  it('maps every footprint hex back to its base and leaves the open world unowned', () => {
    expect(compoundAt(0, 0, world)).toBe('alpha');
    expect(compoundAt(3, 0, world)).toBe('alpha');  // outline hexes still belong to the compound
    expect(compoundAt(20, 20, world)).toBe(null);
  });

  it('ignores a base with no footprint', () => {
    const w = buildFogWorld([{ id: 'ghost', footprint: [] }, base('real', { q: 0, r: 0 }, 2)]);
    expect(w.footprints.has('ghost')).toBe(false);
    expect(w.footprints.has('real')).toBe(true);
  });
});

describe('fogHexes', () => {
  const world = buildFogWorld([
    base('alpha', { q: 0, r: 0 }, 3),
    base('beta', { q: 40, r: 0 }, 3),
  ]);

  it('fogs only compound INTERIORS — never the wall ring, never the open world', () => {
    const fogged = fogHexes(world, new Set());
    expect(fogged.has(K(0, 0))).toBe(true);         // deep interior
    expect(fogged.has(K(3, 0))).toBe(false);        // outline: walls + wall turrets read from both sides
    expect(fogged.has(K(15, 7))).toBe(false);       // open ground is NEVER fogged in v2
    expect(fogged.size).toBe(19 * 2);
  });

  it('drops a compound permanently once entered, leaving the others alone', () => {
    const fogged = fogHexes(world, new Set(['alpha']));
    expect(fogged.has(K(0, 0))).toBe(false);
    expect(fogged.has(K(40, 0))).toBe(true);
    expect(fogged.size).toBe(19);
  });

  it('is empty when every compound has been entered', () => {
    expect(fogHexes(world, new Set(['alpha', 'beta'])).size).toBe(0);
  });
});

describe('fogEdgeDepths / fogAlphaFor — the softened edge', () => {
  const world = buildFogWorld([base('alpha', { q: 0, r: 0 }, 6)]);
  const fogged = fogHexes(world, new Set());
  const depths = fogEdgeDepths(fogged);

  it('ramps depth inward from the lit boundary', () => {
    expect(depths.get(K(5, 0))).toBe(1);            // touches the outline ring
    expect(depths.get(K(4, 0))).toBe(2);
    expect(depths.get(K(3, 0))).toBe(3);
    expect(depths.has(K(0, 0))).toBe(false);        // deeper than FOG_SOFT_STEPS: full ceiling
  });

  it('turns that ramp into a gradient instead of a stencil cut', () => {
    const a = (q, r) => fogAlphaFor(K(q, r), { fogged, depths });
    expect(a(6, 0)).toBe(0);                        // outline — not fogged at all
    expect(a(5, 0)).toBeCloseTo(FOG_ALPHA / 3);
    expect(a(4, 0)).toBeCloseTo(FOG_ALPHA * 2 / 3);
    expect(a(3, 0)).toBeCloseTo(FOG_ALPHA);
    expect(a(0, 0)).toBe(FOG_ALPHA);
    expect(a(5, 0)).toBeLessThan(a(4, 0));
    expect(a(4, 0)).toBeLessThan(a(3, 0));
  });

  it('never exceeds the 0.62 ceiling anywhere', () => {
    for (const k of fogged) expect(fogAlphaFor(k, { fogged, depths })).toBeLessThanOrEqual(FOG_ALPHA);
    expect(FOG_ALPHA).toBe(0.62);
    expect(FOG_SOFT_STEPS).toBe(3);
  });

  it('gives open ground alpha 0 — there is no open-world fog', () => {
    expect(fogAlphaFor(K(99, 99), { fogged, depths })).toBe(0);
  });
});

describe('enemyVisibleInFog', () => {
  const fogged = new Set([K(0, 0)]);
  const hexKeyOf = () => K(0, 0);                   // every enemy below sits in the fogged hex
  const opts = (extra) => ({ fogged, hexKeyOf, ...extra });

  it('hides a ground enemy inside an unentered compound', () => {
    expect(enemyVisibleInFog({ x: 0, y: 0 }, opts())).toBe(false);
  });

  it('always shows an airborne enemy', () => {
    expect(enemyVisibleInFog({ x: 0, y: 0, flying: true }, opts())).toBe(true);
    // grounded flyer is still a ground unit
    expect(enemyVisibleInFog({ x: 0, y: 0, flying: true, airborne: false }, opts())).toBe(false);
  });

  it('always shows a wall turret — it reads from both sides of the ring', () => {
    expect(enemyVisibleInFog({ x: 0, y: 0, spanKey: 'e7' }, opts())).toBe(true);
  });

  it('shows anything outside the fogged set, i.e. the whole open world', () => {
    expect(enemyVisibleInFog({ x: 9e3, y: 9e3 }, opts({ hexKeyOf: () => K(50, 50) }))).toBe(true);
  });

  it('shows an awake enemy with a firing lane — if it can shoot him, he can see it', () => {
    expect(enemyVisibleInFog({ x: 0, y: 0 }, opts({ losClear: true, awake: true }))).toBe(true);
    expect(enemyVisibleInFog({ x: 0, y: 0 }, opts({ losClear: true, awake: false }))).toBe(false);
    expect(enemyVisibleInFog({ x: 0, y: 0 }, opts({ losClear: false, awake: true }))).toBe(false);
  });

  it('shows an enemy the breach peek reaches, and only that one', () => {
    const peekVisible = (x) => x === 100;
    expect(enemyVisibleInFog({ x: 100, y: 0 }, opts({ peekVisible }))).toBe(true);
    expect(enemyVisibleInFog({ x: 200, y: 0 }, opts({ peekVisible }))).toBe(false);
  });

  it('gates nothing before any fog exists', () => {
    expect(enemyVisibleInFog({ x: 0, y: 0 }, { fogged: null, hexKeyOf })).toBe(true);
    expect(enemyVisibleInFog({ x: 0, y: 0 }, { fogged: new Set(), hexKeyOf })).toBe(true);
  });
});

// The peek's defining property, and the thing v1 got wrong: what you see through a hole depends on
// WHERE YOU STAND. v1 unioned over all exterior angles, which lit nearly the whole yard from one
// breach. Here: a wall with a gap, and a target that is only visible from the right side of it.
describe('breach peek — position-dependent, by raycast', () => {
  // Two collinear wall spans on x-ish, with a gap between y=-20 and y=20.
  const wall = [
    { x0: 0, y0: -400, x1: 0, y1: -20 },
    { x0: 0, y0: 20, x1: 0, y1: 400 },
  ];
  const target = { x: 300, y: 0 };   // just inside, straight through the gap

  it('sees the target through the gap when lined up with it', () => {
    expect(pointVisibleFrom(-300, 0, target.x, target.y, wall)).toBe(true);
  });

  it('LOSES the target after moving along the wall — the peek swings with the player', () => {
    expect(pointVisibleFrom(-300, 300, target.x, target.y, wall)).toBe(false);
    expect(pointVisibleFrom(-300, -300, target.x, target.y, wall)).toBe(false);
  });

  it('reaches a DIFFERENT slice of the yard from each vantage point', () => {
    const yard = [];
    for (let y = -200; y <= 200; y += 10) yard.push({ x: 300, y });
    const seen = (px, py) => yard.filter((t) => pointVisibleFrom(px, py, t.x, t.y, wall)).length;
    const north = yard.filter((t) => pointVisibleFrom(-300, -200, t.x, t.y, wall)).map((t) => t.y);
    const south = yard.filter((t) => pointVisibleFrom(-300, 200, t.x, t.y, wall)).map((t) => t.y);
    expect(north.length).toBeGreaterThan(0);
    expect(south.length).toBeGreaterThan(0);
    expect(north).not.toEqual(south);
    // Standing north of the gap you see the SOUTHERN yard through it, and vice versa.
    expect(Math.max(...north)).toBeGreaterThan(Math.max(...south));
    // And a partial reveal is genuinely partial, from every vantage.
    for (const [px, py] of [[-300, -200], [-300, 0], [-300, 200]]) {
      expect(seen(px, py)).toBeLessThan(yard.length);
    }
  });

  it('sees nothing through an unbroken wall', () => {
    const solid = [{ x0: 0, y0: -400, x1: 0, y1: 400 }];
    expect(pointVisibleFrom(-300, 0, target.x, target.y, solid)).toBe(false);
  });
});
