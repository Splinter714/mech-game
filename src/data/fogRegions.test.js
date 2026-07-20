// #337 v2 — the compound-interior fog model. The v1 tests that lived here pinned the open-world
// block machinery (cell keys, cell centres, the 9-ring reveal disc, the all-angles breach union) and
// were deleted with it; nothing in the redesign has an open-world concept to test.
import { describe, it, expect } from 'vitest';
import {
  buildFogWorld, compoundAt, fogHexes, fogFrontier, fogAlphaFor, peekHexes, enemyVisibleInFog,
  FOG_ALPHA, FOG_FEATHER_PX, PEEK_RANGE_PX,
} from './fogRegions.js';
import { axialKey, hexToPixel, range } from './hexgrid.js';

// A compound centred on `c` with radius `rad` rings — the same shape worldgen hands over.
function base(id, c, rad) {
  return { id, footprint: range(c, rad) };
}
const K = (q, r) => axialKey(q, r);

describe('buildFogWorld', () => {
  const world = buildFogWorld([base('alpha', { q: 0, r: 0 }, 3)]);

  // v3 BUG FIX. v2 fogged `footprint minus outline` on the theory that the outline ring is "where
  // the walls sit". It isn't: walls are EDGE-owned (#288), `placeBaseWalls` puts a span on every
  // footprint/outside BOUNDARY, so the outline HEX is ground fully inside the wall. Excluding it is
  // what left "the first ring of hexes inside the wall" un-fogged. The fogged set is the whole
  // footprint now; the perimeter reads because it draws above the overlay (DEPTH.WALLS).
  it('fogs the WHOLE footprint, outline ring included — the first ring inside the wall is fog', () => {
    const fp = world.footprints.get('alpha');
    const out = world.outlines.get('alpha');
    const inner = world.interiors.get('alpha');
    expect(fp.size).toBe(37);                       // 3-ring hex
    expect(out.size).toBe(18);                      // the outermost ring — the hexes the walls line
    expect(inner.size).toBe(37);                    // …and it is fogged like everything else
    expect(inner.has(K(3, 0))).toBe(true);          // an outline hex: fogged, unlike v2
    expect(inner.has(K(2, 0))).toBe(true);          // the first ring INSIDE it: the reported bug
    expect(inner.has(K(0, 0))).toBe(true);
    for (const k of fp) expect(inner.has(k)).toBe(true);
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

  it('fogs whole compound footprints — and never the open world', () => {
    const fogged = fogHexes(world, new Set());
    expect(fogged.has(K(0, 0))).toBe(true);         // deep interior
    expect(fogged.has(K(3, 0))).toBe(true);         // v3: the outline ring is fogged too
    expect(fogged.has(K(2, 0))).toBe(true);         // the first ring inside the wall
    expect(fogged.has(K(15, 7))).toBe(false);       // open ground is NEVER fogged
    expect(fogged.size).toBe(37 * 2);
  });

  it('drops a compound permanently once entered, leaving the others alone', () => {
    const fogged = fogHexes(world, new Set(['alpha']));
    expect(fogged.has(K(0, 0))).toBe(false);
    expect(fogged.has(K(40, 0))).toBe(true);
    expect(fogged.size).toBe(37);
  });

  it('is empty when every compound has been entered', () => {
    expect(fogHexes(world, new Set(['alpha', 'beta'])).size).toBe(0);
  });
});

describe('fogFrontier / fogAlphaFor — flat fill, feathered edge', () => {
  const world = buildFogWorld([base('alpha', { q: 0, r: 0 }, 6)]);
  const fogged = fogHexes(world, new Set());
  const frontier = fogFrontier(fogged);

  it('marks exactly the fogged hexes touching something un-fogged', () => {
    expect(frontier.has(K(6, 0))).toBe(true);       // v3: the outline ring is now the frontier
    expect(frontier.has(K(5, 0))).toBe(false);      // one deeper: interior
    expect(frontier.has(K(0, 0))).toBe(false);
    for (const k of frontier) expect(fogged.has(k)).toBe(true);
  });

  it('fills every fogged hex at the same alpha — no ring tiering, and no lighter first ring', () => {
    const a = (q, r) => fogAlphaFor(K(q, r), { fogged });
    expect(a(7, 0)).toBe(0);                        // open ground outside the compound
    expect(a(6, 0)).toBe(FOG_ALPHA);                // the frontier is fully dark too
    expect(a(5, 0)).toBe(FOG_ALPHA);
    expect(a(0, 0)).toBe(FOG_ALPHA);
    for (const k of fogged) expect(fogAlphaFor(k, { fogged })).toBe(FOG_ALPHA);
  });

  // Jackson asked for "more stark" twice. v1 0.62 -> v2 0.92 -> v3 fully opaque, deliberately not a
  // third split-the-difference. Nothing inside an unentered compound reads through.
  it('is FULLY OPAQUE, with softness measured in pixels not rings', () => {
    expect(FOG_ALPHA).toBe(1);
    expect(FOG_FEATHER_PX).toBe(3);
  });

  it('cuts a peeked hex out of the fill entirely — that is how the reveal is drawn', () => {
    const peeked = new Set([K(6, 0)]);
    expect(fogAlphaFor(K(6, 0), { fogged, peeked })).toBe(0);
    expect(fogAlphaFor(K(5, 0), { fogged, peeked })).toBe(FOG_ALPHA);   // its neighbour stays black
  });

  it('gives open ground alpha 0 — there is no open-world fog', () => {
    expect(fogAlphaFor(K(99, 99), { fogged })).toBe(0);
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

// v3: the reveal is ONE HEX per nearby opening. Jackson, on v2's 900px visibility polygon: "the
// auto-reveal on breach/gate is a bit too generous; maybe we just reveal the one hex inside the
// breach or opening or something small like that". It must read as a peek through a hole, and it is
// still position-dependent — walking away from a hole closes it again.
describe('peekHexes — the one-hex breach/gate reveal', () => {
  const world = buildFogWorld([base('alpha', { q: 0, r: 0 }, 3)]);
  const fogged = fogHexes(world, new Set());
  // An opening on the compound's east flank: outline hex (3,0) ←→ open ground (4,0).
  const opening = { a: { q: 3, r: 0 }, b: { q: 4, r: 0 } };
  // …and a second one to the northeast, so "only the hole you're at" is testable.
  const far = { a: { q: 0, r: 3 }, b: { q: 0, r: 4 } };
  const outside = (q, r) => hexToPixel(q, r);

  it('reveals exactly the ONE hex behind the opening you are standing at', () => {
    const seen = peekHexes(fogged, [opening], outside(4, 0));
    expect([...seen]).toEqual([K(3, 0)]);           // one hex, not a slice of yard
  });

  it('reveals nothing once he steps away — the peek swings with the player', () => {
    expect(peekHexes(fogged, [opening], outside(9, 0)).size).toBe(0);
    expect(peekHexes(fogged, [opening], outside(4, -6)).size).toBe(0);
  });

  it('is directional: standing at one hole does not open the one across the compound', () => {
    const seen = peekHexes(fogged, [opening, far], outside(4, 0));
    expect(seen.has(K(3, 0))).toBe(true);
    expect(seen.has(K(0, 3))).toBe(false);
  });

  it('works from either orientation of the span — the caller never picks a side', () => {
    const flipped = { a: opening.b, b: opening.a };
    expect([...peekHexes(fogged, [flipped], outside(4, 0))]).toEqual([K(3, 0)]);
  });

  it('gives up nothing when the span has fog on neither side, or none at all', () => {
    // Wholly interior span: both hexes fogged, so there is no "outside" to peek from.
    expect(peekHexes(fogged, [{ a: { q: 0, r: 0 }, b: { q: 1, r: 0 } }], outside(0, 0)).size).toBe(0);
    // Wholly exterior span.
    expect(peekHexes(fogged, [{ a: { q: 9, r: 0 }, b: { q: 10, r: 0 } }], outside(9, 0)).size).toBe(0);
    expect(peekHexes(new Set(), [opening], outside(4, 0)).size).toBe(0);
    expect(peekHexes(fogged, [opening], null).size).toBe(0);
    expect(peekHexes(fogged, [], outside(4, 0)).size).toBe(0);
  });

  it('bounds the reveal to a walk-up-to-the-hole range, far smaller than v2 900px', () => {
    expect(PEEK_RANGE_PX).toBeLessThan(300);
    const p = hexToPixel(4, 0);
    expect(peekHexes(fogged, [opening], { x: p.x + PEEK_RANGE_PX - 1, y: p.y }).size).toBe(1);
    expect(peekHexes(fogged, [opening], { x: p.x + PEEK_RANGE_PX + 1, y: p.y }).size).toBe(0);
  });
});
